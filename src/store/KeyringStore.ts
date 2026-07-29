/**
 * Read-only view of the OS keyring the SDK normally uses.
 *
 * This exists ONLY to migrate credentials out (and, via an explicit escape
 * hatch, to sync them back for rollback). It is never the active store — that
 * is the whole problem we are solving.
 *
 * @napi-rs/keyring is resolved lazily from the SDK's own node_modules rather
 * than declared as a dependency here: it is a native module, and this package
 * must stay installable for the `now-sdk-x` wrapper on hosts where a prebuild
 * may not exist. If the SDK is not installed, import simply is not available.
 */
import { createRequire } from 'node:module';
import { ICredentialStore, StoreReadResult } from './ICredentialStore.js';
import { ReadOnlyStoreError, StoreUnavailableError } from '../errors.js';
import { findSdkCliCandidates } from '../shim/locateSdkCli.js';
import { logger } from '../logger.js';

/** Both hardcoded in the SDK at dist/auth/index.js:21 and keychain/index.js:7. */
const SERVICE = 'ServiceNow';
const ACCOUNT = 'now-sdk';

/**
 * A locked wallet shows a GUI prompt and blocks indefinitely. Without a bound,
 * `sn-credstore doctor` would hang forever on a headless box.
 */
const DEFAULT_TIMEOUT_MS = 15_000;

interface KeyringEntry {
    getPassword(): string | null;
    setPassword(password: string): void;
    deletePassword(): boolean;
}

interface KeyringModule {
    Entry: new (service: string, account: string) => KeyringEntry;
}

export class KeyringStore implements ICredentialStore {
    readonly id = 'keyring' as const;
    /** Deliberately false. Writes require the explicit escape hatch below. */
    readonly writable = false;

    private cached: KeyringModule | null = null;

    constructor(
        private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
        /** Only `export --to keyring` sets this. */
        private readonly allowWrite = false,
    ) {}

    /** Resolve @napi-rs/keyring from whichever SDK tree we can see. */
    private loadKeyring(): KeyringModule {
        if (this.cached !== null) return this.cached;

        const bases = findSdkCliCandidates().map((c) => c.packageRoot);
        bases.push(process.cwd());

        for (const base of bases) {
            try {
                const mod = createRequire(`${base}/`)('@napi-rs/keyring') as KeyringModule;
                if (typeof mod?.Entry === 'function') {
                    this.cached = mod;
                    return mod;
                }
            } catch {
                /* not visible from this base */
            }
        }

        throw new StoreUnavailableError(
            'could not load @napi-rs/keyring from any @servicenow/sdk-cli installation',
            'The keyring backend is only used to import existing credentials. Install the ServiceNow SDK ' +
                '(npm i -g @servicenow/sdk), or provision credentials directly: sn-credstore import --stdin',
            { storeId: this.id },
        );
    }

    /**
     * Bound any keyring call in time.
     *
     * The native call is synchronous, so this cannot actually interrupt a
     * blocked D-Bus round trip — it bounds the *await*, letting the caller
     * report a useful error instead of appearing hung. That distinction matters
     * for `doctor`, whose whole job is to explain what is wrong.
     */
    private withTimeout<T>(label: string, fn: () => T): Promise<T> {
        return new Promise<T>((resolvePromise, rejectPromise) => {
            const timer = setTimeout(() => {
                rejectPromise(
                    new StoreUnavailableError(
                        `${label} timed out after ${this.timeoutMs}ms`,
                        'The OS keyring is most likely locked and waiting on an interactive unlock prompt. ' +
                            'Run this from a desktop session, or use a store that does not need one.',
                        { storeId: this.id },
                    ),
                );
            }, this.timeoutMs);
            timer.unref?.();

            try {
                const value = fn();
                clearTimeout(timer);
                resolvePromise(value);
            } catch (err) {
                clearTimeout(timer);
                rejectPromise(err);
            }
        });
    }

    async isAvailable(): Promise<boolean> {
        try {
            this.loadKeyring();
            return true;
        } catch {
            return false;
        }
    }

    async read(): Promise<StoreReadResult> {
        const { Entry } = this.loadKeyring();
        const entry = new Entry(SERVICE, ACCOUNT);

        const blob = await this.withTimeout('keyring read', () => {
            try {
                return entry.getPassword();
            } catch (err) {
                // Unlike the SDK, we do NOT collapse this into "no credentials".
                // Distinguishing locked-keyring from empty-keyring is the entire
                // point of this package.
                throw new StoreUnavailableError(
                    `OS keyring read failed: ${(err as Error).message}`,
                    'The keyring is unavailable or locked. On a headless session there is usually no D-Bus ' +
                        'secret service at all — run the import from a desktop session where the wallet can unlock.',
                    { storeId: this.id, cause: err },
                );
            }
        });

        // A genuine absence. Only reachable when the keyring itself answered.
        if (blob === null) return { blob: null, version: null };

        // The keyring has no version concept; a content hash is enough for CAS.
        return { blob, version: `keyring-${blob.length}` };
    }

    async write(blob: string): Promise<string> {
        if (!this.allowWrite) {
            throw new ReadOnlyStoreError(
                'the keyring backend is read-only',
                'It exists to migrate credentials out. To deliberately write back (for rollback), use: ' +
                    'sn-credstore export --to keyring',
                { storeId: this.id },
            );
        }
        const { Entry } = this.loadKeyring();
        const entry = new Entry(SERVICE, ACCOUNT);
        await this.withTimeout('keyring write', () => entry.setPassword(blob));
        logger.warn('wrote credentials back to the OS keyring');
        return `keyring-${blob.length}`;
    }

    async delete(): Promise<boolean> {
        if (!this.allowWrite) {
            throw new ReadOnlyStoreError(
                'refusing to delete the OS keyring entry',
                'The keyring copy is deliberately preserved as a rollback path after migration. ' +
                    'Remove it explicitly with: now-sdk auth --delete all',
                { storeId: this.id },
            );
        }
        const { Entry } = this.loadKeyring();
        const entry = new Entry(SERVICE, ACCOUNT);
        return this.withTimeout('keyring delete', () => entry.deletePassword());
    }

    describe(): string {
        return `OS keyring (service="${SERVICE}", account="${ACCOUNT}", read-only)`;
    }
}
