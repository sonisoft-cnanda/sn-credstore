import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { applyCredentialChanges, CredentialChange, listAliases, readCredentialSnapshot, vaultFor } from '../../../src/api.js';
import { loadConfig, ResolvedConfig } from '../../../src/config.js';
import { Creds, KeyStore, OAuthCred } from '../../../src/types.js';
import { CredentialConflictError } from '../../../src/errors.js';
import { FileStore } from '../../../src/store/FileStore.js';
import { CredentialVault } from '../../../src/vault/CredentialVault.js';
import { acquireLock } from '../../../src/lock/FileLock.js';

let directory: string;
let config: ResolvedConfig;
let previousPath: string | undefined;
let previousStore: string | undefined;
const basic = (password = 'fabricated-password'): Creds => ({ type: 'basic', instanceUrl: 'https://example.invalid', username: 'fixture', password });
const oauth = (remaining: number, token = 'fabricated-access'): OAuthCred => ({ type: 'oauth', instanceUrl: 'https://example.invalid', access_token: token,
    refresh_token: 'fabricated-refresh', token_type: 'Bearer', expires_at: Math.floor(Date.now() / 1000) + remaining });

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sn-transfer-'));
    previousPath = process.env.SN_CRED_STORE_PATH;
    previousStore = process.env.SN_CRED_STORE;
    process.env.SN_CRED_STORE_PATH = join(directory, 'credentials.json');
    process.env.SN_CRED_STORE = 'file';
    config = loadConfig();
    expect(config.blobPath).toBe(join(directory, 'credentials.json'));
    expect((await listAliases(config)).path).toBe(config.blobPath);
});

afterEach(async () => {
    if (previousPath === undefined) delete process.env.SN_CRED_STORE_PATH;
    else process.env.SN_CRED_STORE_PATH = previousPath;
    if (previousStore === undefined) delete process.env.SN_CRED_STORE;
    else process.env.SN_CRED_STORE = previousStore;
    await rm(directory, { recursive: true, force: true });
});

async function seed(creds: Creds = basic()): Promise<void> {
    await writeFile(config.blobPath, JSON.stringify({ selected: { alias: 'selected', isDefault: true, creds },
        survivor: { alias: 'survivor', isDefault: false, creds: basic() } }), { mode: 0o600 });
}

function cli(input: unknown, args: string[] = []): Promise<number | null> {
    return new Promise((resolve, reject) => {
        const source = `
            const {loadConfig,listAliases}=require('./dist/cjs/index.js');
            (async()=>{
                const config=loadConfig();
                if(config.blobPath!==process.env.SN_TEST_EXPECTED_STORE||(await listAliases(config)).path!==config.blobPath)throw new Error('Unsafe fixture store path');
                await import(require('node:url').pathToFileURL(process.argv[1]).href);
            })().catch(()=>{process.exitCode=1});
        `;
        const child = spawn(process.execPath, ['-e', source, 'bin/sn-credstore.js', 'import', '--stdin', ...args], {
            cwd: process.cwd(), env: { ...process.env, SN_TEST_EXPECTED_STORE: config.blobPath }, stdio: ['pipe', 'ignore', 'ignore'],
        });
        child.once('error', () => reject(new Error('Fixture CLI could not start.')));
        child.once('close', resolve);
        child.stdin!.end(JSON.stringify(input));
    });
}

