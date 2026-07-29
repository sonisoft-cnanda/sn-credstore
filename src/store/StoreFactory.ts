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
import { ResolvedConfig } from '../config.js';
import { PlaintextNotPermittedError } from '../errors.js';

/**
 * Build the configured store.
 *
 * Synchronous by design — it is called from the module-load path of the shim,
 * where an await would force every consumer's entry point to become async.
 * Availability is therefore only probed lazily, by the store itself.
 */
export function createStore(config: ResolvedConfig): ICredentialStore {
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
        default:
            // Defaults to file. See config.ts for why encryption is not the
            // default: on-host it protects nothing, while adding failure modes
            // that the SDK converts into a full store wipe.
            return new FileStore(config.blobPath);
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
