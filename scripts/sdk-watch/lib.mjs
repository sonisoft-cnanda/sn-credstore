// Shared helpers for the SDK upgrade routine (scripts/sdk-watch/*). Zero dependencies.
//
// Convention for every script in this directory: progress goes to stderr, and the
// final result is ONE JSON document on stdout, so an agent can parse it without
// scraping logs.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export function log(message) {
    process.stderr.write(`${message}\n`);
}

/** Print the result document and exit. */
export function emit(result, exitCode = 0) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(exitCode);
}

export const isRelease = (version) => /^\d+\.\d+\.\d+$/.test(version);

export function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) return pa[i] - pb[i];
    }
    return 0;
}

/** `npm view`; undefined when the package or version does not exist. */
export function npmView(spec, field) {
    try {
        const out = execFileSync('npm', ['view', spec, field, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return out.trim() ? JSON.parse(out) : undefined;
    } catch (err) {
        if (/E404/.test(String(err.stderr ?? err.message))) return undefined;
        throw err;
    }
}

/** `npm pack` a published package into `dir` and return the extracted package root. */
export function npmPack(spec, dir) {
    mkdirSync(dir, { recursive: true });
    const [packed] = JSON.parse(execFileSync('npm', ['pack', spec, '--json', '--pack-destination', dir],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    const target = join(dir, packed.filename.replace(/\.tgz$/, ''));
    mkdirSync(target, { recursive: true });
    execFileSync('tar', ['xzf', join(dir, packed.filename), '-C', target]);
    return join(target, 'package');
}

export function sha256(path) {
    try {
        return createHash('sha256').update(readFileSync(path)).digest('hex');
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
}

/** Every file under `root`, as paths relative to it. */
export function walk(root) {
    const files = [];
    const visit = (dir) => {
        for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            if (statSync(path).isDirectory()) visit(path);
            else files.push(relative(root, path));
        }
    };
    try {
        visit(root);
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
    return files.sort();
}

/** KNOWN_GOOD_VERSIONS as currently written in src/shim/locateSdkCli.ts. */
export function knownGoodVersions() {
    const source = readFileSync(join(repoRoot, 'src/shim/locateSdkCli.ts'), 'utf8');
    const match = source.match(/KNOWN_GOOD_VERSIONS = new Set\(\[([^\]]*)\]\)/);
    if (!match) throw new Error('KNOWN_GOOD_VERSIONS not found in src/shim/locateSdkCli.ts');
    return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** The auth/OAuth source hashes src/shim/patch.ts accepts. */
export function reviewedHashes() {
    const source = readFileSync(join(repoRoot, 'src/shim/patch.ts'), 'utf8');
    const set = (name) => {
        const match = source.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`));
        if (!match) throw new Error(`${name} not found in src/shim/patch.ts`);
        return [...match[1].matchAll(/'([0-9a-f]{64})'/g)].map((m) => m[1]);
    };
    return { auth: set('REVIEWED_AUTH_HASHES'), oauth: set('OAUTH_HASHES') };
}

export function newestOf(versions) {
    return [...versions].sort(compareVersions).at(-1);
}