describe('credential transfer', () => {
    it('returns secret-bearing independent snapshots and leaves new aliases non-default', async () => {
        await seed();
        const snapshot = await readCredentialSnapshot();
        if (snapshot.selected!.creds.type !== 'basic') throw new Error('fixture mismatch');
        snapshot.selected!.creds.password = 'changed-copy';
        expect((await readCredentialSnapshot()).selected!.creds).toEqual(basic());
        await applyCredentialChanges([{ alias: 'added', expected: null, creds: basic() }]);
        const result = await readCredentialSnapshot();
        expect(result.selected!.isDefault).toBe(true);
        expect(result.added!.isDefault).toBe(false);
        expect(result.survivor!.creds).toEqual(basic());
    });

    it('preserves an empty store default selection', async () => {
        await applyCredentialChanges([{ alias: 'added', expected: null, creds: basic() }]);
        expect((await readCredentialSnapshot()).added!.isDefault).toBe(false);
    });

    it('refuses pending recovery without mutating the store or sidecar', async () => {
        await seed();
        const before = await readFile(config.blobPath, 'utf8');
        const pendingPath = config.blobPath + '.pending-fixture';
        const pending = JSON.stringify({ added: { alias: 'added', isDefault: false, creds: basic() } });
        await writeFile(pendingPath, pending, { mode: 0o600 });
        await expect(readCredentialSnapshot()).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
        expect(await readFile(config.blobPath, 'utf8')).toBe(before);
        expect(await readFile(pendingPath, 'utf8')).toBe(pending);
        expect((await readdir(directory)).some(name => name.endsWith('.lock'))).toBe(false);
    });

    it.each(['matching', 'conflicting', 'empty', 'import'])('refuses pending recovery for %s transfer without any blob or sidecar changes', async operation => {
        await seed();
        const before = await readFile(config.blobPath, 'utf8');
        const pendingPath = config.blobPath + '.pending-fixture';
        const pending = JSON.stringify({ added: { alias: 'added', isDefault: false, creds: basic() } });
        await writeFile(pendingPath, pending, { mode: 0o600 });
        if (operation === 'import') {
            expect(await cli({ imported: { alias: 'imported', isDefault: true, creds: basic() } }, ['--overwrite'])).toBe(1);
        } else {
            const changes = operation === 'empty' ? [] : [{ alias: 'selected', expected: basic(operation === 'conflicting' ? 'fabricated-stale' : undefined), creds: oauth(3600) }];
            await expect(applyCredentialChanges(changes)).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
        }
        expect(await readFile(config.blobPath, 'utf8')).toBe(before);
        expect(await readFile(pendingPath, 'utf8')).toBe(pending);
        expect((await readdir(directory)).filter(name => name.includes('.pending-'))).toEqual(['credentials.json.pending-fixture']);
    });

    it('replaces a different OAuth grant even when expiry decreases', async () => {
        const old = oauth(7200);
        await seed(old);
        const replacement = { ...oauth(3600, 'fabricated-new-access'), refresh_token: 'fabricated-new-refresh' };
        await applyCredentialChanges([{ alias: 'selected', expected: old, creds: replacement }]);
        expect((await readCredentialSnapshot()).selected!.creds).toEqual(replacement);
    });

    it('checks every credential field independent of key order and metadata', async () => {
        const old = oauth(7200);
        await seed(old);
        const reversed = Object.fromEntries(Object.entries(old).reverse()) as unknown as Creds;
        await applyCredentialChanges([{ alias: 'selected', expected: reversed, creds: basic() }]);
        expect((await readCredentialSnapshot()).selected!.isDefault).toBe(true);
        const stale = { ...basic(), instanceUrl: 'https://changed.invalid' };
        await expect(applyCredentialChanges([{ alias: 'selected', expected: stale, creds: old }])).rejects.toBeInstanceOf(CredentialConflictError);
    });

    it('rejects conflicts atomically with aliases only', async () => {
        await seed();
        const before = await readFile(config.blobPath, 'utf8');
        let error: unknown;
        try { await applyCredentialChanges([{ alias: 'added', expected: null, creds: basic() },
            { alias: 'selected', expected: basic('fabricated-stale-secret'), creds: basic('fabricated-new-secret') }]); }
        catch (caught) { error = caught; }
        expect(error).toMatchObject({ code: 'CREDENTIAL_CONFLICT', aliases: ['selected'] });
        expect(String(error)).not.toMatch(/fabricated|password|refresh_token/);
        expect(await readFile(config.blobPath, 'utf8')).toBe(before);
        await expect(applyCredentialChanges([{ alias: 'selected', expected: null, creds: basic() }])).rejects.toMatchObject({ code: 'CREDENTIAL_CONFLICT' });
        await expect(applyCredentialChanges([{ alias: 'absent', expected: basic(), creds: basic() }])).rejects.toMatchObject({ code: 'CREDENTIAL_CONFLICT' });
    });

    it.each(['type', 'instanceUrl', 'access_token', 'refresh_token', 'token_type', 'expires_at'])('rechecks OAuth field %s before writing', async field => {
        const original = oauth(3600);
        await seed(original);
        const expected = field === 'type' ? basic() : { ...original, [field]: field === 'expires_at' ? original.expires_at + 1 : 'fabricated-different' };
        const before = await readFile(config.blobPath, 'utf8');
        await expect(applyCredentialChanges([{ alias: 'selected', expected, creds: basic() }])).rejects.toMatchObject({ code: 'CREDENTIAL_CONFLICT' });
        expect(await readFile(config.blobPath, 'utf8')).toBe(before);
    });

    it('copies caller inputs before waiting for the lock', async () => {
        await seed();
        const lock = await acquireLock(config.blobPath + '.lock');
        const changes: CredentialChange[] = [{ alias: 'selected', expected: basic(), creds: basic('fabricated-original-input') }];
        const applying = applyCredentialChanges(changes);
        (changes[0]!.creds as { password: string }).password = 'fabricated-mutated-input';
        changes[0]!.expected = null;
        await lock.release();
        await applying;
        expect((await readCredentialSnapshot()).selected!.creds).toEqual(basic('fabricated-original-input'));
    });

    it('allows exactly one overlapping changeset and preserves all-or-none for the loser', async () => {
        await seed();
        const replacements = [basic('fabricated-first'), basic('fabricated-second')];
        const attempts = await Promise.allSettled(replacements.map((creds, index) => applyCredentialChanges([
            { alias: 'selected', expected: basic(), creds }, { alias: 'added-' + index, expected: null, creds: basic() },
        ])));
        expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(1);
        const winner = attempts.findIndex(attempt => attempt.status === 'fulfilled');
        const loser = attempts[1 - winner]!;
        if (loser.status !== 'rejected') throw new Error('Fixture conflict missing');
        expect(loser.reason).toBeInstanceOf(CredentialConflictError);
        const snapshot = await readCredentialSnapshot();
        expect(snapshot.selected!.creds).toEqual(replacements[winner]);
        expect(Object.hasOwn(snapshot, 'added-' + winner)).toBe(true);
        expect(Object.hasOwn(snapshot, 'added-' + (1 - winner))).toBe(false);
        expect(snapshot.selected!.isDefault).toBe(true);
        expect(snapshot.survivor!.creds).toEqual(basic());
    });

    it.each(['failure', 'dropped'])('propagates a %s transfer write without a deferred sidecar', async behavior => {
        await seed();
        const before = await readFile(config.blobPath, 'utf8');
        const store = new FileStore(config.blobPath);
        const vault = new CredentialVault({
            id: 'file', writable: true, read: () => store.read(), delete: () => store.delete(),
            isAvailable: async () => true, describe: () => 'fixture',
            write: async () => {
                if (behavior === 'failure') throw new Error('Fabricated backend failure.');
                return 'fabricated-version';
            },
        }, { blobPath: config.blobPath });
        await expect(vault.applyCredentialChanges([{ alias: 'selected', expected: basic(), creds: oauth(3600) }])).rejects.toThrow();
        expect(await readFile(config.blobPath, 'utf8')).toBe(before);
        expect((await readdir(directory)).some(name => name.includes('.pending-'))).toBe(false);
    });

    it('reports uncertain verification after a committed write and requires a fresh snapshot', async () => {
        await seed();
        const store = new FileStore(config.blobPath);
        let committed = false;
        const vault = new CredentialVault({
            id: 'file', writable: true, isAvailable: async () => true, describe: () => 'fixture', delete: () => store.delete(),
            read: async () => {
                if (committed) throw new Error('Fabricated verification read failure.');
                return store.read();
            },
            write: async (blob, version) => {
                const result = await store.write(blob, version);
                committed = true;
                return result;
            },
        }, { blobPath: config.blobPath });
        const replacement = oauth(3600);
        await expect(vault.applyCredentialChanges([{ alias: 'selected', expected: basic(), creds: replacement }])).rejects.toMatchObject({
            code: 'STORE_UNAVAILABLE', remediation: expect.stringContaining('fresh credential snapshot'),
        });
        expect((await readCredentialSnapshot()).selected!.creds).toEqual(replacement);
        await expect(applyCredentialChanges([{ alias: 'selected', expected: basic(), creds: replacement }])).rejects.toMatchObject({ code: 'CREDENTIAL_CONFLICT' });
        expect((await readdir(directory)).some(name => name.includes('.pending-'))).toBe(false);
    });

    it.each([
        [{ alias: '__proto__', expected: null, creds: basic() }],
        [{ alias: 'constructor', expected: null, creds: basic() }],
        [{ alias: 'prototype', expected: null, creds: basic() }],
        [{ alias: 'added', expected: null, creds: { ...basic(), extra: 'fabricated-extra' } }],
        [{ alias: 'added', expected: null, creds: { ...oauth(3600), expires_at: Date.now() } }],
        [{ alias: 'added', expected: null, creds: { type: 'basic' } }],
        [{ alias: 'added', expected: null, creds: basic() }, { alias: 'added', expected: null, creds: basic() }],
    ])('rejects malformed input without writes', async changes => {
        await seed();
        const before = await readFile(config.blobPath, 'utf8');
        const files = await readdir(directory);
        await expect(applyCredentialChanges(changes as unknown as Parameters<typeof applyCredentialChanges>[0])).rejects.toMatchObject({ code: 'STORE_CORRUPT' });
        expect(await readFile(config.blobPath, 'utf8')).toBe(before);
        expect(await readdir(directory)).toEqual(files);
        expect(Object.prototype).not.toHaveProperty('creds');
    });

    it('rejects getters without evaluating them', async () => {
        let evaluated = false;
        const malformed = { type: 'basic', instanceUrl: 'https://example.invalid', username: 'fixture', get password() { evaluated = true; return 'fabricated'; } };
        await expect(applyCredentialChanges([{ alias: 'added', expected: null, creds: malformed }])).rejects.toMatchObject({ code: 'STORE_CORRUPT' });
        expect(evaluated).toBe(false);
        expect(await readdir(directory)).toEqual([]);
    });

    it('rejects sparse and accessor change arrays without writes', async () => {
        const sparse = new Array<CredentialChange>(1);
        await expect(applyCredentialChanges(sparse)).rejects.toMatchObject({ code: 'STORE_CORRUPT' });
        let evaluated = false;
        const accessor = Object.defineProperty([], '0', { enumerable: true, get: () => { evaluated = true; return null; } });
        await expect(applyCredentialChanges(accessor)).rejects.toMatchObject({ code: 'STORE_CORRUPT' });
        expect(evaluated).toBe(false);
        expect(await readdir(directory)).toEqual([]);
    });

    it.each([
        { wrong: { alias: 'other', isDefault: true, creds: basic() } },
        JSON.parse('{"__proto__":{"alias":"__proto__","isDefault":false,"creds":{"type":"basic","instanceUrl":"https://example.invalid","username":"fixture","password":"fabricated"}}}'),
        { wrong: { alias: 'wrong', isDefault: true, creds: { type: 'oauth', access_token: 'fabricated-secret' } } },
        { version: 1, ciphertext: 'fabricated-envelope' },
    ])('rejects malformed snapshots and file/backend mismatches without replacing source', async source => {
        await writeFile(config.blobPath, JSON.stringify(source), { mode: 0o600 });
        const before = await readFile(config.blobPath, 'utf8');
        await expect(readCredentialSnapshot()).rejects.toMatchObject({ code: 'STORE_CORRUPT' });
        await expect(applyCredentialChanges([{ alias: 'added', expected: null, creds: basic() }])).rejects.toMatchObject({ code: 'STORE_CORRUPT' });
        expect(await readFile(config.blobPath, 'utf8')).toBe(before);
    });

    it('rejects a plaintext blob selected as encrypted before invoking decrypt', async () => {
        await seed();
        const before = await readFile(config.blobPath, 'utf8');
        await expect(readCredentialSnapshot({ ...config, store: 'systemd-creds' })).rejects.toMatchObject({ code: 'STORE_DECRYPT_FAILED' });
        expect(await readFile(config.blobPath, 'utf8')).toBe(before);
    });

    it('imports exact grants under lock while preserving local defaults', async () => {
        const old = oauth(7200);
        await seed(old);
        const incoming = { selected: { alias: 'selected', isDefault: false, creds: oauth(3600, 'fabricated-new') },
            added: { alias: 'added', isDefault: true, creds: basic() } };
        expect(await cli(incoming, ['--overwrite'])).toBe(0);
        const result = await readCredentialSnapshot();
        expect(result.selected!.creds).toEqual(incoming.selected.creds);
        expect(result.selected!.isDefault).toBe(true);
        expect(result.added!.isDefault).toBe(false);
        expect(result.survivor!.creds).toEqual(basic());
    });

    it('rejects malformed imports without writes and retains first-import default', async () => {
        expect(await cli({ bad: { alias: 'bad', isDefault: true, creds: { type: 'basic' } } })).toBe(1);
        expect(await readdir(directory)).toEqual([]);
        expect(await cli({ added: { alias: 'added', isDefault: true, creds: basic() } })).toBe(0);
        expect((await readCredentialSnapshot()).added!.isDefault).toBe(true);
    });

    it('imports the first default in its only write and retries cleanly after a failed write', async () => {
        const store = new FileStore(config.blobPath);
        const source = { first: { alias: 'first', isDefault: false, creds: basic() }, second: { alias: 'second', isDefault: true, creds: basic() } };
        let fail = true;
        let writes = 0;
        const vault = new CredentialVault({
            id: 'file', writable: true, isAvailable: async () => true, describe: () => 'fixture', read: () => store.read(), delete: () => store.delete(),
            write: async (blob, version) => {
                writes++;
                const incoming = JSON.parse(blob) as KeyStore;
                expect(incoming.first!.isDefault).toBe(false);
                expect(incoming.second!.isDefault).toBe(true);
                if (fail) throw new Error('Fabricated first import failure.');
                return store.write(blob, version);
            },
        }, { blobPath: config.blobPath });
        await expect(vault.importCredentialSnapshot(source)).rejects.toThrow('Fabricated first import failure.');
        expect((await store.read()).blob).toBeNull();
        expect((await readdir(directory)).some(name => name.includes('.pending-'))).toBe(false);
        fail = false;
        expect((await vault.importCredentialSnapshot(source)).imported).toBe(2);
        expect(writes).toBe(2);
        expect((await readCredentialSnapshot()).second!.isDefault).toBe(true);
    });

    it('selects the first alias on first CLI import when the source has no default', async () => {
        expect(await cli({ first: { alias: 'first', isDefault: false, creds: basic() }, second: { alias: 'second', isDefault: false, creds: basic() } })).toBe(0);
        const snapshot = await readCredentialSnapshot();
        expect(snapshot.first!.isDefault).toBe(true);
        expect(snapshot.second!.isDefault).toBe(false);
    });

    it.each([undefined, 'fabricated-rotated'])('retains omitted refresh tokens and persists supplied replacements', async replacement => {
        const old = oauth(-1);
        await seed(old);
        const vault = vaultFor(config);
        const store = JSON.parse((await vault.getPassword())!) as KeyStore;
        const creds = store.selected!.creds as OAuthCred;
        await vault.refreshCredentials(creds, async () => ({ access_token: 'fabricated-renewed', token_type: 'Bearer', expires_at: oauth(3600).expires_at, refresh_token: replacement }));
        expect((await readCredentialSnapshot()).selected!.creds).toEqual({ ...creds, refresh_token: replacement ?? old.refresh_token });
    });
});
