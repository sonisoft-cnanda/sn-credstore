import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../../src/config.js';
import { KNOWN_GOOD_VERSIONS } from '../../../src/shim/locateSdkCli.js';
import { assertPatchable, patchKeyChainModule, resetVaultForTesting } from '../../../src/shim/patch.js';
import { ensureSdkCliFixture } from '../../helpers/sdkCliFixture.js';

const REVIEWED_KEYCHAIN_SHA256 = '1de3ae85c2f856931d3528982a5a5419f9788b0053f77239c8a9a0f587d3e129';
const dirs: string[] = [];

beforeEach(() => resetVaultForTesting());
afterAll(async () => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

describe('published sdk-cli compatibility', () => {
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
