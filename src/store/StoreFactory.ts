/**
 * Backend selection.
 *
 * The one rule that matters: NEVER silently downgrade from an encrypted backend
 * to plaintext. If someone asked for systemd-creds and it is unavailable, they
 * need to know — quietly writing their credentials in the clear instead is the
 * kind of thing nobody notices until it is in a backup somewhere.
 */
import { ICredentialStore } from './ICredentialStore.js';
import { FileStore } from './FileStore.js';
import { SystemdCredsStore } from './SystemdCredsStore.js';
import { detectSystemdUserCredsSupport, SystemdUserCredsSupport, MIN_SYSTEMD_VERSION } from './systemdSupport.js';
import { ResolvedConfig } from '../config.js';
import { PlaintextNotPermittedError } from '../errors.js';
import { logger } from '../logger.js';

/**
 * Build the configured store.
 *
 * Synchronous by design — it is called from the module-load path of the shim,
 * where an await would force every consumer's entry point to become async.
 * In auto mode the systemd-creds precondition is probed synchronously (a stat,
 * plus one subprocess only on the unhealthy path); an unsupported host either
 * falls back to FileStore (when allowPlaintext is set) or throws — never a
 * silent downgrade.
 */
export function createStore(
    config: ResolvedConfig,
    opts: { systemdSupport?: SystemdUserCredsSupport } = {},
): ICredentialStore {
    switch (config.store) {
        case 'systemd-creds':
            return new SystemdCredsStore(config.blobPath, config.systemdKey);
        case 'file':
            return new FileStore(config.blobPath);
        case 'keyring':
            throw new PlaintextNotPermittedError(
                'the keyring backend is read-only and cannot be used as the active store',
                'It exists only for `sn-credstore import --from keyring`. Use SN_CRED_STORE=file or systemd-creds.',
                { storeId: 'keyring' },
            );
        case 'auto':
        default: {
            // Encrypted by default. Verified to work identically across
            // concurrent headless agents — see config.ts for the threat model
            // and for what it genuinely does (and does not) protect against.
            const support = opts.systemdSupport ?? detectSystemdUserCredsSupport();
            if (support.supported) {
                return new SystemdCredsStore(config.blobPath, config.systemdKey);
            }
            if (config.allowPlaintext) {
                // Explicitly permitted — FileStore still warns once on write.
                logger.debug(`falling back to file store: ${support.reason}`);
                return new FileStore(config.blobPath);
            }
            throw new PlaintextNotPermittedError(
                `encrypted credential storage is unavailable: ${support.reason}`,
                `Upgrade to systemd >= ${MIN_SYSTEMD_VERSION} to use the encrypted default. ` +
                    `To use the unencrypted 0600 file store instead, either set ` +
                    `SN_CRED_STORE_ALLOW_PLAINTEXT=1 (or "allowPlaintext": true in ` +
                    `~/.config/sn-credstore/config.json) to allow automatic fallback, ` +
                    `or select it explicitly with SN_CRED_STORE=file.`,
                { storeId: 'systemd-creds' },
            );
        }
    }
}

export interface BackendProbe {
    id: string;
    available: boolean;
    writable: boolean;
    description: string;
    error?: string;
}

/** Probe every backend for `doctor`. Never throws. */
export async function probeAll(config: ResolvedConfig): Promise<BackendProbe[]> {
    const candidates: ICredentialStore[] = [
        new FileStore(config.blobPath),
        new SystemdCredsStore(config.blobPath, config.systemdKey),
    ];

    const results: BackendProbe[] = [];
    for (const store of candidates) {
        try {
            results.push({
                id: store.id,
                available: await store.isAvailable(),
                writable: store.writable,
                description: store.describe(),
            });
        } catch (err) {
            results.push({
                id: store.id,
                available: false,
                writable: store.writable,
                description: store.describe(),
                error: (err as Error).message,
            });
        }
    }
    return results;
}
