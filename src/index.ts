/**
 * Public API for @sonisoft/sn-credstore.
 *
 * Importing this module has NO side effects. Installing the SDK shim is an
 * explicit call (`installKeyChainShim`) or an explicit import of the
 * `./register` entry point — a library must never monkeypatch a global just
 * because someone imported it.
 */

export type {
    BasicCred,
    OAuthCred,
    Creds,
    StoredCredential,
    KeyStore,
} from './types.js';
export {
    isOAuthCred,
    isInRefreshWindow,
    parseKeyStore,
    serializeKeyStore,
    SDK_REFRESH_WINDOW_SEC,
    REFRESH_SKEW_SEC,
} from './types.js';

export {
    CredentialStoreError,
    StoreUnavailableError,
    StoreDecryptError,
    StoreCorruptError,
    LockTimeoutError,
    ReadOnlyStoreError,
    PlaintextNotPermittedError,
    ClobberRefusedError,
    ShimPreconditionError,
    isCredentialStoreError,
} from './errors.js';
export type { CredentialStoreErrorCode } from './errors.js';

export type { ICredentialStore, StoreReadResult } from './store/ICredentialStore.js';
export { FileStore } from './store/FileStore.js';
export { SystemdCredsStore } from './store/SystemdCredsStore.js';

export type { ResolvedConfig, StoreId, StoreSelection } from './config.js';
export { loadConfig, configDir, stateDir, lockPathFor, SYSTEMD_CRED_NAME } from './config.js';

export { redact, maskValue, sanitizeProcessError } from './redact.js';
export { logger } from './logger.js';
