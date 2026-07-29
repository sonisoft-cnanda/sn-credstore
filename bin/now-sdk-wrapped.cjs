#!/usr/bin/env node
/**
 * `now-sdk-x` — the vendor now-sdk CLI, backed by our credential store.
 *
 * Runs IN-PROCESS rather than spawning, which matters more than it looks:
 *   - `auth --add` drives inquirer in TTY raw mode, and `--password-stdin`
 *     reads process.stdin to EOF. A spawned child with piped stdio breaks both.
 *   - exit codes and signals pass through with no forwarding logic.
 *   - no ~40ms spawn tax on every invocation.
 *
 * Only argv[1] is rewritten, so yargs still renders `now-sdk` in help output
 * rather than a confusing wrapper path.
 *
 * This deliberately ships as a SEPARATE binary. Overwriting the npm-managed
 * `now-sdk` symlink would be silently clobbered by the next
 * `npm i -g @servicenow/sdk`, taking the shim with it and giving no error —
 * you would simply be back on the broken keyring without knowing.
 */
'use strict';

const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { realpathSync, existsSync } = require('node:fs');
const { dirname, resolve } = require('node:path');

require('../preload.cjs');

/** Locate the vendor @servicenow/sdk package root. */
function resolveVendorSdk() {
    // 1. Explicit override wins.
    if (process.env.SN_SDK_HOME) {
        const root = resolve(process.env.SN_SDK_HOME);
        if (existsSync(`${root}/package.json`)) return root;
        fail(`SN_SDK_HOME=${process.env.SN_SDK_HOME} does not look like a package root`);
    }

    // 2. Normal resolution from here and from cwd.
    for (const base of [__dirname, process.cwd()]) {
        try {
            return dirname(createRequire(`${base}/`).resolve('@servicenow/sdk/package.json'));
        } catch {
            /* not visible from this base */
        }
    }

    // 3. The global install, via npm root -g.
    try {
        const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
        const candidate = `${globalRoot}/@servicenow/sdk`;
        if (existsSync(`${candidate}/package.json`)) return candidate;
    } catch {
        /* npm not available */
    }

    // 4. Follow the now-sdk binary on PATH back to its package.
    try {
        const binPath = realpathSync(
            execFileSync('sh', ['-c', 'command -v now-sdk'], { encoding: 'utf8' }).trim(),
        );
        // <pkg>/bin/index.js -> <pkg>
        const candidate = dirname(dirname(binPath));
        if (existsSync(`${candidate}/package.json`)) return candidate;
    } catch {
        /* not on PATH */
    }

    fail(
        'could not locate @servicenow/sdk.\n' +
            '  Install it (npm i -g @servicenow/sdk) or set SN_SDK_HOME to its package root.',
    );
}

function fail(message) {
    process.stderr.write(`[now-sdk-x] ${message}\n`);
    process.exit(1);
}

const sdkRoot = resolveVendorSdk();
const vendorBin = `${sdkRoot}/bin/index.js`;

if (!existsSync(vendorBin)) {
    fail(`found @servicenow/sdk at ${sdkRoot} but ${vendorBin} is missing`);
}

// Keep yargs' $0 identical to the real CLI so help/usage text is unchanged.
process.argv[1] = vendorBin;

/**
 * Make the vendor bin the actual MAIN module, not merely a required one.
 *
 * Rewriting argv[1] alone is not enough: yargs' `.version()` resolves the
 * nearest package.json from the *main module's* directory. Left as-is, the main
 * module is this wrapper, so `now-sdk-x --version` reported sn-credstore's
 * version instead of the SDK's — quietly wrong, and exactly the kind of thing
 * that sends someone debugging the wrong package.
 *
 * Constructing the Module and marking it main is what Node itself does for an
 * entry point, so version/help resolution behaves identically to `now-sdk`.
 */
const Module = require('node:module');

const vendorModule = new Module(vendorBin, null);
vendorModule.filename = vendorBin;
vendorModule.paths = Module._nodeModulePaths(dirname(vendorBin));

process.mainModule = vendorModule;
Module._cache[vendorBin] = vendorModule;

vendorModule.load(vendorBin);
