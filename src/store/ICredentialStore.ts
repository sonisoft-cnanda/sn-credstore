/**
 * A store is WHERE the credential blob lives. It knows nothing about aliases,
 * OAuth, or refresh.
 *
 * Keep that boundary strict. The other axis is the auth *provider* (how a Creds
 * is minted and renewed — basic, code grant, client credentials). Conflating
 * "where secrets live" with "how secrets are obtained" is the usual way these
 * two abstractions rot into one another.
 *
 * The interface is blob-level (string in, string out) rather than alias-level
 * because it maps 1:1 onto the SDK's `KeyChain` — which stores every alias as a
 * single JSON string — and so preserves the SDK's own read-modify-write
 * semantics without us reimplementing them.
 */

export interface StoreReadResult {
    /** The raw blob, or null when nothing is stored. Null must mean EMPTY, never FAILED. */
    blob: string | null;
    /** Opaque CAS token; pass back to `write` to detect concurrent modification. */
    version: string | null;
}

export interface ICredentialStore {
    readonly id: 'file' | 'systemd-creds' | 'keyring';

    /** False for the keyring backend, which we use only to import/export. */
    readonly writable: boolean;

    /**
     * Cheap capability probe. MUST NOT throw, and must not prompt — the keyring
     * backend can otherwise hang on a wallet dialog and wedge `doctor`.
     */
    isAvailable(): Promise<boolean>;

    /**
     * Read the blob.
     *
     * Contract that matters: THROW on failure, return `{blob: null}` only when
     * the store is genuinely empty. Collapsing failure into null is precisely
     * the SDK bug we exist to fix — it makes a locked keyring look like "no
     * credentials", and the caller's next write then wipes everything.
     */
    read(): Promise<StoreReadResult>;

    /** Persist a blob. `expected` enables optimistic concurrency; returns the new version. */
    write(blob: string, expected?: string | null): Promise<string>;

    /** Remove the stored blob. Returns false when there was nothing to remove. */
    delete(): Promise<boolean>;

    /** Human-readable description for `doctor` and error messages. */
    describe(): string;
}
