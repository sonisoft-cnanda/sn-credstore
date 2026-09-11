import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { ICredentialStore } from '../store/ICredentialStore.js';
import { KeyStore, OAuthCred, parseKeyStore, serializeKeyStore, isInRefreshWindow } from '../types.js';
import { blockingProblems, describeProblems, findCredentialProblems } from '../validate.js';
import { mergeKeyStores } from './merge.js';
import { acquireLock } from '../lock/FileLock.js';
import { lockPathFor } from '../config.js';
import { logger } from '../logger.js';
import { StoreCorruptError, StoreUnavailableError } from '../errors.js';
import { writeFileAtomic, readFileVersioned, deleteFileIfExists } from '../store/atomicFile.js';

interface Operation {
    active: boolean;
    locked: boolean;
    removal: boolean;
    base: KeyStore | null;
    failure?: unknown;
}

interface PendingUpdate {
    version: 1;
    base: KeyStore | null;
    incoming: KeyStore;
    allowRemovals: boolean;
}

type Tokens = Pick<OAuthCred, 'access_token' | 'refresh_token' | 'expires_at' | 'token_type'>;
const fingerprint = (creds: OAuthCred): string => createHash('sha256')
    .update(JSON.stringify([creds.instanceUrl, creds.access_token, creds.refresh_token, creds.expires_at, creds.token_type]))
    .digest('hex');

export interface VaultOptions {
    blobPath: string;
    lockTimeoutMs?: number;
}

export class CredentialVault {
    private readonly lockPath: string;
    private readonly operations = new AsyncLocalStorage<Operation>();
    private readonly observed = new Map<string, Set<string>>();
    private lastReadStore: KeyStore | null = null;

    constructor(private readonly store: ICredentialStore, private readonly options: VaultOptions) {
        this.lockPath = lockPathFor(options.blobPath);
    }

    private operation(): Operation | undefined {
        const operation = this.operations.getStore();
        return operation?.active ? operation : undefined;
    }

    /** True only while a reviewed SDK mutation wrapper owns the transaction. */
    isTransactionActive(): boolean {
        return this.operation()?.locked === true;
    }

    private remember(store: KeyStore): void {
        for (const [alias, entry] of Object.entries(store)) {
            if (entry.creds.type !== 'oauth') continue;
            const key = fingerprint(entry.creds);
            const aliases = this.observed.get(key) ?? new Set<string>();
            aliases.add(alias);
            this.observed.delete(key);
            this.observed.set(key, aliases);
        }
        while (this.observed.size > 4096) this.observed.delete(this.observed.keys().next().value!);
    }

    private async readStore(): Promise<{ store: KeyStore; blob: string | null; version: string | null }> {
        const { blob, version } = await this.store.read();
        if (blob === null) return { store: {}, blob, version };
        const store = parseKeyStore(blob);
        if (store === null) {
            await writeFileAtomic(`${this.options.blobPath}.corrupt.${randomUUID()}`, blob).catch(() => {});
            throw new StoreCorruptError('Credential store is not a valid keystore.', 'Preserve the store and inspect it with sn-credstore doctor.');
        }
        return { store, blob, version };
    }

    /** Read credentials without arming a speculative refresh lease; null means empty only. */
    async getPassword(): Promise<string | null> {
        await this.absorbPendingSidecars();
        const { store, blob } = await this.readStore();
        const problems = findCredentialProblems(store);
        if (problems.length) logger.warn(`credential store has field problems:\n${describeProblems(problems)}`);
        this.remember(store);
        this.lastReadStore = blob === null ? null : store;
        const operation = this.operation();
        if (operation) operation.base = this.lastReadStore;
        return blob;
    }

