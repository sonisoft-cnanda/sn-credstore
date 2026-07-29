/**
 * Rewires the SDK's KeyChain onto our vault.
 *
 * Two things about the mechanism are easy to get wrong, and both were verified
 * empirically rather than assumed:
 *
 * 1. PATCH THE PROTOTYPE, NOT THE EXPORT. `dist/auth/index.js` does
 *    `const keyChain = new KeyChain(SERVICE)` at module scope. Replacing
 *    `exports.KeyChain` is a silent no-op whenever that module already loaded —
 *    the singleton captured the original class. Patching the prototype works
 *    regardless of load order, because the existing instance resolves its
 *    methods through it.
 *
 * 2. IT DOES NOT HAVE TO RUN FIRST. Because `_entry` is only constructed inside
 *    the method bodies we replace, @napi-rs/keyring's `Entry` is never
 *    constructed at all once patched — even if `dist/auth/index.js` loaded long
 *    before us. The real constraint is only "patch before the first credential
 *    call", which is a far weaker requirement than the load-order dance it looks
 *    like it needs.
 *
 * FAILING LOUDLY IS THE POINT. If the patch does not apply, the process falls
 * back to the OS keyring, gets a swallowed error, sees null, and the SDK's next
 * write wipes the store. That is destruction, not degradation — so an
 * unrecognised SDK version or a missing method aborts rather than continuing.
 */
import { createRequire } from 'node:module';
import { loadConfig, ResolvedConfig } from '../config.js';
import { logger } from '../logger.js';
import { ShimPreconditionError } from '../errors.js';
import { CredentialVault } from '../vault/CredentialVault.js';
import { createStore } from '../store/StoreFactory.js';
import {
    KEYCHAIN_PATH_RE,
    KNOWN_GOOD_VERSIONS,
    findSdkCliCandidates,
    findLoadedKeychainModules,
    versionForKeychainPath,
    moduleInternals,
} from './locateSdkCli.js';

/** Marks a prototype as already patched, so repeated installs are harmless. */
const SHIM_SYMBOL = Symbol.for('@sonisoft/sn-credstore.patched');

/** Set so downstream tools can assert the preload actually ran. */
export const PATCHED_ENV_VAR = 'NOW_SDK_KEYCHAIN_PATCHED';

interface KeyChainLike {
    prototype: {
        getPassword?: () => Promise<string | null>;
        setPassword?: (password: string) => Promise<void>;
        deletePassword?: () => Promise<boolean>;
        [SHIM_SYMBOL]?: boolean;
    };
}

export interface ShimHandle {
    patchedFiles: string[];
    uninstall: () => void;
}

let vaultSingleton: CredentialVault | null = null;

/** One vault per process — it holds the read baseline the clobber guard needs. */
function getVault(config: ResolvedConfig): CredentialVault {
    if (vaultSingleton === null) {
        vaultSingleton = new CredentialVault(createStore(config), {
            blobPath: config.blobPath,
            lockTimeoutMs: config.lockTimeoutMs,
        });
    }
    return vaultSingleton;
}

function assertPatchable(keychainPath: string, exported: KeyChainLike): void {
    const version = versionForKeychainPath(keychainPath);

    if (version !== null && !KNOWN_GOOD_VERSIONS.has(version)) {
        throw new ShimPreconditionError(
            `@servicenow/sdk-cli ${version} at ${keychainPath} has not been verified against this shim`,
            `The credential storage layer may have changed shape. Verify dist/auth/keychain/index.js still exposes ` +
                `getPassword/setPassword/deletePassword, then add "${version}" to KNOWN_GOOD_VERSIONS. ` +
                `To bypass temporarily (and fall back to the OS keyring): SN_CRED_STORE_DISABLE=1`,
        );
    }

    for (const method of ['getPassword', 'setPassword', 'deletePassword'] as const) {
        if (typeof exported.prototype?.[method] !== 'function') {
            throw new ShimPreconditionError(
                `KeyChain.prototype.${method} is missing at ${keychainPath}`,
                `The SDK's credential storage layer has changed. This shim must be updated before it can be used.`,
            );
        }
    }
}

