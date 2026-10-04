#!/usr/bin/env node
// Mechanical part of the AGENTS.md review for a new @servicenow/sdk-cli release.
//
// Usage: node scripts/sdk-watch/review-sdk-version.mjs <version> [--baseline <version>] [--out <dir>]
//   --baseline  an allowlisted release to compare against (default: newest allowlisted below <version>)
//   --out       where to write diffs for a human/engineer to read (default: a kept temp dir)
//
// Verdicts (JSON `verdict`):
//   "identical"        nothing in dist/auth or the LazyCredential module changed
//   "seams-identical"  the patched seams are byte-identical or already-reviewed; other auth
//                      files changed but none touches credential storage. Read `reviewItems`.
//   "seams-changed"    a seam differs, a changed file touches credential storage, or a new
//                      keychain caller appeared. STOP: this needs a real code review before
//                      the allowlist can widen, and possibly shim changes.
// Exit 0 for any verdict; exit 1 only when the review itself could not run.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { compareVersions, emit, knownGoodVersions, log, npmPack, npmView, reviewedHashes, sha256, walk } from './lib.mjs';

const args = process.argv.slice(2);
const option = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};
const version = args.find((a, i) => !a.startsWith('--') && !['--baseline', '--out'].includes(args[i - 1]));
if (!version) {
    log('usage: review-sdk-version.mjs <version> [--baseline <version>] [--out <dir>]');
    process.exit(2);
}

const allowlisted = knownGoodVersions();
const baseline = option('--baseline')
    ?? allowlisted.filter((v) => compareVersions(v, version) < 0).sort(compareVersions).at(-1);
if (!baseline || !allowlisted.includes(baseline)) {
    emit({ version, verdict: 'error', error: `baseline ${baseline ?? '(none)'} is not an allowlisted release` }, 1);
}
const out = option('--out') ?? mkdtempSync(join(tmpdir(), `sdk-review-${version}-`));
const work = mkdtempSync(join(tmpdir(), 'sdk-review-pkgs-'));

// The files the shim patches or whose shape it relies on.
const SEAMS = [
    'dist/auth/keychain/index.js',
    'dist/auth/index.js',
    'dist/auth/OAuth/index.js',
    'dist/auth/index.d.ts',
    'dist/auth/keychain/index.d.ts',
];
// Anything that reads or writes stored credentials. A changed or new file matching this
// needs a human read even when the seams themselves are unchanged.
const CREDENTIAL_STORAGE = /\bKeyChain\b|keychain|storeCredentials|updateCredentials|removeCredentials|updateDefaultCredential|getParsedCredentials|setPassword|getPassword|deletePassword/;
// A new direct route to the keyring outside dist/auth would bypass the shim entirely.
const KEYCHAIN_CALLER = /\bKeyChain\b|@napi-rs\/keyring|require\(["'][^"']*keychain["']\)|getParsedCredentials/;

const diffs = [];
function writeDiff(label, a, b) {
    const target = join(out, `${label.replaceAll('/', '__')}.diff`);
    mkdirSync(dirname(target), { recursive: true });
    let text;
    try {
        text = execFileSync('diff', ['-u', a, b], { encoding: 'utf8' });
    } catch (err) {
        text = err.stdout ?? String(err);
    }
    writeFileSync(target, text);
    diffs.push(target);
    return target;
}

function scanKeychainCallers(pkgRoot, exclude) {
    return walk(join(pkgRoot, 'dist'))
        .filter((f) => f.endsWith('.js') && !(exclude && f.startsWith(exclude)))
        .filter((f) => KEYCHAIN_CALLER.test(readFileSync(join(pkgRoot, 'dist', f), 'utf8')));
}

