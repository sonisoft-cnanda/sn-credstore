/**
 * These types mirror `@servicenow/sdk-cli`'s auth types EXACTLY. Do not "improve"
 * them — the whole design depends on us being able to hand the SDK back a blob it
 * produced, byte-compatibly. Source of truth:
 *   node_modules/@servicenow/sdk-cli/dist/auth/index.d.ts
 *
 * Verified against @servicenow/sdk-cli 4.9.2 and 4.9.0 (auth dist is byte-identical
 * between them).
 */

/** Basic auth. Note the password is stored in CLEARTEXT inside the blob. */
export interface BasicCred {
    instanceUrl: string;
    type: 'basic';
    username: string;
    password: string;
}

export interface OAuthCred {
    instanceUrl: string;
    type: 'oauth';
    access_token: string;
    token_type: string;
    refresh_token: string;
    /**
     * UNIX **SECONDS**, not milliseconds.
     *
     * A units slip here is not cosmetic: the SDK refreshes when
     * `expires_at - now <= 15 * 60`. Milliseconds make that always false
     * (silent 401s once the token really expires); a value in the past makes it
     * always true (a refresh storm across every agent).
     */
    expires_at: number;
}

export type Creds = BasicCred | OAuthCred;

/** One alias entry as the SDK stores it. */
export interface StoredCredential {
    isDefault: boolean;
    alias: string;
    creds: Creds;
}

/**
 * The entire store: a single JSON object keyed by alias, serialized to one
 * string and handed to `KeyChain.setPassword`.
 *
 * Cross-entry invariant the SDK maintains implicitly: AT MOST ONE entry has
 * `isDefault === true`. Any merge must re-assert it.
 */
export type KeyStore = Record<string, StoredCredential>;

/** How long before expiry the SDK decides to refresh. Mirrors dist/auth/OAuth/index.js. */
export const SDK_REFRESH_WINDOW_SEC = 15 * 60;

/** Extra margin so we take the refresh lease slightly before the SDK would act. */
export const REFRESH_SKEW_SEC = 60;

export function isOAuthCred(creds: Creds): creds is OAuthCred {
    return creds.type === 'oauth';
}

/** True when the SDK would attempt a refresh for this credential right now. */
export function isInRefreshWindow(creds: Creds, nowSec: number = Math.floor(Date.now() / 1000)): boolean {
    if (!isOAuthCred(creds)) return false;
    return creds.expires_at - nowSec <= SDK_REFRESH_WINDOW_SEC + REFRESH_SKEW_SEC;
}

/**
 * Parse a raw blob into a KeyStore, or return null if it is not a usable store.
 *
 * Deliberately strict: returning a malformed object would make the SDK's own
 * `JSON.parse` throw a bare SyntaxError from inside its auth path, which is far
 * harder to diagnose than us reporting it.
 */
export function parseKeyStore(blob: string): KeyStore | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(blob);
    } catch {
        return null;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    for (const value of Object.values(parsed as Record<string, unknown>)) {
        if (value === null || typeof value !== 'object') return null;
        const entry = value as Partial<StoredCredential>;
        if (typeof entry.alias !== 'string') return null;
        if (entry.creds === null || typeof entry.creds !== 'object') return null;
        const type = (entry.creds as Partial<Creds>).type;
        if (type !== 'basic' && type !== 'oauth') return null;
    }
    return parsed as KeyStore;
}

/** Serialize exactly the way the SDK does, so round-trips are byte-stable. */
export function serializeKeyStore(store: KeyStore): string {
    return JSON.stringify(store);
}
