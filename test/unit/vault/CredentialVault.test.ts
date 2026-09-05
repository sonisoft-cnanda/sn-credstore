import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialVault } from '../../../src/vault/CredentialVault.js';
import { FileStore } from '../../../src/store/FileStore.js';
import type { ICredentialStore, StoreReadResult } from '../../../src/store/ICredentialStore.js';
import type { KeyStore, StoredCredential } from '../../../src/types.js';

function oauth(alias: string, expiresInSec: number, token = 'AT'): StoredCredential {
    return {
        isDefault: true,
        alias,
        creds: {
            instanceUrl: `https://${alias}.service-now.com`,
            type: 'oauth',
            access_token: token,
            token_type: 'Bearer',
            refresh_token: `RT-${token}`,
            expires_at: Math.floor(Date.now() / 1000) + expiresInSec,
        },
    };
}

function blobOf(...entries: StoredCredential[]): string {
    return JSON.stringify(Object.fromEntries(entries.map((e) => [e.alias, e])) as KeyStore);
}

let dir: string;
let blobPath: string;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sncs-vault-'));
    blobPath = join(dir, 'credentials.json');
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

function makeVault(store?: ICredentialStore): CredentialVault {
    return new CredentialVault(store ?? new FileStore(blobPath), { blobPath, lockTimeoutMs: 3000 });
}

describe('getPassword — null means empty only', () => {
    it('returns null for a genuinely empty store', async () => {
        expect(await makeVault().getPassword()).toBeNull();
    });

    it('propagates backend failures', async () => {
        const failing: ICredentialStore = {
            id: 'file',
            writable: true,
            isAvailable: async () => true,
            read: async (): Promise<StoreReadResult> => {
                throw new Error('backend exploded');
            },
            write: async () => 'v1',
            delete: async () => false,
            describe: () => 'failing',
        };
        await expect(makeVault(failing).getPassword()).rejects.toThrow('backend exploded');
    });

    it('refuses a corrupt blob and preserves a copy', async () => {
        // Returning it would make the SDK's own JSON.parse throw from deep in
        // its auth path, which is far harder to diagnose.
        const store = new FileStore(blobPath);
        await store.write('{not json at all');

        await expect(makeVault(store).getPassword()).rejects.toMatchObject({ code: 'STORE_CORRUPT' });
        expect((await readdir(dir)).some((f) => f.includes('.corrupt.'))).toBe(true);
    });
});

describe('setPassword — the store-wipe guard', () => {
    it('refuses a write that would drop aliases without an explicit delete', async () => {
        const store = new FileStore(blobPath);
        await store.write(blobOf(oauth('a', 9999), oauth('b', 9999)));

        const vault = makeVault(store);
        await vault.getPassword(); // establishes the baseline

        // Simulates the SDK seeding from `{}` after a failed read.
        await vault.setPassword('{}');

        const after = JSON.parse((await store.read()).blob!);
        expect(Object.keys(after).sort()).toEqual(['a', 'b']);
    });

    it('refuses to persist an expires_at in milliseconds', async () => {
        // types.ts has always documented this hazard but nothing enforced it: ms
        // makes the SDK's refresh condition permanently false, so the token is never
        // refreshed and every agent gets silent 401s once it really expires.
        const store = new FileStore(blobPath);
        await store.write(blobOf(oauth('a', 9999)));

        const vault = makeVault(store);
        await vault.getPassword();

        const bad = oauth('a', 0);
        (bad.creds as { expires_at: number }).expires_at = Date.now(); // ms, not seconds
        await vault.setPassword(blobOf(bad));

        // The good credential is still there, untouched.
        const after = JSON.parse((await store.read()).blob!) as KeyStore;
        expect((after.a.creds as { expires_at: number }).expires_at).toBeLessThan(100_000_000_000);
    });

    it('does not leave a sidecar behind when it refuses a malformed write', async () => {
        // Refusing must not go through the throw path — setPassword turns a throw
        // into a pending sidecar, which the next read merges back in, so the
        // rejected credential would simply arrive later.
        const store = new FileStore(blobPath);
        await store.write(blobOf(oauth('a', 9999)));

        const vault = makeVault(store);
        await vault.getPassword();

        const bad = oauth('a', 0);
        (bad.creds as { expires_at: number }).expires_at = Date.now();
        await vault.setPassword(blobOf(bad));

        const sidecars = (await readdir(dir)).filter((f) => f.includes('pending'));
        expect(sidecars).toEqual([]);
    });

    it('still persists a well-formed credential', async () => {
        const store = new FileStore(blobPath);
        await store.write(blobOf(oauth('a', 9999)));

        const vault = makeVault(store);
        await vault.getPassword();
        // Later expires_at, as a real rotation produces. mergeKeyStores resolves a
        // same-alias conflict by picking the newer token, so an identical expiry
        // would legitimately keep the existing one.
        await vault.setPassword(blobOf(oauth('a', 19_999, 'ROTATED')));

        const after = JSON.parse((await store.read()).blob!) as KeyStore;
        expect((after.a.creds as { access_token: string }).access_token).toBe('ROTATED');
    });

    it('allows removals when intent is declared', async () => {
        const store = new FileStore(blobPath);
        await store.write(blobOf(oauth('a', 9999), oauth('b', 9999)));

        const vault = makeVault(store);
        await vault.getPassword();
        await vault.withRemovalIntent(async () => {
            await vault.setPassword(blobOf(oauth('a', 9999)));
        });

        expect(Object.keys(JSON.parse((await store.read()).blob!))).toEqual(['a']);
    });

    it('never throws when every write fails, and leaves a recoverable sidecar', async () => {
        // Swallowing silently would permanently lose a rotated refresh token —
        // the old one is already dead server-side.
        const store: ICredentialStore = {
            id: 'file',
            writable: true,
            isAvailable: async () => true,
            read: async () => ({ blob: null, version: null }),
            write: async () => {
                throw new Error('disk full');
            },
            delete: async () => false,
            describe: () => 'always-fails',
        };

        const vault = makeVault(store);
        await expect(vault.setPassword(blobOf(oauth('a', 9999)))).resolves.toBeUndefined();
        expect((await readdir(dir)).some((f) => f.includes('.pending-'))).toBe(true);
    });

    it('merges a pending sidecar back in on the next read', async () => {
        const store = new FileStore(blobPath);
        await store.write(blobOf(oauth('a', 9999)));
        const { writeFileAtomic } = await import('../../../src/store/atomicFile.js');
        await writeFileAtomic(`${blobPath}.pending-123`, blobOf(oauth('b', 9999)));

        const blob = await makeVault(store).getPassword();

        expect(Object.keys(JSON.parse(blob!)).sort()).toEqual(['a', 'b']);
        expect((await readdir(dir)).some((f) => f.includes('.pending-'))).toBe(false);
    });
});

