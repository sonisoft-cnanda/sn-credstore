/**
 * Default backend: a plain 0600 JSON file.
 *
 * Chosen as the default deliberately. Against the actual threat model — many
 * agents on one host, all running as the same user — encrypting at rest buys
 * nothing on-host, because any key the agent can use without interaction is a
 * key every same-uid process can use too. What it does cost is fork/exec per
 * read, and the SDK converts a transient read failure into a full store wipe.
 *
 * Reliability wins here. `SystemdCredsStore` is one env var away for anyone who
 * wants the off-host property (backups/snapshots/stray copies not decrypting).
 */
import { ICredentialStore, StoreReadResult } from './ICredentialStore.js';
import {
    readFileVersioned,
    writeFileAtomic,
    deleteFileIfExists,
    currentVersion,
    FILE_MODE,
} from './atomicFile.js';
import { CredentialStoreError } from '../errors.js';
import { warnOnce } from '../logger.js';

export class FileStore implements ICredentialStore {
    readonly id = 'file' as const;
    readonly writable = true;

    constructor(private readonly blobPath: string) {}

    async isAvailable(): Promise<boolean> {
        // A plain file on a normal filesystem. The only way this is unusable is
        // if the directory cannot be created, which write() will report properly.
        return true;
    }

    async read(): Promise<StoreReadResult> {
        try {
            const { content, version } = await readFileVersioned(this.blobPath);
            return { blob: content, version };
        } catch (err) {
            // Deliberately NOT collapsing to null — see ICredentialStore.read.
            throw new CredentialStoreError(
                'STORE_UNAVAILABLE',
                `could not read ${this.blobPath}: ${(err as Error).message}`,
                `Check the file's permissions and ownership. It should be mode 0600 and owned by you. ` +
                    `Run: sn-credstore doctor`,
                { storeId: this.id, cause: err },
            );
        }
    }

    async write(blob: string, expected?: string | null): Promise<string> {
        if (expected !== undefined) {
            const actual = await currentVersion(this.blobPath);
            if (actual !== expected) {
                throw new CredentialStoreError(
                    'STORE_CORRUPT',
                    `concurrent modification of ${this.blobPath} (expected version ${expected ?? 'none'}, found ${actual ?? 'none'})`,
                    'Another process wrote the credential store while this one was working. Retry the command.',
                    { storeId: this.id },
                );
            }
        }

        this.warnPlaintext();
        return writeFileAtomic(this.blobPath, blob);
    }

    async delete(): Promise<boolean> {
        return deleteFileIfExists(this.blobPath);
    }

    describe(): string {
        return `file (unencrypted, mode ${FILE_MODE.toString(8)}) at ${this.blobPath}`;
    }

    /**
     * Once per process. Repeating it on every credential read would train the
     * user to ignore everything this package prints.
     */
    private warnPlaintext(): void {
        warnOnce(
            'plaintext-store',
            `credentials are stored UNENCRYPTED at ${this.blobPath} (mode 0600). ` +
                `For off-host protection (backups, snapshots, copied files) set SN_CRED_STORE=systemd-creds.`,
        );
    }
}
