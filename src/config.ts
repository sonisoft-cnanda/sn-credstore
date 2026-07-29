/**
 * Configuration and backend selection.
 *
 * Precedence, highest first:
 *   1. SN_CRED_STORE env
 *   2. `store` in $XDG_CONFIG_HOME/sn-credstore/config.json
 *   3. auto  -> systemd-creds when usable, else an explicit error
 *
 * The default is systemd-creds, verified to work identically across concurrent
 * headless agents: it binds to uid + username + machine-id, NOT to a session or
 * process, so it never touches D-Bus or a session keyring. 20 concurrent agents
 * in a stripped session read and refreshed it with no failures.
 *
 * Be clear about what it does and does not buy. On-host it protects nothing: it
 * is a root-run decryption oracle reachable over a 0666 socket by any process
 * with your uid — the same population that can read a 0600 file. Its real value
 * is OFF-host, where a copied blob simply does not decrypt: backups, rsync'd
 * home directories, VM snapshots, a stray `git add`.
 *
 * The cost is fork/exec per read, and the SDK turns any transient read failure
 * into a full store wipe — which is why the vault's clobber guard and in-process
 * caching are load-bearing rather than belt-and-braces.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { logger } from './logger.js';

export type StoreId = 'file' | 'systemd-creds' | 'keyring';
export type StoreSelection = StoreId | 'auto';

export interface ResolvedConfig {
    /** Which backend to use. */
    store: StoreSelection;
    /** Absolute path to the credential blob. */
    blobPath: string;
    /** systemd-creds key type. Never 'auto' — see below. */
    systemdKey: 'host' | 'tpm2' | 'host+tpm2';
    /** Permit falling back to an unencrypted file when an encrypted backend is unavailable. */
    allowPlaintext: boolean;
    lockTimeoutMs: number;
    /** Entirely disable the shim. Escape hatch for debugging. */
    disabled: boolean;
}

/** Integrity-bound systemd credential name. Changing it invalidates every existing blob. */
export const SYSTEMD_CRED_NAME = 'sn-credstore-v1';

function xdgStateHome(): string {
    return process.env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state');
}

function xdgConfigHome(): string {
    return process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
}

export function configDir(): string {
    return join(xdgConfigHome(), 'sn-credstore');
}

export function stateDir(): string {
    return join(xdgStateHome(), 'sn-credstore');
}

function envFlag(name: string): boolean {
    const v = process.env[name];
    return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

function readConfigFile(): Partial<ResolvedConfig> {
    const path = join(configDir(), 'config.json');
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
        if (parsed === null || typeof parsed !== 'object') return {};
        return parsed as Partial<ResolvedConfig>;
    } catch (err) {
        // ENOENT is the normal case — no config file is fine. Anything else is
        // worth surfacing, because silently ignoring a malformed config is how
        // people end up on a backend they did not choose.
        const code = (err as NodeJS.ErrnoException | null)?.code;
        if (code !== 'ENOENT') {
            logger.warn(`ignoring unreadable config at ${path}`, { code });
        }
        return {};
    }
}

function parseStoreId(value: string | undefined): StoreSelection | undefined {
    if (value === undefined) return undefined;
    const v = value.trim().toLowerCase();
    if (v === 'file' || v === 'systemd-creds' || v === 'keyring' || v === 'auto') return v;
    logger.warn(`unknown store "${value}" — ignoring (valid: file, systemd-creds, keyring, auto)`);
    return undefined;
}

export function loadConfig(): ResolvedConfig {
    const file = readConfigFile();

    const store =
        parseStoreId(process.env.SN_CRED_STORE) ??
        parseStoreId(file.store as string | undefined) ??
        'auto';

    const blobPath = resolve(
        process.env.SN_CRED_STORE_PATH?.trim() ||
            (file.blobPath as string | undefined) ||
            join(stateDir(), 'credentials.json'),
    );

    // Deliberately NOT 'auto'. On this class of host `systemd-analyze has-tpm2`
    // reports partial/-firmware, so auto resolves to host today — but if a
    // firmware or kernel update later exposes a TPM, auto would silently start
    // producing TPM-bound blobs, and the next PCR change (kernel update, Secure
    // Boot toggle) makes them permanently undecryptable.
    const rawKey = (process.env.SN_CRED_STORE_KEY ?? (file.systemdKey as string | undefined) ?? 'host').trim();
    const systemdKey: ResolvedConfig['systemdKey'] =
        rawKey === 'tpm2' || rawKey === 'host+tpm2' ? rawKey : 'host';
    if (rawKey !== systemdKey) {
        logger.warn(`SN_CRED_STORE_KEY="${rawKey}" is not supported here — using "host"`);
    }

    const lockTimeoutRaw = Number(process.env.SN_CRED_STORE_LOCK_TIMEOUT_MS);
    const lockTimeoutMs =
        Number.isFinite(lockTimeoutRaw) && lockTimeoutRaw > 0
            ? lockTimeoutRaw
            : ((file.lockTimeoutMs as number | undefined) ?? 20_000);

    return {
        store,
        blobPath,
        systemdKey,
        allowPlaintext: envFlag('SN_CRED_STORE_ALLOW_PLAINTEXT') || file.allowPlaintext === true,
        lockTimeoutMs,
        disabled: envFlag('SN_CRED_STORE_DISABLE'),
    };
}

/** Path of the lockfile guarding mutations of the blob. */
export function lockPathFor(blobPath: string): string {
    return `${blobPath}.lock`;
}
