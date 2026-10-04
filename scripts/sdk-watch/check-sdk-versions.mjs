#!/usr/bin/env node
// Detect @servicenow/sdk-cli releases this shim has not reviewed yet.
//
// Usage: node scripts/sdk-watch/check-sdk-versions.mjs
// Exit 0 whatever it finds; read `action` in the JSON result:
//   "none"   - every published release newer than the allowlist is reviewed
//   "review" - `newVersions` lists releases to run review-sdk-version.mjs on
import { compareVersions, emit, isRelease, knownGoodVersions, log, newestOf, npmView } from './lib.mjs';

const published = (npmView('@servicenow/sdk-cli', 'versions') ?? []).filter(isRelease).sort(compareVersions);
const distTags = npmView('@servicenow/sdk-cli', 'dist-tags') ?? {};
const allowlisted = knownGoodVersions();
const newestAllowed = newestOf(allowlisted);
const oldestAllowed = [...allowlisted].sort(compareVersions)[0];

const newVersions = published.filter((v) => compareVersions(v, newestAllowed) > 0);
// Older releases deliberately left out (e.g. 4.9.1, 4.10.0). Reported, not actioned.
const gaps = published.filter((v) => compareVersions(v, oldestAllowed) >= 0
    && compareVersions(v, newestAllowed) < 0 && !allowlisted.includes(v));

// `now-sdk` is installed as @servicenow/sdk; confirm it still ships the sdk-cli of the
// same version, which is the copy the shim meets in a global install.
const sdkLatest = distTags.latest && npmView(`@servicenow/sdk@${distTags.latest}`, 'dependencies')?.['@servicenow/sdk-cli'];

log(`allowlisted through ${newestAllowed}; npm latest ${distTags.latest}; new: ${newVersions.join(', ') || 'none'}`);
emit({
    package: '@servicenow/sdk-cli',
    npmLatest: distTags.latest ?? null,
    allowlistedNewest: newestAllowed,
    allowlisted,
    newVersions,
    gaps,
    sdkLatestShipsSdkCli: sdkLatest ?? null,
    action: newVersions.length ? 'review' : 'none',
    next: newVersions.map((v) => `node scripts/sdk-watch/review-sdk-version.mjs ${v}`),
});
