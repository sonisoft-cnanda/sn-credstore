/**
 * Opt-in backend: the blob encrypted with `systemd-creds --user`.
 *
 * What this actually protects against — stated honestly, because the name
 * oversells it. `--user` binds uid + username + machine-id and encrypts with a
 * root-owned host key. But non-root can use it via /run/systemd/io.systemd.Credentials,
 * a 0666 socket served by a root process that performs the crypto after checking
 * peer credentials. So ANY process running as you can decrypt this, exactly like
 * a 0600 file. On-host, the security gain is zero.
 *
 * The real, and genuinely useful, property is OFF-host: a copied blob does not
 * decrypt anywhere else. rsync'd home directories, backups, VM snapshots, an
 * accidental `git add` — all useless to an attacker. That is why this exists.
 *
 * The corollary is a hard operational constraint: these blobs CANNOT be moved
 * between machines, users, or usernames. Reimage, machine-id change, or a
 * container running the same uid under a different name all make existing blobs
 * permanently undecryptable. Treat the store as a cache, not a system of record.
 */
import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { ICredentialStore, StoreReadResult } from './ICredentialStore.js';
import {
    readFileVersioned,
    writeFileAtomic,
    deleteFileIfExists,
    currentVersion,
} from './atomicFile.js';
import { StoreDecryptError, StoreUnavailableError, CredentialStoreError } from '../errors.js';
import { sanitizeProcessError } from '../redact.js';
import { SYSTEMD_CRED_NAME } from '../config.js';
import { logger } from '../logger.js';

const VARLINK_SOCKET = '/run/systemd/io.systemd.Credentials';
const EXEC_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 4 * 1024 * 1024;

/**
 * Metadata stored in cleartext beside the ciphertext.
 *
 * Without this, a decrypt failure is just "decrypt failed" and the user has no
 * idea which binding broke. With it we can say exactly: different machine,
 * different user, or different key type.
 */
interface Envelope {
    version: 1;
    keyType: string;
    machineId: string | null;
    uid: number;
    username: string;
    createdAt: string;
    ciphertext: string;
}

export class SystemdCredsStore implements ICredentialStore {
    readonly id = 'systemd-creds' as const;
    readonly writable = true;

    constructor(
        private readonly blobPath: string,
        private readonly keyType: 'host' | 'tpm2' | 'host+tpm2' = 'host',
    ) {}

    async isAvailable(): Promise<boolean> {
        // The socket is what makes --user work for non-root, and unlike the host
        // key file it is actually stat-able by us. Checking for the binary alone
        // would pass inside a container that has systemd installed but not running.
        try {
            await access(VARLINK_SOCKET, constants.F_OK);
        } catch {
            if (process.getuid?.() !== 0) return false;
        }
        try {
            await this.run(['--version'], undefined);
            return true;
        } catch {
            return false;
        }
    }

    async read(): Promise<StoreReadResult> {
        const { content, version } = await readFileVersioned(this.blobPath);
        if (content === null) return { blob: null, version: null };

        let envelope: Envelope;
        try {
            envelope = JSON.parse(content) as Envelope;
        } catch (err) {
            throw new StoreDecryptError(
                `${this.blobPath} is not a valid sn-credstore envelope`,
                `The file may be truncated or from an incompatible version. ` +
                    `Move it aside and re-import: sn-credstore import --from keyring`,
                { storeId: this.id, cause: err },
            );
        }

        let plaintext: string;
        try {
            plaintext = await this.run(
                ['decrypt', '--user', `--name=${SYSTEMD_CRED_NAME}`, '-', '-'],
                envelope.ciphertext,
            );
        } catch (err) {
            throw new StoreDecryptError(
                `failed to decrypt ${this.blobPath}: ${(err as Error).message}`,
                this.explainBindingMismatch(envelope),
                { storeId: this.id, cause: err },
            );
        }

        return { blob: plaintext, version };
    }

