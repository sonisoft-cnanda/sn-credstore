/**
 * Finding the @servicenow/sdk-cli copies that matter.
 *
 * There are typically 2-4 installs reachable from any given process:
 *   <repo>/node_modules/@servicenow/sdk-cli
 *   <repo>/node_modules/@sonisoft/now-sdk-ext-core/node_modules/@servicenow/sdk-cli
 *   ~/.nodenv/.../@servicenow/sdk/node_modules/@servicenow/sdk-cli
 *   ~/.nodenv/.../@sonisoft/now-sdk-ext-cli/node_modules/@servicenow/sdk-cli
 *
 * Resolving one path from a guessed base patches the wrong copy roughly half the
 * time — which is worse than not patching at all, because the process then falls
 * back to the broken keyring and the first write wipes the store. Hence the
 * Module._load hook in patch.ts; this module only supplies best-effort eager
 * candidates and the diagnostics for `doctor`.
 */
import Module, { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * This file is compiled to BOTH ESM and CJS, so the bare `require`,
 * `require.cache` and `require.main` globals are off-limits — they are undefined
 * in the ESM build. Everything goes through the `node:module` API, which behaves
 * identically under both.
 */
interface ModuleInternals {
    _cache?: Record<string, unknown>;
    _resolveFilename?: (request: string, parent: unknown, isMain: boolean) => string;
    _load?: (request: string, parent: unknown, isMain: boolean) => unknown;
}

export const moduleInternals = Module as unknown as ModuleInternals;

export const KEYCHAIN_SUBPATH = '@servicenow/sdk-cli/dist/auth/keychain/index.js';

/** Matches the keychain module regardless of which node_modules tree it is in. */
export const KEYCHAIN_PATH_RE = /@servicenow[/\\]sdk-cli[/\\]dist[/\\]auth[/\\]keychain[/\\]index\.js$/;

/**
 * Versions whose keychain shape we have actually inspected.
 *
 * Deliberately an allowlist rather than a range: the patch replaces method
 * bodies wholesale, so an unreviewed version could change semantics under us
 * without any signal. Better to refuse and be told than to silently mispatch.
 */
export const KNOWN_GOOD_VERSIONS = new Set(['4.9.0', '4.9.2']);

export interface SdkCliCandidate {
    keychainPath: string;
    packageRoot: string;
    version: string | null;
}

function versionOfPackageAt(keychainPath: string): { root: string; version: string | null } {
    // dist/auth/keychain/index.js -> up four levels is the package root
    const root = dirname(dirname(dirname(dirname(keychainPath))));
    try {
        const pkg = JSON.parse(readFileSync(`${root}/package.json`, 'utf8')) as { version?: string };
        return { root, version: pkg.version ?? null };
    } catch {
        return { root, version: null };
    }
}

/**
 * Best-effort eager discovery. Legal because @servicenow/sdk-cli declares no
 * `exports` map, so deep requires resolve normally.
 *
 * Every resolution is individually guarded — a base that cannot see the package
 * is the common case, not an error.
 */
export function findSdkCliCandidates(extraBases: string[] = []): SdkCliCandidate[] {
    const bases = new Set<string>([process.cwd(), ...extraBases]);

    if (process.argv[1]) bases.add(dirname(process.argv[1]));

    const found = new Map<string, SdkCliCandidate>();
    for (const base of bases) {
        try {
            const req = createRequire(base.endsWith('/') ? base : `${base}/`);
            const keychainPath = req.resolve(KEYCHAIN_SUBPATH);
            if (!found.has(keychainPath)) {
                const { root, version } = versionOfPackageAt(keychainPath);
                found.set(keychainPath, { keychainPath, packageRoot: root, version });
            }
        } catch {
            /* this base cannot see the package — expected */
        }
    }
    return [...found.values()];
}

/** Copies already in the CJS module cache, which the eager sweep must also patch. */
export function findLoadedKeychainModules(): string[] {
    return Object.keys(moduleInternals._cache ?? {}).filter((p) => KEYCHAIN_PATH_RE.test(p));
}

export function versionForKeychainPath(keychainPath: string): string | null {
    return versionOfPackageAt(keychainPath).version;
}
