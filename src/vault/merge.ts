/**
 * Three-way merge for credential keystores.
 *
 * This exists because of how the SDK writes. Every write path does:
 *
 *     const keyStore = (await getParsedCredentials()) ?? {};
 *     keyStore[alias] = ...;
 *     await keyChain.setPassword(JSON.stringify(keyStore));
 *
 * The SDK hands us a WHOLE keystore derived from a read that may be stale — or
 * that may have failed entirely, in which case it silently seeds from `{}`.
 * Persisting that blindly is the store-wipe bug.
 *
 * So we never take `incoming` at face value. We diff it against the base we
 * actually returned, then replay that intent onto whatever is current. A
 * concurrent refresh of a DIFFERENT alias is therefore never clobbered.
 *
 * A plain union would be wrong in the other direction: it would resurrect
 * aliases that `now-sdk auth --delete` legitimately removed. Hence a changeset,
 * not a merge of values.
 */
import { KeyStore, StoredCredential, isOAuthCred } from '../types.js';

export interface ChangeSet {
    added: string[];
    modified: string[];
    removed: string[];
}

/** What did the caller actually intend, relative to the base we gave them? */
export function diffKeyStores(base: KeyStore, incoming: KeyStore): ChangeSet {
    const baseKeys = new Set(Object.keys(base));
    const incomingKeys = new Set(Object.keys(incoming));

    const added: string[] = [];
    const modified: string[] = [];
    const removed: string[] = [];

    for (const key of incomingKeys) {
        if (!baseKeys.has(key)) {
            added.push(key);
        } else if (JSON.stringify(base[key]) !== JSON.stringify(incoming[key])) {
            modified.push(key);
        }
    }
    for (const key of baseKeys) {
        if (!incomingKeys.has(key)) removed.push(key);
    }

    return { added, modified, removed };
}

/**
 * Newer OAuth token wins.
 *
 * When two agents both refreshed the same alias, the one with the later
 * `expires_at` holds the token the server most recently issued. Persisting the
 * older one would guarantee a 401 on next use.
 */
function pickNewer(a: StoredCredential, b: StoredCredential): StoredCredential {
    if (isOAuthCred(a.creds) && isOAuthCred(b.creds)) {
        return b.creds.expires_at > a.creds.expires_at ? b : a;
    }
    return b;
}

/**
 * At most one entry may be `isDefault`. The SDK maintains this implicitly by
 * rewriting the whole map; since we rebuild it, we have to re-assert it or a
 * merge can produce two defaults and make `getDefaultCredentials()` arbitrary.
 */
export function normalizeDefaults(store: KeyStore, preferred?: string): KeyStore {
    const keys = Object.keys(store);
    if (keys.length === 0) return store;

    const defaults = keys.filter((k) => store[k]?.isDefault);
    if (defaults.length === 1 && (preferred === undefined || defaults[0] === preferred)) return store;

    const winner =
        (preferred !== undefined && store[preferred] ? preferred : undefined) ??
        defaults[0] ??
        keys[0];

    for (const k of keys) {
        const entry = store[k];
        if (entry) entry.isDefault = k === winner;
    }
    return store;
}

export interface MergeResult {
    merged: KeyStore;
    changes: ChangeSet;
    /** Aliases present in `current` that `incoming` would have dropped without intent. */
    protectedAliases: string[];
}

/**
 * Replay the caller's intent (base -> incoming) onto `current`.
 *
 * `allowRemovals` gates the destructive half. It is true only when the caller
 * genuinely asked to delete something (`sn-credstore delete`, `now-sdk auth
 * --delete`); for an OAuth refresh it is false, so a stale or failed read can
 * never express itself as "remove every other alias".
 */
export function mergeKeyStores(
    base: KeyStore,
    incoming: KeyStore,
    current: KeyStore,
    options: { allowRemovals?: boolean } = {},
): MergeResult {
    const allowRemovals = options.allowRemovals ?? false;
    const changes = diffKeyStores(base, incoming);
    const merged: KeyStore = { ...current };
    const protectedAliases: string[] = [];

    for (const alias of changes.added) {
        const entry = incoming[alias];
        if (!entry) continue;
        const existing = merged[alias];
        // Someone else added the same alias first — keep the newer token.
        merged[alias] = existing ? pickNewer(existing, entry) : entry;
    }

    for (const alias of changes.modified) {
        const entry = incoming[alias];
        if (!entry) continue;
        const existing = merged[alias];
        merged[alias] = existing ? pickNewer(existing, entry) : entry;
    }

    for (const alias of changes.removed) {
        if (allowRemovals) {
            delete merged[alias];
        } else {
            protectedAliases.push(alias);
        }
    }

    const preferred = Object.keys(incoming).find((k) => incoming[k]?.isDefault);
    return { merged: normalizeDefaults(merged, preferred), changes, protectedAliases };
}

/**
 * Would this write drop aliases we know exist, without asking to?
 *
 * This is the last line of defence against the SDK seeding a write from `{}`
 * after a failed read. Refusing is recoverable; a wipe is not.
 */
export function detectClobber(lastKnown: KeyStore | null, incoming: KeyStore): string[] {
    if (lastKnown === null) return [];
    const incomingKeys = new Set(Object.keys(incoming));
    return Object.keys(lastKnown).filter((k) => !incomingKeys.has(k));
}