    async write(blob: string, expected?: string | null): Promise<string> {
        if (expected !== undefined) {
            const actual = await currentVersion(this.blobPath);
            if (actual !== expected) {
                throw new CredentialStoreError(
                    'STORE_CORRUPT',
                    `concurrent modification of ${this.blobPath}`,
                    'Another process wrote the credential store while this one was working. Retry the command.',
                    { storeId: this.id },
                );
            }
        }

        let ciphertext: string;
        try {
            // Plaintext goes in on STDIN and ciphertext comes out on STDOUT.
            // Never via file paths: a temp file would put cleartext credentials
            // on disk, and /proc/<pid>/cmdline is world-readable so any path we
            // passed would advertise where they are.
            ciphertext = await this.run(
                ['encrypt', '--user', `--with-key=${this.keyType}`, `--name=${SYSTEMD_CRED_NAME}`, '-', '-'],
                blob,
            );
        } catch (err) {
            throw new StoreUnavailableError(
                `systemd-creds encrypt failed: ${(err as Error).message}`,
                `Check that systemd-creds works: echo test | systemd-creds encrypt --user --name=probe - -\n` +
                    `In a container without systemd, use SN_CRED_STORE=file SN_CRED_STORE_ALLOW_PLAINTEXT=1.`,
                { storeId: this.id, cause: err },
            );
        }

        const envelope: Envelope = {
            version: 1,
            keyType: this.keyType,
            machineId: await readMachineId(),
            uid: process.getuid?.() ?? -1,
            username: process.env.USER ?? process.env.LOGNAME ?? 'unknown',
            createdAt: new Date().toISOString(),
            ciphertext,
        };

        return writeFileAtomic(this.blobPath, `${JSON.stringify(envelope, null, 2)}\n`);
    }

    async delete(): Promise<boolean> {
        return deleteFileIfExists(this.blobPath);
    }

    describe(): string {
        return `systemd-creds --user (--with-key=${this.keyType}, --name=${SYSTEMD_CRED_NAME}) at ${this.blobPath}`;
    }

    /** Name the specific binding that broke, rather than a generic decrypt failure. */
    private explainBindingMismatch(envelope: Envelope): string {
        const currentUid = process.getuid?.() ?? -1;
        const currentUser = process.env.USER ?? process.env.LOGNAME ?? 'unknown';
        const reasons: string[] = [];

        if (envelope.uid !== currentUid) {
            reasons.push(`encrypted for uid ${envelope.uid}, running as uid ${currentUid}`);
        }
        if (envelope.username !== currentUser) {
            reasons.push(`encrypted for user "${envelope.username}", running as "${currentUser}"`);
        }
        if (envelope.keyType !== this.keyType) {
            reasons.push(`encrypted with --with-key=${envelope.keyType}, now configured for ${this.keyType}`);
        }

        const detail = reasons.length > 0 ? ` Detected: ${reasons.join('; ')}.` : '';
        return (
            `systemd-creds blobs are bound to uid + username + machine-id and a per-install host key, ` +
            `so they cannot be copied between machines, users, or reimages.${detail} ` +
            `Recover by re-importing on this host: sn-credstore import --from keyring — ` +
            `or re-authenticate: now-sdk-x auth --add <instance>`
        );
    }

    /** Run systemd-creds with input on stdin, returning stdout. Never logs stdout. */
    private run(args: string[], input: string | undefined): Promise<string> {
        return new Promise((resolvePromise, rejectPromise) => {
            const child = execFile(
                'systemd-creds',
                args,
                { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf8' },
                (err, stdout, stderr) => {
                    if (err) {
                        // stderr is safe (systemd-creds does not echo plaintext);
                        // stdout is NOT — it is the credential blob.
                        logger.debug('systemd-creds failed', sanitizeProcessError(err));
                        const detail = String(stderr).trim() || (err as Error).message;
                        rejectPromise(new Error(detail));
                        return;
                    }
                    resolvePromise(String(stdout));
                },
            );
            if (input !== undefined) {
                child.stdin?.end(input);
            }
        });
    }
}

async function readMachineId(): Promise<string | null> {
    try {
        const { readFile } = await import('node:fs/promises');
        return (await readFile('/etc/machine-id', 'utf8')).trim();
    } catch {
        return null;
    }
}