describe('pending updates and API contention', () => {
    it('recovers a pending rotation without reverting a later default change', async () => {
        const store = new FileStore(blobPath);
        const a = oauth('a', 9999);
        const b = { ...oauth('b', 9999), isDefault: false };
        const renewed = oauth('a', 19999, 'pending');
        await store.write(blobOf(a, b));
        const failing: ICredentialStore = {
            id: 'file', writable: true, isAvailable: async () => true,
            read: () => store.read(), delete: () => store.delete(), describe: () => 'fixture',
            write: async () => { throw new Error('fixture write unavailable'); },
        };
        const vault = makeVault(failing);
        await vault.getPassword();
        await vault.setPassword(blobOf(renewed, b));
        await store.write(blobOf({ ...a, isDefault: false }, { ...b, isDefault: true }));
        const recovered = JSON.parse((await makeVault(store).getPassword())!) as KeyStore;
        expect(recovered.a!.creds).toEqual(renewed.creds);
        expect(recovered.a!.isDefault).toBe(false);
        expect(recovered.b!.isDefault).toBe(true);
        expect((await readdir(dir)).some(name => name.includes('.pending-'))).toBe(false);
    });

    it('propagates API contention without reporting an existing alias missing', async () => {
        const store = new FileStore(blobPath);
        await store.write(blobOf(oauth('a', 9999)));
        const { setDefaultAlias, deleteAlias, listAliases } = await import('../../../src/api.js');
        const { loadConfig } = await import('../../../src/config.js');
        const config = { ...loadConfig(), store: 'file' as const, blobPath, lockTimeoutMs: 1 };
        expect((await listAliases(config)).path).toBe(blobPath);
        await makeVault(store).withTransaction(async () => {
            await expect(setDefaultAlias('a', config)).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
            await expect(deleteAlias('a', config)).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
        });
    });
});

describe('operation-scoped refresh', () => {
    it('reads expired aliases without retaining a lock', async () => {
        const store = new FileStore(blobPath);
        await store.write(blobOf(oauth('a', -1)));
        const vault = makeVault(store);
        await vault.getPassword();
        expect((await readdir(dir)).some(name => name.endsWith('.lock'))).toBe(false);
    });

    it('retains exclusivity through refresh and persistence', async () => {
        const store = new FileStore(blobPath);
        await store.write(blobOf(oauth('a', -1)));
        const vault = makeVault(store);
        const creds = (JSON.parse((await vault.getPassword())!) as KeyStore).a!.creds;
        if (creds.type !== 'oauth') throw new Error('fixture mismatch');
        await vault.refreshCredentials(creds, async () => {
            const contender = new CredentialVault(store, { blobPath, lockTimeoutMs: 1 });
            await expect(contender.withTransaction(async () => {})).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
            expect(await contender.getPassword()).not.toBeNull();
            const renewed = oauth('a', 3600, 'renewed').creds;
            if (renewed.type !== 'oauth') throw new Error('fixture mismatch');
            return renewed;
        });
        expect(creds.access_token).toBe('renewed');
        expect((JSON.parse((await store.read()).blob!) as KeyStore).a!.creds).toEqual(creds);
        expect((await readdir(dir)).some(name => name.endsWith('.lock'))).toBe(false);
    });

    it('releases immediately when refresh fails', async () => {
        const store = new FileStore(blobPath);
        await store.write(blobOf(oauth('a', -1)));
        const vault = makeVault(store);
        const creds = (JSON.parse((await vault.getPassword())!) as KeyStore).a!.creds;
        if (creds.type !== 'oauth') throw new Error('fixture mismatch');
        await expect(vault.refreshCredentials(creds, async () => { throw new Error('unavailable'); })).rejects.toThrow('unavailable');
        await expect(makeVault(store).withTransaction(async () => true)).resolves.toBe(true);
    });

    it('does not lock or call refresh in the old 900–960 second skew band', async () => {
        const vault = makeVault();
        const creds = oauth('a', 950).creds;
        if (creds.type !== 'oauth') throw new Error('fixture mismatch');
        await vault.refreshCredentials(creds, async () => { throw new Error('must not refresh'); });
        expect(await readdir(dir)).toEqual([]);
    });

    it('preserves a valid addition even when its incoming blob omits existing aliases', async () => {
        const store = new FileStore(blobPath);
        await store.write(blobOf(oauth('a', 9999), oauth('b', 9999)));
        const vault = makeVault(store);
        await vault.getPassword();
        await vault.setPassword(blobOf(oauth('new', 9999)));
        expect(Object.keys(JSON.parse((await store.read()).blob!)).sort()).toEqual(['a', 'b', 'new']);
    });
});
