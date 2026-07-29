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

describe('getPassword — never throws, but distinguishes empty from broken', () => {
    it('returns null for a genuinely empty store', async () => {
        expect(await makeVault().getPassword()).toBeNull();
    });

    it('returns null rather than throwing when the backend fails', async () => {
        // The SDK has no try/catch around this; a throw would surface as the
        // misleading "Default Credential has not been set".
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
        await expect(makeVault(failing).getPassword()).resolves.toBeNull();
    });

    it('refuses a corrupt blob and preserves a copy', async () => {
        // Returning it would make the SDK's own JSON.parse throw from deep in
        // its auth path, which is far harder to diagnose.
        const store = new FileStore(blobPath);
        await store.write('{not json at all');

        expect(await makeVault(store).getPassword()).toBeNull();
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

describe('refresh lease — single-flight', () => {
    it('does not take a lease when nothing is near expiry', async () => {
        const store = new FileStore(blobPath);
        await store.write(blobOf(oauth('a', 86_400))); // a day out

        await makeVault(store).getPassword();
        // No lock left behind means the fast, lock-free path was taken.
        expect((await readdir(dir)).some((f) => f.endsWith('.lock'))).toBe(false);
    });

    it('holds a lease across getPassword when a token is inside the refresh window', async () => {
        // 300s < the SDK's 900s window, so the SDK is about to refresh.
        const store = new FileStore(blobPath);
        await store.write(blobOf(oauth('a', 300)));

        const vault = makeVault(store);
        await vault.getPassword();
        expect((await readdir(dir)).some((f) => f.endsWith('.lock'))).toBe(true);

        // setPassword completes the pair and must release it.
        await vault.setPassword(blobOf(oauth('a', 3600, 'refreshed')));
        expect((await readdir(dir)).some((f) => f.endsWith('.lock'))).toBe(false);
    });

    it('a second holder skips the refresh once the first has renewed the token', async () => {
        // This is the single-flight proof: the re-read under the lock shows the
        // token is no longer in the window, so no duplicate token call happens.
        const store = new FileStore(blobPath);
        await store.write(blobOf(oauth('a', 300)));

        const first = makeVault(store);
        await first.getPassword(); // takes the lease
        await first.setPassword(blobOf(oauth('a', 3600, 'refreshed'))); // renews + releases

        const second = makeVault(store);
        const blob = await second.getPassword();

        expect(JSON.parse(blob!).a.creds.access_token).toBe('refreshed');
        expect((await readdir(dir)).some((f) => f.endsWith('.lock'))).toBe(false);
    });

    it('is reentrant — a second getPassword does not deadlock on our own lease', async () => {
        // Regression: the SDK calls getCredentials more than once per command,
        // so getPassword fires again while the lease from the first call is
        // still held. This used to block on a lock the process already owned and
        // burn the full 20s timeout. Observed live as "held by pid <self>".
        const store = new FileStore(blobPath);
        await store.write(blobOf(oauth('a', 300))); // inside the refresh window

        const vault = makeVault(store);

        const started = Date.now();
        await vault.getPassword(); // takes the lease
        await vault.getPassword(); // must reuse it, not wait on it
        const elapsed = Date.now() - started;

        // The bug made this take the full lock timeout (3000ms here).
        expect(elapsed).toBeLessThan(1000);

        await vault.setPassword(blobOf(oauth('a', 3600, 'refreshed')));
        expect((await readdir(dir)).some((f) => f.endsWith('.lock'))).toBe(false);
    });
});