    /** Run a complete mutation under one lock, with a baseline isolated from sibling calls. */
    async withTransaction<T>(fn: () => Promise<T>, op = 'write', removal = false): Promise<T> {
        const existing = this.operation();
        if (existing?.locked) return fn();
        const lock = await acquireLock(this.lockPath, { timeoutMs: this.options.lockTimeoutMs, op });
        const operation: Operation = { active: true, locked: true, removal, base: null };
        try {
            return await this.operations.run(operation, async () => {
                await this.absorbPendingSidecars();
                const result = await fn();
                if (operation.failure) throw operation.failure;
                return result;
            });
        } finally {
            operation.active = false;
            await lock.release();
        }
    }

    /** Persist SDK-issued rotation before releasing its lock, then update the SDK's credential object. */
    async refreshCredentials(creds: OAuthCred, refresh: (current: OAuthCred) => Promise<Tokens | undefined>): Promise<void> {
        if (!isInRefreshWindow(creds)) return;
        const aliases = this.observed.get(fingerprint(creds));
        if (!aliases?.size) {
            throw new StoreUnavailableError('Cannot associate this refresh with a stored alias.', 'Resolve credentials again through the SDK before refreshing.');
        }
        await this.withTransaction(async () => {
            const { store } = await this.readStore();
            const candidates = [...aliases].map(alias => store[alias]).filter(entry => entry?.creds.type === 'oauth' && entry.creds.instanceUrl === creds.instanceUrl);
            const current = candidates[0]?.creds;
            if (!current || current.type !== 'oauth' || candidates.some(entry => entry && entry.creds.type === 'oauth' && fingerprint(entry.creds) !== fingerprint(current))) {
                throw new StoreUnavailableError('Stored alias changed or became ambiguous before refresh.', 'Resolve the selected alias again.');
            }
            const tokens = await refresh({ ...current });
            const renewed: OAuthCred = { ...current, ...tokens };
            if (renewed.expires_at <= Math.floor(Date.now() / 1000)) {
                throw new StoreUnavailableError('SDK returned expired credentials after refresh.', 'Check instance connectivity and retry.');
            }
            if (tokens) {
                const updated: KeyStore = { ...store };
                for (const [alias, entry] of Object.entries(store)) {
                    if (entry.creds.type === 'oauth' && fingerprint(entry.creds) === fingerprint(current)) {
                        updated[alias] = { ...entry, creds: { ...renewed } };
                    }
                }
                this.operation()!.base = store;
                await this.setPassword(serializeKeyStore(updated));
                if (this.operation()!.failure) throw this.operation()!.failure;
                this.remember(updated);
            }
            // The reviewed SDK returns this same object when refreshAccessToken
            // returns undefined. Suppress its later, unlocked read-modify-write:
            // both the rotated token and alias metadata are already durable here.
            Object.assign(creds, renewed);
        }, 'oauth-refresh');
    }

    /** Preserve valid SDK updates in an emergency sidecar if normal persistence fails. Never throws. */
    async setPassword(blob: string): Promise<void> {
        const incoming = parseKeyStore(blob);
        const blocking = incoming === null ? [] : blockingProblems(findCredentialProblems(incoming));
        if (incoming === null || blocking.length > 0) {
            const error = new StoreCorruptError('Refusing malformed credential update.', 'Inspect the caller and run sn-credstore doctor.');
            const operation = this.operation();
            if (operation) operation.failure = error;
            logger.error(error.message);
            return;
        }
        try {
            await this.persist(incoming);
        } catch (error: unknown) {
            try {
                await this.writePendingSidecar(incoming);
            } catch {
                const operation = this.operation();
                if (operation) operation.failure = new StoreUnavailableError('Credential update and emergency recovery write both failed.', 'Restore writable credential storage before retrying.');
                logger.error('Could not persist credential update or its emergency sidecar.');
            }
            logger.error('Credential store write failed; a pending update is retained when recovery storage is writable.');
        }
    }

    /** Delete the complete store under the same lock used by refresh and writes. */
    async deletePassword(): Promise<boolean> {
        return this.withTransaction(async () => {
            const removed = await this.store.delete();
            this.lastReadStore = null;
            return removed;
        }, 'delete', true);
    }

