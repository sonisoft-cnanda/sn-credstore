import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ensureSdkCliFixture } from '../../helpers/sdkCliFixture.js';
import { KNOWN_GOOD_VERSIONS } from '../../../src/shim/locateSdkCli.js';
import { patchKeyChainModule, patchSdkOperationModule, resetVaultForTesting } from '../../../src/shim/patch.js';
import { loadConfig } from '../../../src/config.js';
import { listAliases } from '../../../src/api.js';
import { KeyStore, OAuthCred, StoredCredential } from '../../../src/types.js';

const directories: string[] = [];
beforeEach(resetVaultForTesting);
afterAll(async () => { await Promise.all(directories.map(path => rm(path, { recursive: true, force: true }))); });

function evaluate(source: string, dependencies: Record<string, unknown>): Record<string, unknown> {
    const exports: Record<string, unknown> = {};
    runInNewContext(source, { exports, process, URL, URLSearchParams, Date, Error,
        require: (name: string): unknown => {
            if (!(name in dependencies)) throw new Error(`Unexpected SDK dependency: ${name}`);
            return dependencies[name];
        },
    });
    return exports;
}

function credential(alias: string, remaining: number, isDefault = false): StoredCredential {
    return { alias, isDefault, creds: { type: 'oauth', instanceUrl: 'https://fixture.invalid',
        access_token: `fabricated-access-${alias}`, refresh_token: `fabricated-refresh-${alias}`,
        expires_at: Math.floor(Date.now() / 1000) + remaining, token_type: 'Bearer' } };
}

describe('reviewed SDK refresh boundary', () => {
    it.each([...KNOWN_GOOD_VERSIONS])('preserves auth semantics in published SDK %s', async version => {
        const fixture = await ensureSdkCliFixture(version);
        const directory = await mkdtemp(join(tmpdir(), 'sn-refresh-boundary-'));
        directories.push(directory);
        const blobPath = join(directory, 'credentials.json');
        const config = { ...loadConfig(), store: 'file' as const, blobPath, lockTimeoutMs: 1000, disabled: false };
        expect((await listAliases(config)).path).toBe(blobPath);
        const req = createRequire(join(fixture.base, 'fixture.cjs'));
        const keychain: unknown = req(fixture.keychainPath);
        const authPath = join(fixture.packageRoot, 'dist/auth/index.js');
        const oauthPath = join(fixture.packageRoot, 'dist/auth/OAuth/index.js');
        const authSource = await readFile(authPath, 'utf8');
        const oauthSource = await readFile(oauthPath, 'utf8');
        expect(createHash('sha256').update(authSource).digest('hex')).toBe('b30fa90d9b440818499699249f5585fb143ec273665a80a008e4996c94ae58b1');
        expect(['1a8a9623bff7cb3ad0bc76b00c7394b1386d3dd31ac00101916df33dd24da39f',
            'ee0c69264c990395f32d1e3206e5c5e0202d8d85207dd8db08d779748caf35bd'])
            .toContain(createHash('sha256').update(oauthSource).digest('hex'));
        let refreshes = 0;
        let failRefresh = false;
        const logger = { info: (): void => {}, error: (): void => {} };
        const oauth = evaluate(oauthSource, { '../../logger': { logger }, './CodeGrant': {
            oAuthClient: async () => ({ refresh: async () => {
                refreshes++;
                if (failRefresh) throw new Error('fixture unavailable');
                return { access_token: 'fabricated-renewed', refresh_token: 'fabricated-rotated',
                    expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'Bearer' };
            } }),
        } });
        const auth = evaluate(authSource, { '../logger': { logger }, './keychain': keychain,
            '@servicenow/sdk-api': { LazyCredential: class {} }, './OAuth': oauth,
            './OAuth/ClientCredentials': {}, './basic-auth': {}, 'tough-cookie': {} });
        // Capture before patching: core's ESM import can already hold this function.
        const getCredentials = auth.getCredentials as (alias?: string) => Promise<OAuthCred>;
        patchKeyChainModule(fixture.keychainPath, keychain, config);
        expect(patchSdkOperationModule(oauthPath, oauth, config)).toBe(true);
        expect(patchSdkOperationModule(authPath, auth, config)).toBe(true);
        const add = auth.storeCredentials as (alias: string, creds: OAuthCred, isDefault: boolean) => Promise<void>;
        const seed = async (remaining: number): Promise<void> => {
            await writeFile(blobPath, JSON.stringify({ selected: credential('selected', remaining, true), unused: credential('unused', -100) }), { mode: 0o600 });
        };
        await seed(950);
        expect((await getCredentials('selected')).expires_at).toBeGreaterThan(Date.now() / 1000 + 900);
        expect(refreshes).toBe(0);
        expect((await readdir(directory)).some(name => name.endsWith('.lock'))).toBe(false);
        await seed(-1);
        const before = JSON.parse(await readFile(blobPath, 'utf8')) as KeyStore;
        const result = await getCredentials('selected');
        expect(result.refresh_token).toBe('fabricated-rotated');
        expect(refreshes).toBe(1);
        const stored = JSON.parse(await readFile(blobPath, 'utf8')) as KeyStore;
        expect(stored.selected!.creds).toEqual(result);
        expect(stored.unused!.creds).toEqual(before.unused!.creds);
        await getCredentials('selected');
        expect(refreshes).toBe(1);
        await add('added', credential('added', 9999).creds as OAuthCred, false);
        expect(Object.keys(JSON.parse(await readFile(blobPath, 'utf8')))).toHaveLength(3);
        await seed(-1);
        failRefresh = true;
        await expect(getCredentials('selected')).rejects.toThrow('Error refreshing token');
        expect((await readdir(directory)).some(name => name.endsWith('.lock'))).toBe(false);
        await writeFile(blobPath, 'corrupt fixture', { mode: 0o600 });
        await expect(getCredentials('selected')).rejects.toMatchObject({ code: 'STORE_CORRUPT' });
        expect((await readFile(blobPath, 'utf8'))).toBe('corrupt fixture');
    }, 120000);
});
