/**
 * The object the SDK's KeyChain methods are rewired to.
 *
 * Three responsibilities, all of them about not losing credentials:
 *
 *  1. Refresh lease (single-flight). All agents share one `expires_at`, so they
 *     do not race randomly — they stampede in lockstep inside the same 15-minute
 *     window. Without arbitration, N agents each call the token endpoint; if
 *     ServiceNow rotates refresh tokens, N-1 of them are invalidated and the SDK
 *     throws demanding an interactive `now-sdk auth --add` — an outage on a
 *     headless box.
 *
 *  2. Clobber protection. The SDK seeds every write from
 *     `(await getParsedCredentials()) ?? {}`, so one failed read followed by any
 *     write silently replaces the whole store with a single alias.
 *
 *  3. setPassword must never throw. Its call site upstream has no try/catch, so
 *     throwing turns a successful token refresh into a crash — after the network
 *     round trip, with the new token already issued and now unrecorded.
 */
import { ICredentialStore } from '../store/ICredentialStore.js';
import { KeyStore, parseKeyStore, serializeKeyStore, isInRefreshWindow } from '../types.js';
import { mergeKeyStores, detectClobber } from './merge.js';
import { acquireLock, LockHandle } from '../lock/FileLock.js';
import { lockPathFor } from '../config.js';
import { logger } from '../logger.js';
import { StoreCorruptError } from '../errors.js';
import { writeFileAtomic, readFileVersioned, deleteFileIfExists } from '../store/atomicFile.js';
import { readdir } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';

/** Give up on a lease this long after taking it, in case the SDK never writes. */
const LEASE_TIMEOUT_MS = 30_000;
const WRITE_RETRIES = 3;

export interface VaultOptions {
    blobPath: string;
    lockTimeoutMs?: number;
}

export class CredentialVault {
    private readonly lockPath: string;

    /** Last blob we successfully read, so we can diff the SDK's write against it. */
    private lastReadStore: KeyStore | null = null;

    /** Held across a getPassword -> setPassword pair when a refresh is imminent. */
    private lease: LockHandle | null = null;
    private leaseTimer: NodeJS.Timeout | null = null;

    /** True only while an explicit delete is in flight, which permits removals. */
    private removalIntent = false;

    constructor(
        private readonly store: ICredentialStore,
        private readonly options: VaultOptions,
    ) {
        this.lockPath = lockPathFor(options.blobPath);
    }

    /**
     * Mirrors KeyChain.getPassword: returns the raw blob, or null when empty.
     *
     * Must not throw — the SDK treats any throw here as "no credentials". But
     * unlike the SDK we distinguish empty from broken, and say so on stderr.
     */
    async getPassword(): Promise<string | null> {
        try {
            await this.absorbPendingSidecars();

            // Lock-free: >95% of calls need no refresh, and atomic-rename writes
            // mean a reader can never observe a partial blob.
            const { blob } = await this.store.read();
            if (blob === null) {
                logger.debug('credential store is empty');
                this.lastReadStore = null;
                return null;
            }

            const parsed = parseKeyStore(blob);
            if (parsed === null) {
                // Returning it would make the SDK's own JSON.parse throw a bare
                // SyntaxError from deep inside its auth path. Preserve and refuse.
                await this.quarantineCorruptBlob(blob);
                logger.error(
                    `credential store at ${this.options.blobPath} is not a valid keystore; ` +
                        `a copy was preserved alongside it. Re-import with: sn-credstore import --from keyring`,
                );
                return null;
            }

            this.lastReadStore = parsed;

            if (this.anyAliasNeedsRefresh(parsed)) {
                return await this.takeRefreshLease(parsed);
            }
            return blob;
        } catch (err) {
            // Never propagate: the SDK would report "Default Credential has not
            // been set", which is the misleading message we exist to replace.
            this.reportReadFailure(err);
            return null;
        }
    }

    /**
     * Mirrors KeyChain.setPassword. MUST NOT THROW — see class docblock.
     */
    async setPassword(blob: string): Promise<void> {
        try {
            await this.persist(blob);
        } catch (err) {
            logger.error(`failed to persist credential store: ${(err as Error).message}`);
            await this.writePendingSidecar(blob);
        } finally {
            await this.releaseLease();
        }
    }

