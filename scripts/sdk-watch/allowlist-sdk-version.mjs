#!/usr/bin/env node
// Widen KNOWN_GOOD_VERSIONS to reviewed @servicenow/sdk-cli releases, with every edit the
// previous version-support commits made by hand.
//
// Usage: node scripts/sdk-watch/allowlist-sdk-version.mjs <version> [<version> ...] [--skip-review]
//
// Runs review-sdk-version.mjs for each version first and refuses unless the verdict is
// "identical" or "seams-identical". --skip-review exists for a human who has done the
// review by hand (e.g. after adding new reviewed hashes); agents must not pass it.
//
// Edits: src/shim/locateSdkCli.ts (set + review note), src/types.ts, README.md,
// test/unit/shim/assertPatchable.test.ts (exact list), test/unit/shim/realPackage.test.ts
// (published package the integration test installs). Does not commit or run tests.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareVersions, emit, isRelease, knownGoodVersions, log, newestOf, npmView, repoRoot } from './lib.mjs';

const args = process.argv.slice(2);
const skipReview = args.includes('--skip-review');
const versions = args.filter((a) => !a.startsWith('--'));
if (!versions.length) {
    log('usage: allowlist-sdk-version.mjs <version> [<version> ...] [--skip-review]');
    process.exit(2);
}

const current = knownGoodVersions();
const reviews = [];
for (const version of versions) {
    if (!isRelease(version)) emit({ ok: false, error: `${version} is not a release version` }, 1);
    if (current.includes(version)) emit({ ok: false, error: `${version} is already allowlisted` }, 1);
    if (npmView(`@servicenow/sdk-cli@${version}`, 'version') !== version) {
        emit({ ok: false, error: `@servicenow/sdk-cli@${version} is not published` }, 1);
    }
    if (skipReview) {
        reviews.push({ version, verdict: 'skipped-by-operator' });
        continue;
    }
    log(`reviewing ${version}...`);
    let review;
    try {
        review = JSON.parse(execFileSync(process.execPath, [join(repoRoot, 'scripts/sdk-watch/review-sdk-version.mjs'), version],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
    } catch (err) {
        emit({ ok: false, error: `review of ${version} failed to run: ${err.message}` }, 1);
    }
    reviews.push({ version, verdict: review.verdict, baseline: review.baseline, reviewItems: review.reviewItems, artifacts: review.artifacts });
    if (!review.allowlistRecommended) {
        emit({ ok: false, error: `${version}: verdict ${review.verdict}; not allowlisting`, reasons: review.reasons, reviews }, 1);
    }
}

const allowlisted = [...new Set([...current, ...versions])].sort(compareVersions);
const newest = newestOf(allowlisted);
const edited = [];
function edit(file, transform) {
    const path = join(repoRoot, file);
    const before = readFileSync(path, 'utf8');
    const after = transform(before);
    if (after === before) throw new Error(`${file}: expected text not found; edit it by hand`);
    writeFileSync(path, after);
    edited.push(file);
}
const quoted = allowlisted.map((v) => `'${v}'`).join(', ');

try {
    edit('src/shim/locateSdkCli.ts', (s) => {
        let out = s.replace(/KNOWN_GOOD_VERSIONS = new Set\(\[[^\]]*\]\)/, `KNOWN_GOOD_VERSIONS = new Set([${quoted}])`);
        out = out.replace(/every listed release through \d+\.\d+\.\d+ is byte-identical/, `every listed release through ${newest} is byte-identical`);
        const notes = reviews.map((r) => ` * ${r.version}: ${r.verdict === 'skipped-by-operator'
            ? 'reviewed by hand'
            : `seams match ${r.baseline} (scripts/sdk-watch/review-sdk-version.mjs: ${r.verdict})`}.\n`).join('');
        return out.replace(/( \* The registry never published)/, `${notes}$1`);
    });
    edit('src/types.ts', (s) => s.replace(/Verified through @servicenow\/sdk-cli \d+\.\d+\.\d+/, `Verified through @servicenow/sdk-cli ${newest}`));
    edit('README.md', (s) => s.replace(/Supported exact `@servicenow\/sdk-cli` versions are[\s\S]*?audited source of truth\./, () => {
        const list = allowlisted.map((v) => `\`${v}\``);
        const sentence = `Supported exact \`@servicenow/sdk-cli\` versions are ${list.slice(0, -1).join(', ')}, and ${list.at(-1)}. `
            + 'The shim intentionally fails closed for unreviewed versions; `KNOWN_GOOD_VERSIONS` in '
            + '`src/shim/locateSdkCli.ts` is the audited source of truth.';
        const lines = [];
        let line = '';
        for (const word of sentence.split(' ')) {
            if (line && `${line} ${word}`.length > 80) {
                lines.push(line);
                line = word;
            } else {
                line = line ? `${line} ${word}` : word;
            }
        }
        return [...lines, line].join('\n');
    }));
    edit('test/unit/shim/assertPatchable.test.ts', (s) => s.replace(/expect\(\[\.\.\.KNOWN_GOOD_VERSIONS\]\)\.toEqual\(\[[^\]]*\]\)/,
        `expect([...KNOWN_GOOD_VERSIONS]).toEqual([${quoted}])`));
    // The real-package test installs one published release; keep it on the newest.
    if (!readFileSync(join(repoRoot, 'test/unit/shim/realPackage.test.ts'), 'utf8').includes(`@servicenow/sdk-cli@${newest}'`)) {
        edit('test/unit/shim/realPackage.test.ts', (s) => s.replaceAll(/'@servicenow\/sdk-cli@\d+\.\d+\.\d+'/g, `'@servicenow/sdk-cli@${newest}'`));
    }
} catch (err) {
    emit({ ok: false, error: err.message, edited, reviews }, 1);
}

log(`allowlisted ${versions.join(', ')}; newest now ${newest}`);
emit({
    ok: true,
    added: versions,
    allowlisted,
    newest,
    edited,
    reviews,
    next: [
        'npm run lint && npm run build && npm test   (with SN_CRED_STORE_PATH pointed at a temp file)',
        `scripts/sdk-watch/qa-sdk-version.sh ${versions.join(' ')}`,
        `commit as: feat: support ServiceNow SDK ${versions.join(' and ')}`,
    ],
});
