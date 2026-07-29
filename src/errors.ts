/**
 * Every error carries a `remediation` string.
 *
 * This exists because of the exact UX failure we are fixing: the SDK's
 * `KeyChain.getPassword` swallows all errors and returns null, so a locked
 * keyring, a missing D-Bus session, and a genuinely empty store are
 * indistinguishable — all three surface as
 * "Default Credential has not been set". Never reproduce that.
 */

export type CredentialStoreErrorCode =
    | 'STORE_UNAVAILABLE'
    | 'STORE_DECRYPT_FAILED'
    | 'STORE_CORRUPT'
    | 'LOCK_TIMEOUT'
    | 'READ_ONLY_STORE'
    | 'PLAINTEXT_NOT_PERMITTED'
    | 'CLOBBER_REFUSED'
    | 'SHIM_PRECONDITION_FAILED';

export class CredentialStoreError extends Error {
    readonly code: CredentialStoreErrorCode;
    readonly remediation: string;
    readonly storeId: string | undefined;

    constructor(
        code: CredentialStoreErrorCode,
        message: string,
        remediation: string,
        options: { storeId?: string; cause?: unknown } = {},
    ) {
        super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = new.target.name;
        this.code = code;
        this.remediation = remediation;
        this.storeId = options.storeId;
    }

    override toString(): string {
        return `${this.name}: ${this.message}\n\nRemediation: ${this.remediation}`;
    }
}

/** The selected backend cannot be used at all (binary missing, socket absent, …). */
export class StoreUnavailableError extends CredentialStoreError {
    constructor(message: string, remediation: string, options: { storeId?: string; cause?: unknown } = {}) {
        super('STORE_UNAVAILABLE', message, remediation, options);
    }
}

/** The blob exists but could not be decrypted — usually a changed host/uid/name binding. */
export class StoreDecryptError extends CredentialStoreError {
    constructor(message: string, remediation: string, options: { storeId?: string; cause?: unknown } = {}) {
        super('STORE_DECRYPT_FAILED', message, remediation, options);
    }
}

/** Decrypted fine but is not a valid keystore. Never hand this to the SDK. */
export class StoreCorruptError extends CredentialStoreError {
    constructor(message: string, remediation: string, options: { storeId?: string; cause?: unknown } = {}) {
        super('STORE_CORRUPT', message, remediation, options);
    }
}

export class LockTimeoutError extends CredentialStoreError {
    constructor(message: string, remediation: string, options: { storeId?: string; cause?: unknown } = {}) {
        super('LOCK_TIMEOUT', message, remediation, options);
    }
}

/** Attempted a write against the keyring backend, which we only ever read. */
export class ReadOnlyStoreError extends CredentialStoreError {
    constructor(message: string, remediation: string, options: { storeId?: string; cause?: unknown } = {}) {
        super('READ_ONLY_STORE', message, remediation, options);
    }
}

/**
 * An encrypted backend was requested but is unavailable, and falling back to
 * plaintext was not explicitly permitted. We refuse rather than silently
 * downgrading — a silent downgrade to plaintext is the kind of thing nobody
 * notices until it matters.
 */
export class PlaintextNotPermittedError extends CredentialStoreError {
    constructor(message: string, remediation: string, options: { storeId?: string; cause?: unknown } = {}) {
        super('PLAINTEXT_NOT_PERMITTED', message, remediation, options);
    }
}

/**
 * A write would have removed aliases that were present in the last good read,
 * without an explicit delete having been requested.
 *
 * This is the guard against the SDK's read-modify-write pattern: it seeds every
 * write from `(await getParsedCredentials()) ?? {}`, so a single transient read
 * failure followed by any write silently replaces the whole store with one alias.
 */
export class ClobberRefusedError extends CredentialStoreError {
    constructor(message: string, remediation: string, options: { storeId?: string; cause?: unknown } = {}) {
        super('CLOBBER_REFUSED', message, remediation, options);
    }
}

/** The shim's assumptions about the installed SDK no longer hold. Fail loudly. */
export class ShimPreconditionError extends CredentialStoreError {
    constructor(message: string, remediation: string, options: { storeId?: string; cause?: unknown } = {}) {
        super('SHIM_PRECONDITION_FAILED', message, remediation, options);
    }
}

export function isCredentialStoreError(err: unknown): err is CredentialStoreError {
    return err instanceof CredentialStoreError;
}