    async deletePassword(): Promise<boolean> {
        this.removalIntent = true;
        try {
            const removed = await this.store.delete();
            this.lastReadStore = null;
            return removed;
        } catch (err) {
            logger.error(`failed to delete credential store: ${(err as Error).message}`);
            return false;
        } finally {
            this.removalIntent = false;
            await this.releaseLease();
        }
    }

    /** Let callers (e.g. `sn-credstore delete <alias>`) authorise removals. */
    async withRemovalIntent<T>(fn: () => Promise<T>): Promise<T> {
        this.removalIntent = true;
        try {
            return await fn();
        } finally {
            this.removalIntent = false;
        }
    }

    // ---------------------------------------------------------------- internals

    private anyAliasNeedsRefresh(store: KeyStore): boolean {
        return Object.values(store).some((entry) => isInRefreshWindow(entry.creds));
    }

    /**
     * Single-flight: take the lock, then RE-READ under it.
     *
     * The re-read is the whole mechanism. If a peer refreshed while we waited,
     * the alias is no longer in the window, so we release and return their fresh
     * blob without making a second token call. Otherwise we keep the lock held
     * across the SDK's refresh and its setPassword.
     */
    private async takeRefreshLease(current: KeyStore): Promise<string> {
        // Reentrancy. The SDK calls getCredentials more than once per command,
        // so getPassword can fire again while we still hold the lease from the
        // previous call. Without this check the process blocks on a lock it
        // already owns and burns the full 20s timeout before falling through —
        // observed live as "held by pid <self>, age 20786ms".
        if (this.lease !== null) {
            logger.debug('refresh lease already held by this process; reusing it');
            return serializeKeyStore(current);
        }

        let lock: LockHandle;
        try {
            lock = await acquireLock(this.lockPath, {
                timeoutMs: this.options.lockTimeoutMs ?? 20_000,
                op: 'oauth-refresh',
            });
        } catch (err) {
            // Better to risk a duplicate refresh than to fail the command.
            logger.warn(`proceeding without refresh lease: ${(err as Error).message}`);
            return serializeKeyStore(current);
        }

        try {
            const { blob } = await this.store.read();
            const reread = blob === null ? null : parseKeyStore(blob);

            if (reread !== null && !this.anyAliasNeedsRefresh(reread)) {
                logger.debug('another process already refreshed; skipping duplicate refresh');
                this.lastReadStore = reread;
                await lock.release();
                return blob as string;
            }

            if (reread !== null) {
                this.lastReadStore = reread;
            }

            // Hold the lock across the SDK's refresh + setPassword.
            this.lease = lock;
            this.leaseTimer = setTimeout(() => {
                logger.warn('refresh lease expired without a write; releasing');
                void this.releaseLease();
            }, LEASE_TIMEOUT_MS);
            this.leaseTimer.unref?.();

            return serializeKeyStore(this.lastReadStore ?? current);
        } catch (err) {
            await lock.release();
            throw err;
        }
    }

    private async releaseLease(): Promise<void> {
        if (this.leaseTimer !== null) {
            clearTimeout(this.leaseTimer);
            this.leaseTimer = null;
        }
        if (this.lease !== null) {
            const lock = this.lease;
            this.lease = null;
            await lock.release();
        }
    }

    /** Merge and write, holding the lock if we do not already hold the lease. */
    private async persist(blob: string): Promise<void> {
        const incoming = parseKeyStore(blob);
        if (incoming === null) {
            throw new StoreCorruptError(
                'refusing to persist a blob that is not a valid keystore',
                'This is a bug in the caller. Report it with SN_CRED_STORE_DEBUG=1 output.',
                { storeId: this.store.id },
            );
        }

        // The guard against a write seeded from a failed read.
        const dropped = detectClobber(this.lastReadStore, incoming);
        if (dropped.length > 0 && !this.removalIntent) {
            logger.error(
                `refusing to drop ${dropped.length} alias(es) [${dropped.join(', ')}] — ` +
                    `this write would have removed credentials that were not deleted explicitly. ` +
                    `Existing credentials were left untouched.`,
            );
            // Not a throw: setPassword must never throw. Refusing is recoverable.
            return;
        }

        const alreadyHeld = this.lease !== null;
        const doWrite = async (): Promise<void> => {
            const { blob: currentBlob, version: currentVersion } = await this.store.read();
            const current = currentBlob === null ? {} : (parseKeyStore(currentBlob) ?? {});
            const base = this.lastReadStore ?? current;

            const { merged, protectedAliases } = mergeKeyStores(base, incoming, current, {
                allowRemovals: this.removalIntent,
            });
            if (protectedAliases.length > 0) {
                logger.warn(`preserved ${protectedAliases.length} alias(es) not present in this write: ${protectedAliases.join(', ')}`);
            }

            // Compare-and-swap against the version we just read under the lock.
            // The lock already serialises everything that goes through us, so
            // this specifically catches writers that DON'T — a bare `now-sdk`
            // without the preload, or an IDE extension using the keyring path.
            // Without it, such a writer's update would be silently overwritten.
            const serialized = serializeKeyStore(merged);
            await this.writeWithRetry(serialized, currentVersion);
            this.lastReadStore = merged;
        };

        if (alreadyHeld) {
            await doWrite();
        } else {
            const lock = await acquireLock(this.lockPath, {
                timeoutMs: this.options.lockTimeoutMs ?? 20_000,
                op: 'write',
            });
            try {
                await doWrite();
            } finally {
                await lock.release();
            }
        }
    }

