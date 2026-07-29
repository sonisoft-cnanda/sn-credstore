/**
 * Programmatic facade over the store and vault.
 *
 * Exists so that two front-ends — `sn-credstore` and `nex auth` — share one
 * implementation instead of each reaching for the vault directly and drifting.
 * Everything here returns data; nothing prints. Rendering belongs to the caller,
 * because oclif wants structured output and the zero-dep CLI wants plain text.
 *
 * Nothing here reveals a secret. `listAliases` returns metadata only, which is
 * what a `--json` flag ends up piping into a log file.
 */
import { ResolvedConfig, loadConfig } from './config.js';
import { createStore } from './store/StoreFactory.js';
import { CredentialVault } from './vault/CredentialVault.js';
import { KeyStore, parseKeyStore, serializeKeyStore } from './types.js';
import { normalizeDefaults } from './vault/merge.js';

/** Per-alias metadata, with every secret field omitted rather than masked. */
export interface AliasInfo {
    alias: string;
    isDefault: boolean;
    type: 'basic' | 'oauth';
    instanceUrl: string;
    /** basic only */
    username?: string;
    /** oauth only — UNIX seconds, matching the SDK's own units. */
    expiresAt?: number;
    /** oauth only. Expired is normal: the next use refreshes it. */
    expired?: boolean;
}

export interface StoreSummary {
    /** Backend id: 'file' | 'systemd-creds' | 'keyring'. */
    store: string;
    /** Human-readable backend description, including the encryption state. */
    description: string;
    path: string;
    aliases: AliasInfo[];
}

export function vaultFor(config: ResolvedConfig): CredentialVault {
    return new CredentialVault(createStore(config), {
        blobPath: config.blobPath,
        lockTimeoutMs: config.lockTimeoutMs,
    });
}

function toAliasInfo(store: KeyStore): AliasInfo[] {
    return Object.keys(store)
        .sort()
        .map((alias) => {
            const entry = store[alias]!;
            const creds = entry.creds;
            const base = {
                alias,
                isDefault: entry.isDefault,
                type: creds.type,
                instanceUrl: creds.instanceUrl,
            };
            return creds.type === 'basic'
                ? { ...base, username: creds.username }
                : {
                      ...base,
                      expiresAt: creds.expires_at,
                      // expires_at is SECONDS. Comparing it to Date.now()
                      // directly would report every token as expired.
                      expired: creds.expires_at * 1000 < Date.now(),
                  };
        }) as AliasInfo[];
}

/**
 * Read the store without taking the lock.
 *
 * Deliberately reads through the raw store rather than the vault: listing must
 * never trigger the refresh lease, or `nex auth list` would block behind a
 * concurrent agent's token refresh just to print a table.
 */
export async function listAliases(config: ResolvedConfig = loadConfig()): Promise<StoreSummary> {
    const store = createStore(config);
    const { blob } = await store.read();
    const parsed = blob === null ? {} : (parseKeyStore(blob) ?? {});

    return {
        store: store.id,
        description: store.describe(),
        path: config.blobPath,
        aliases: toAliasInfo(parsed),
    };
}

/** Set the default alias. Returns false if the alias does not exist. */
export async function setDefaultAlias(
    alias: string,
    config: ResolvedConfig = loadConfig(),
): Promise<boolean> {
    const vault = vaultFor(config);
    const blob = await vault.getPassword();
    const store = blob === null ? null : parseKeyStore(blob);
    if (store === null || store[alias] === undefined) return false;

    await vault.setPassword(serializeKeyStore(normalizeDefaults(store, alias)));
    return true;
}

/**
 * Remove one alias. Returns false if it does not exist.
 *
 * Goes through the vault's explicit removal intent — a delete is
 * indistinguishable from the store-wipe the clobber guard exists to prevent, so
 * without declaring intent the guard would (correctly) refuse it.
 */
export async function deleteAlias(
    alias: string,
    config: ResolvedConfig = loadConfig(),
): Promise<boolean> {
    const vault = vaultFor(config);
    const blob = await vault.getPassword();
    const store = blob === null ? null : parseKeyStore(blob);
    if (store === null || store[alias] === undefined) return false;

    const next = { ...store };
    delete next[alias];

    await vault.withRemovalIntent(async () => {
        // normalizeDefaults promotes a survivor when the default was the alias
        // just removed, so the SDK never sees a store with no default.
        await vault.setPassword(serializeKeyStore(normalizeDefaults(next)));
    });
    return true;
}

/** Remove every alias. */
export async function deleteAllAliases(config: ResolvedConfig = loadConfig()): Promise<void> {
    await vaultFor(config).deletePassword();
}