function patchPrototype(keychainPath: string, moduleExports: unknown, config: ResolvedConfig): boolean {
    const exported = (moduleExports as { KeyChain?: KeyChainLike })?.KeyChain;
    if (exported?.prototype === undefined) return false;
    if (exported.prototype[SHIM_SYMBOL] === true) return false; // already ours

    assertPatchable(keychainPath, exported);

    const proto = exported.prototype;
    proto.getPassword = async function getPassword(): Promise<string | null> {
        return getVault(config).getPassword();
    };
    proto.setPassword = async function setPassword(password: string): Promise<void> {
        return getVault(config).setPassword(password);
    };
    proto.deletePassword = async function deletePassword(): Promise<boolean> {
        return getVault(config).deletePassword();
    };
    proto[SHIM_SYMBOL] = true;

    logger.debug(`patched KeyChain at ${keychainPath}`);
    return true;
}

/**
 * Install the shim.
 *
 * Idempotent. No-ops entirely when SN_CRED_STORE_DISABLE=1, which is the escape
 * hatch for diagnosing whether a problem is ours or the SDK's.
 */
export function installKeyChainShim(overrides: Partial<ResolvedConfig> = {}): ShimHandle {
    const config = { ...loadConfig(), ...overrides };

    if (config.disabled) {
        logger.debug('SN_CRED_STORE_DISABLE is set — leaving the OS keyring in place');
        return { patchedFiles: [], uninstall: () => {} };
    }

    const patchedFiles: string[] = [];

    // 1. Anything already loaded.
    for (const path of findLoadedKeychainModules()) {
        const cached = moduleInternals._cache?.[path] as { exports?: unknown } | undefined;
        if (cached?.exports && patchPrototype(path, cached.exports, config)) patchedFiles.push(path);
    }

    const originalLoad = moduleInternals._load;
    if (typeof originalLoad !== 'function') {
        throw new ShimPreconditionError(
            'Module._load is not available, so the SDK keychain cannot be intercepted',
            'This Node build is not supported. Report it with the output of `node --version`.',
        );
    }

    // 2. Anything loaded from here on. This is what handles the 2-4 copies per
    //    tree — resolving a single path would patch the wrong one about half the
    //    time. Fires for CJS-from-ESM too, since Node routes those through the
    //    CJS loader.
    const hooked = function patchedLoad(this: unknown, request: string, parent: unknown, isMain: boolean): unknown {
        const result = originalLoad.call(this ?? moduleInternals, request, parent, isMain);
        try {
            const resolved = moduleInternals._resolveFilename?.(request, parent, isMain);
            if (resolved !== undefined && KEYCHAIN_PATH_RE.test(resolved)) {
                if (patchPrototype(resolved, result, config)) patchedFiles.push(resolved);
            }
        } catch (err) {
            // A precondition failure must surface — silently continuing would
            // leave the process on the broken keyring path.
            if (err instanceof ShimPreconditionError) throw err;
            /* resolution failed for an unrelated request — not our concern */
        }
        return result;
    };
    moduleInternals._load = hooked;

    // 3. Eager sweep: force-load every resolvable copy so short-lived processes
    //    (and `doctor`) see a patched store without waiting for a lazy require.
    //    Legal because @servicenow/sdk-cli declares no `exports` map.
    for (const candidate of findSdkCliCandidates()) {
        try {
            createRequire(`${candidate.packageRoot}/`)(candidate.keychainPath);
        } catch (err) {
            if (err instanceof ShimPreconditionError) throw err;
            logger.debug(`eager load skipped for ${candidate.keychainPath}`);
        }
    }

    process.env[PATCHED_ENV_VAR] = '1';
    logger.debug(`shim installed (store: ${config.store}, path: ${config.blobPath})`);

    return {
        patchedFiles,
        uninstall: () => {
            moduleInternals._load = originalLoad;
        },
    };
}

/** For tests: drop the cached vault so a new config takes effect. */
export function resetVaultForTesting(): void {
    vaultSingleton = null;
}