    private async writeWithRetry(blob: string, expected?: string | null): Promise<void> {
        let lastErr: unknown;
        for (let attempt = 0; attempt < WRITE_RETRIES; attempt++) {
            try {
                // Only the first attempt carries the CAS token. A retry means the
                // earlier write may or may not have landed, so re-asserting a
                // stale version would fail forever; the lock still serialises us.
                await this.store.write(blob, attempt === 0 ? expected : undefined);
                return;
            } catch (err) {
                lastErr = err;
                logger.debug(`write attempt ${attempt + 1}/${WRITE_RETRIES} failed`);
                await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
            }
        }
        throw lastErr;
    }

    /**
     * Last resort when every write attempt failed.
     *
     * Silently swallowing would permanently lose a rotated refresh token — the
     * old one is already invalid server-side, so the credential is simply dead.
     * A sidecar keeps it recoverable and the next read folds it back in.
     */
    private async writePendingSidecar(blob: string): Promise<void> {
        try {
            const path = `${this.options.blobPath}.pending-${Date.now()}`;
            await writeFileAtomic(path, blob);
            logger.error(
                `credential update could not be saved to the store; it was written to ${path} ` +
                    `and will be merged on the next successful read. Do not delete that file.`,
            );
        } catch (err) {
            logger.error(`could not write emergency sidecar either: ${(err as Error).message}`);
        }
    }

    /** Fold any `.pending-*` sidecars back into the store, then remove them. */
    private async absorbPendingSidecars(): Promise<void> {
        const dir = dirname(this.options.blobPath);
        const prefix = `${basename(this.options.blobPath)}.pending-`;

        let entries: string[];
        try {
            entries = (await readdir(dir)).filter((f) => f.startsWith(prefix));
        } catch {
            return;
        }
        if (entries.length === 0) return;

        logger.warn(`recovering ${entries.length} pending credential update(s)`);
        for (const entry of entries.sort()) {
            const path = join(dir, entry);
            try {
                const { content } = await readFileVersioned(path);
                if (content === null) continue;
                const pending = parseKeyStore(content);
                if (pending === null) continue;

                const { blob: currentBlob } = await this.store.read();
                const current = currentBlob === null ? {} : (parseKeyStore(currentBlob) ?? {});
                const { merged } = mergeKeyStores(current, pending, current, { allowRemovals: false });
                await this.store.write(serializeKeyStore(merged));
                await deleteFileIfExists(path);
                logger.info(`recovered pending credential update from ${entry}`);
            } catch (err) {
                logger.warn(`could not recover ${entry}: ${(err as Error).message}`);
            }
        }
    }

    private async quarantineCorruptBlob(blob: string): Promise<void> {
        try {
            await writeFileAtomic(`${this.options.blobPath}.corrupt.${Date.now()}`, blob);
        } catch {
            /* best effort */
        }
    }

    /** Say what actually went wrong, with remediation — the SDK never does. */
    private reportReadFailure(err: unknown): void {
        const anyErr = err as { remediation?: string; message?: string };
        if (typeof anyErr?.remediation === 'string') {
            logger.error(`${anyErr.message}\n  Remediation: ${anyErr.remediation}`);
        } else {
            logger.error(`could not read credential store: ${(err as Error).message}`);
        }
    }
}
