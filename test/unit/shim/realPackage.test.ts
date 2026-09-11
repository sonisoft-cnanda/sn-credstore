import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { loadConfig } from '../../../src/config.js';
import { KNOWN_GOOD_VERSIONS } from '../../../src/shim/locateSdkCli.js';
import { assertPatchable, patchKeyChainModule, resetVaultForTesting } from '../../../src/shim/patch.js';
import { ensureSdkCliFixture } from '../../helpers/sdkCliFixture.js';

const REVIEWED_KEYCHAIN_SHA256 = '1de3ae85c2f856931d3528982a5a5419f9788b0053f77239c8a9a0f587d3e129';
const dirs: string[] = [];
const execFileAsync = promisify(execFile);

beforeEach(() => resetVaultForTesting());
afterAll(async () => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

describe('published sdk-cli compatibility', () => {
    it('supports every fresh-process bootstrap order with the packed package', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'sncs-bootstrap-'));
        dirs.push(dir);
        const packDir = join(dir, 'pack');
        const consumerDir = join(dir, 'consumer');
        await mkdir(packDir);
        await mkdir(consumerDir);
        const packed = await execFileAsync('npm', ['pack', '--pack-destination', packDir], {
            cwd: resolve(process.cwd()),
            timeout: 120_000,
        });
        const tarball = join(packDir, packed.stdout.trim().split('\n').at(-1)!);
        const npmEnv = { ...process.env };
        // npm exports the user's global allow-scripts setting into npm-run
        // children. npm 11 rejects that option for a project-scoped install
        // even when --ignore-scripts is explicit, so keep the fixture isolated
        // from user configuration.
        delete npmEnv.npm_config_allow_scripts;
        await execFileAsync('npm', [
            'install', '--userconfig=/dev/null', '--ignore-scripts', '--no-audit', '--no-fund',
            '@servicenow/sdk-cli@4.12.0', tarball,
        ], { cwd: consumerDir, env: npmEnv, timeout: 120_000 });
        const nestedDir = join(consumerDir, 'nested');
        await mkdir(nestedDir);
        await execFileAsync('npm', [
            'install', '--userconfig=/dev/null', '--ignore-scripts', '--no-audit', '--no-fund',
            '@servicenow/sdk-cli@4.12.0',
        ], { cwd: nestedDir, env: npmEnv, timeout: 120_000 });

        const operationBody = `
            const expectedPath = process.env.SN_CRED_STORE_PATH;
            const api = await import('@sonisoft/sn-credstore');
            if ((await api.listAliases()).path !== expectedPath) throw new Error('sandbox path mismatch');
            const fabricated = {type:'basic',instanceUrl:'https://fixture.invalid',username:'fixture',password:'fabricated'};
            await auth.storeCredentials('first', fabricated, true);
            await auth.storeCredentials('second', fabricated, false);
            await auth.updateDefaultCredential('second');
            await auth.removeCredentials('first');
            const aliases = await api.listAliases();
            if (aliases.aliases.length !== 1 || aliases.aliases[0].alias !== 'second' || !aliases.aliases[0].isDefault) {
                throw new Error('fabricated operations did not persist safely');
            }
            process.stdout.write('verified');
        `;
        const authFirstBody = `
            const api = await import('@sonisoft/sn-credstore');
            if ((await api.listAliases()).path !== process.env.SN_CRED_STORE_PATH) throw new Error('sandbox path mismatch');
            if (await auth.getDefaultCredentials() !== undefined) throw new Error('expected an empty run-owned store');
            const fabricated = {type:'basic',instanceUrl:'https://fixture.invalid',username:'fixture',password:'fabricated'};
            const {createRequire} = await import('node:module');
            const current = createRequire(import.meta.url)('@servicenow/sdk-cli/dist/auth/index.js');
            await current.storeCredentials('blocked', fabricated, true);
            await current.storeCredentials('other', fabricated, false);
            for (const [name, operation] of [
                ['store', () => auth.storeCredentials('captured', fabricated, false)],
                ['default', () => auth.updateDefaultCredential('other')],
                ['remove', () => auth.removeCredentials('blocked')],
            ]) {
                try { await operation(); throw new Error('captured ' + name + ' mutation did not fail closed'); }
                catch (error) {
                    if (error.code !== 'SHIM_PRECONDITION_FAILED') throw error;
                }
            }
            await current.removeCredentials('blocked');
            await current.removeCredentials('other');
            await current.storeCredentials('first', fabricated, true);
            await current.storeCredentials('second', fabricated, false);
            await current.updateDefaultCredential('second');
            await current.removeCredentials('first');
            const aliases = await api.listAliases();
            if (aliases.aliases.length !== 1 || aliases.aliases[0].alias !== 'second' || !aliases.aliases[0].isDefault) {
                throw new Error('wrapped mutations did not persist safely');
            }
            process.stdout.write('verified');
        `;
        const scripts: Array<[string, string, string[]]> = [
            ['register-first.mjs', `import '@sonisoft/sn-credstore/register';\nimport * as auth from '@servicenow/sdk-cli/dist/auth/index.js';\n${operationBody}`, []],
            // Node snapshots named CommonJS exports before the later register
            // module can replace mutation functions in this order. Reads remain
            // safe through the patched prototype; captured mutations must fail
            // closed, while the current CommonJS exports remain transactional.
            ['auth-first.mjs', `import * as auth from '@servicenow/sdk-cli/dist/auth/index.js';\nimport '@sonisoft/sn-credstore/register';\n${authFirstBody}`, []],
            ['dynamic.mjs', `await import('@sonisoft/sn-credstore/register');\nconst auth = await import('@servicenow/sdk-cli/dist/auth/index.js');\n${operationBody}`, []],
            ['preload.cjs', `(async () => { const auth = require('@servicenow/sdk-cli/dist/auth/index.js');\n${operationBody} })().catch((error) => { console.error(error.message); process.exitCode = 1; });`, [
                '--require', join(consumerDir, 'node_modules', '@sonisoft', 'sn-credstore', 'preload.cjs'),
            ]],
            ['repeat-and-nested.cjs', `(async () => {
                const shim = require('@sonisoft/sn-credstore');
                shim.installKeyChainShim();
                shim.installKeyChainShim();
                const {createRequire} = require('node:module');
                const nestedRequire = createRequire(${JSON.stringify(join(nestedDir, 'entry.cjs'))});
                const auth = nestedRequire('@servicenow/sdk-cli/dist/auth/index.js');
                ${operationBody}
            })().catch((error) => { console.error(error.message); process.exitCode = 1; });`, []],
        ];

        for (const [name, source, nodeArgs] of scripts) {
            const script = join(consumerDir, name);
            const blobPath = join(dir, `${name}.credentials.json`);
            await writeFile(script, source);
            const env = { ...process.env, SN_CRED_STORE: 'file', SN_CRED_STORE_PATH: blobPath };
            // The SDK deliberately makes removeCredentials a no-op under test.
            // This is a fresh real-package integration process, not a mocked SDK
            // unit, so exercise the production branch.
            delete env.NODE_ENV;
            const result = await execFileAsync(process.execPath, [...nodeArgs, script], {
                cwd: consumerDir,
                env,
                timeout: 30_000,
            });
            expect(result.stdout.trimEnd().endsWith('verified')).toBe(true);
            expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/fabricated|refresh_token|access_token/i);
        }
    }, 300_000);

    it.each([...KNOWN_GOOD_VERSIONS])('patches the real published package %s', async (version) => {
        const fixture = await ensureSdkCliFixture(version);
        const pkg = JSON.parse(await readFile(join(fixture.packageRoot, 'package.json'), 'utf8')) as { version: string };
        expect(pkg.version).toBe(version);
        const seam = await readFile(fixture.keychainPath);
        expect(createHash('sha256').update(seam).digest('hex')).toBe(REVIEWED_KEYCHAIN_SHA256);

        const req = createRequire(join(fixture.base, 'fixture.cjs'));
        const mod = req(fixture.keychainPath) as { KeyChain: new () => KeyChainInstance };
        const keyring = req(fixture.keyringPath) as { getConstructionCount: () => number };
        expect(typeof mod.KeyChain).toBe('function');
        for (const method of ['getPassword', 'setPassword', 'deletePassword'] as const) {
            expect(typeof mod.KeyChain.prototype[method]).toBe('function');
        }

        const instance = new mod.KeyChain();
        await expect(instance.deletePassword()).resolves.toBe(false);
        const beforePatch = keyring.getConstructionCount();
        expect(beforePatch).toBeGreaterThanOrEqual(1);
        expect(() => assertPatchable(fixture.keychainPath, mod.KeyChain)).not.toThrow();

        const dir = await mkdtemp(join(tmpdir(), `sncs-real-${version}-`));
        dirs.push(dir);
        const blobPath = join(dir, 'credentials.json');
        const oneAlias = JSON.stringify({
            fixturealias: {
                isDefault: true,
                alias: 'fixturealias',
                creds: {
                    instanceUrl: 'https://fixture.invalid',
                    type: 'basic',
                    username: 'fixture',
                    password: 'fabricated',
                },
            },
        });
        await writeFile(blobPath, oneAlias, { mode: 0o600 });
        expect(patchKeyChainModule(fixture.keychainPath, mod, { ...loadConfig(), store: 'file', disabled: false, blobPath })).toBe(true);
        expect(JSON.parse((await instance.getPassword()) ?? '{}')).toHaveProperty('fixturealias');
        const twoAliases = JSON.stringify({
            ...JSON.parse(oneAlias),
            secondfixture: {
                isDefault: false,
                alias: 'secondfixture',
                creds: {
                    instanceUrl: 'https://second.invalid',
                    type: 'basic',
                    username: 'fixture',
                    password: 'fabricated',
                },
            },
        });
        await instance.setPassword(twoAliases);
        expect(JSON.parse(await readFile(blobPath, 'utf8'))).toHaveProperty('secondfixture');
        expect((await stat(blobPath)).mode & 0o777).toBe(0o600);
        expect(await instance.deletePassword()).toBe(true);
        await expect(access(blobPath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(keyring.getConstructionCount()).toBe(beforePatch);
    }, 120_000);
});

interface KeyChainInstance {
    getPassword(): Promise<string | null>;
    setPassword(password: string): Promise<void>;
    deletePassword(): Promise<boolean>;
}