try {
    log(`reviewing @servicenow/sdk-cli ${version} against ${baseline}`);
    const cand = npmPack(`@servicenow/sdk-cli@${version}`, join(work, 'cand'));
    const base = npmPack(`@servicenow/sdk-cli@${baseline}`, join(work, 'base'));
    const reviewed = reviewedHashes();
    const reasons = [];

    // 1. The seams.
    const seams = SEAMS.map((file) => {
        const c = sha256(join(cand, file));
        const b = sha256(join(base, file));
        let accepted = c !== null && c === b;
        if (file === 'dist/auth/index.js') accepted = reviewed.auth.includes(c);
        if (file === 'dist/auth/OAuth/index.js') accepted = reviewed.oauth.includes(c);
        if (!accepted) {
            reasons.push(`${file} differs from reviewed source`);
            writeDiff(`seam/${file}`, join(base, file), join(cand, file));
        }
        return { file, sha256: c, baselineSha256: b, sameAsBaseline: c === b, accepted };
    });

    // 2. Everything else under dist/auth.
    const baseFiles = new Set(walk(join(base, 'dist/auth')).filter((f) => !f.endsWith('.map')));
    const candFiles = new Set(walk(join(cand, 'dist/auth')).filter((f) => !f.endsWith('.map')));
    const authChanges = [];
    for (const f of [...new Set([...baseFiles, ...candFiles])].sort()) {
        const rel = `dist/auth/${f}`;
        if (SEAMS.includes(rel)) continue;
        const inBase = baseFiles.has(f);
        const inCand = candFiles.has(f);
        if (inBase && inCand && sha256(join(base, rel)) === sha256(join(cand, rel))) continue;
        const change = !inBase ? 'added' : !inCand ? 'removed' : 'changed';
        const touches = inCand && f.endsWith('.js') && CREDENTIAL_STORAGE.test(readFileSync(join(cand, rel), 'utf8'));
        if (touches) reasons.push(`${rel} (${change}) touches credential storage`);
        authChanges.push({
            file: rel,
            change,
            touchesCredentialStorage: touches,
            diff: writeDiff(`auth/${f}`, inBase ? join(base, rel) : '/dev/null', inCand ? join(cand, rel) : '/dev/null'),
        });
    }

    // 3. New routes to the keyring outside dist/auth, in sdk-cli and in @servicenow/sdk.
    const callers = {};
    const sdkCand = npmPack(`@servicenow/sdk@${version}`, join(work, 'sdk-cand'));
    const sdkBase = npmPack(`@servicenow/sdk@${baseline}`, join(work, 'sdk-base'));
    for (const [name, c, b, exclude] of [['@servicenow/sdk-cli', cand, base, 'auth/'], ['@servicenow/sdk', sdkCand, sdkBase, undefined]]) {
        const before = new Set(scanKeychainCallers(b, exclude));
        const added = scanKeychainCallers(c, exclude).filter((f) => !before.has(f));
        callers[name] = added;
        for (const f of added) reasons.push(`new keychain caller in ${name}: dist/${f}`);
    }

    // 4. auth/index.js consumes LazyCredential from @servicenow/sdk-api/credentials.
    const apiOf = (v) => npmView(`@servicenow/sdk-cli@${v}`, 'dependencies')?.['@servicenow/sdk-api'];
    const apiCand = apiOf(version);
    const apiBase = apiOf(baseline);
    let sdkApiCredentials = { candidate: apiCand ?? null, baseline: apiBase ?? null, changed: false };
    if (apiCand && apiBase && apiCand !== apiBase) {
        const ac = npmPack(`@servicenow/sdk-api@${apiCand}`, join(work, 'api-cand'));
        const ab = npmPack(`@servicenow/sdk-api@${apiBase}`, join(work, 'api-base'));
        const changed = sha256(join(ac, 'dist/credentials.js')) !== sha256(join(ab, 'dist/credentials.js'));
        sdkApiCredentials = { ...sdkApiCredentials, changed,
            diff: changed ? writeDiff('sdk-api/credentials.js', join(ab, 'dist/credentials.js'), join(ac, 'dist/credentials.js')) : undefined };
    }

    // 5. The global `now-sdk` must ship this same sdk-cli.
    const sdkShipsCli = npmView(`@servicenow/sdk@${version}`, 'dependencies')?.['@servicenow/sdk-cli'] ?? null;

    const reviewItems = [
        ...authChanges.map((c) => `${c.change}: ${c.file} — read ${c.diff}`),
        ...(sdkApiCredentials.changed ? [`changed: @servicenow/sdk-api dist/credentials.js — read ${sdkApiCredentials.diff}`] : []),
    ];
    const verdict = reasons.length ? 'seams-changed' : reviewItems.length ? 'seams-identical' : 'identical';
    log(`verdict: ${verdict}${reasons.length ? ` (${reasons.join('; ')})` : ''}`);
    emit({
        version,
        baseline,
        verdict,
        allowlistRecommended: verdict !== 'seams-changed',
        reasons,
        seams,
        authChanges,
        newKeychainCallers: callers,
        sdkApiCredentials,
        sdkShipsSdkCli: sdkShipsCli,
        reviewItems,
        artifacts: out,
        next: verdict === 'seams-changed'
            ? ['STOP: escalate for a manual review of the diffs in artifacts; do not allowlist']
            : [`node scripts/sdk-watch/allowlist-sdk-version.mjs ${version}`],
    });
} catch (err) {
    emit({ version, baseline, verdict: 'error', error: err.message }, 1);
}