    /** Authorize deletions only within this asynchronous operation. */
    async withRemovalIntent<T>(fn: () => Promise<T>): Promise<T> {
        const existing = this.operation();
        const operation: Operation = { active: true, locked: existing?.locked ?? false, removal: true, base: existing?.base ?? this.lastReadStore };
        try { return await this.operations.run(operation, fn); }
        finally { operation.active = false; }
    }

    /** Kept for callers predating operation-scoped locking; reads no longer hold leases. */
    async abandonLease(): Promise<void> {}

    private async persist(incoming: KeyStore): Promise<void> {
        const base = this.operation()?.base ?? this.lastReadStore;
        const removal = this.operation()?.removal ?? false;
        const write = async (): Promise<void> => {
            for (let attempt = 0; ; attempt++) {
                const { store: current, version } = await this.readStore();
                const { merged, protectedAliases } = mergeKeyStores(base ?? current, incoming, current, { allowRemovals: removal });
                if (protectedAliases.length) logger.warn(`preserved ${protectedAliases.length} aliases absent from this update`);
                try { await this.store.write(serializeKeyStore(merged), version); }
                catch (error: unknown) {
                    if (attempt === 2) throw error;
                    continue;
                }
                this.lastReadStore = merged;
                const operation = this.operation();
                if (operation) operation.base = merged;
                return;
            }
        };
        if (this.operation()?.locked) await write();
        else await this.withTransaction(write);
    }

    private async writePendingSidecar(incoming: KeyStore): Promise<void> {
        const path = `${this.options.blobPath}.pending-${Date.now()}-${randomUUID()}`;
        const pending: PendingUpdate = { version: 1, incoming, base: this.operation()?.base ?? this.lastReadStore,
            allowRemovals: this.operation()?.removal ?? false };
        await writeFileAtomic(path, JSON.stringify(pending));
        logger.error(`Credential update preserved in ${path}; the next successful read will recover it.`);
    }

    private async absorbPendingSidecars(): Promise<void> {
        const dir = dirname(this.options.blobPath);
        const prefix = `${basename(this.options.blobPath)}.pending-`;
        const entries = await readdir(dir).then(names => names.filter(name => name.startsWith(prefix)).sort(), error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw error;
        });
        if (!entries.length) return;
        if (!this.operation()?.locked) {
            await this.withTransaction(async () => {}, 'recover');
            return;
        }
        for (const entry of entries) {
            const path = join(dir, entry);
            const { content } = await readFileVersioned(path);
            if (content === null) continue;
            let value: unknown;
            try { value = JSON.parse(content); }
            catch { throw new StoreCorruptError('Malformed pending credential update.', 'Inspect pending updates with the credential clients stopped.'); }
            const envelope = value as Partial<PendingUpdate> | null;
            const wrapped = envelope?.version === 1 && envelope.incoming !== undefined;
            const pending = wrapped ? parseKeyStore(JSON.stringify(envelope.incoming)) : parseKeyStore(content);
            const base = wrapped && envelope.base !== null ? parseKeyStore(JSON.stringify(envelope.base)) : null;
            if (pending === null || blockingProblems(findCredentialProblems(pending)).length > 0) {
                throw new StoreCorruptError('Malformed pending credential update.', 'Inspect pending updates with the credential clients stopped.');
            }
            const { store: current, version } = await this.readStore();
            if (wrapped && envelope.base !== null && base === null) {
                throw new StoreCorruptError('Malformed pending credential baseline.', 'Inspect pending updates with the credential clients stopped.');
            }
            const { merged } = mergeKeyStores(base ?? current, pending, current, { allowRemovals: wrapped && envelope.allowRemovals === true });
            await this.store.write(serializeKeyStore(merged), version);
            await deleteFileIfExists(path);
        }
    }
}
