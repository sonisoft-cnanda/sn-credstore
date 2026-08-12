import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPatchable, KeyChainLike } from '../../../src/shim/patch.js';
import { ShimPreconditionError, isCredentialStoreError } from '../../../src/errors.js';

let dir: string;

/**
 * assertPatchable derives the version from the package.json four levels above
 * the keychain path, so a fixture only needs that file — no real module.
 */
async function keychainPathForVersion(version: string): Promise<string> {
    const root = join(dir, `sdk-cli-${version}`, '@servicenow', 'sdk-cli');
    await mkdir(join(root, 'dist', 'auth', 'keychain'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@servicenow/sdk-cli', version }));
    return join(root, 'dist', 'auth', 'keychain', 'index.js');
}

function goodKeyChain(): KeyChainLike {
    return {
        prototype: {
            getPassword: async () => null,
            setPassword: async () => {},
            deletePassword: async () => true,
        },
    };
}

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sncs-shim-'));
});

afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('assertPatchable version gate', () => {
    it.each(['4.9.0', '4.9.2', '4.10.1'])('accepts verified version %s', async (version) => {
        const path = await keychainPathForVersion(version);
        expect(() => assertPatchable(path, goodKeyChain())).not.toThrow();
    });

    it.each(['4.8.0', '5.0.0'])('refuses unverified version %s', async (version) => {
        const path = await keychainPathForVersion(version);
        let thrown: unknown;
        try {
            assertPatchable(path, goodKeyChain());
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeInstanceOf(ShimPreconditionError);
        if (!isCredentialStoreError(thrown)) throw new Error('unreachable');
        expect(thrown.remediation).toContain('KNOWN_GOOD_VERSIONS');
        expect(thrown.remediation).toContain('SN_CRED_STORE_DISABLE');
    });

    it('passes the version gate when no package.json is readable, but still checks shape', () => {
        const path = join(dir, 'nowhere', 'dist', 'auth', 'keychain', 'index.js');
        expect(() => assertPatchable(path, goodKeyChain())).not.toThrow();
        expect(() => assertPatchable(path, { prototype: {} })).toThrow(ShimPreconditionError);
    });
});

describe('assertPatchable shape check', () => {
    it.each(['getPassword', 'setPassword', 'deletePassword'] as const)(
        'refuses a keychain missing %s',
        async (method) => {
            const path = await keychainPathForVersion('4.10.1');
            const keychain = goodKeyChain();
            delete keychain.prototype[method];
            let thrown: unknown;
            try {
                assertPatchable(path, keychain);
            } catch (err) {
                thrown = err;
            }
            expect(thrown).toBeInstanceOf(ShimPreconditionError);
            expect((thrown as Error).message).toContain(method);
        },
    );

    it('refuses an export without a prototype', async () => {
        const path = await keychainPathForVersion('4.10.1');
        expect(() => assertPatchable(path, {} as KeyChainLike)).toThrow(ShimPreconditionError);
    });
});
