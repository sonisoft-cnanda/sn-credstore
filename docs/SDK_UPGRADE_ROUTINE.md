# ServiceNow SDK upgrade routine

Runbook for a scheduled agent routine that notices new `@servicenow/sdk` releases, has them
QA'd, and rolls them through our four packages when QA passes. The same overview opens this
document in every repo; the second half is specific to this repo.

## Why there is a chain at all

`@sonisoft/sn-credstore` patches the SDK's credential storage. It **fails closed** on any
`@servicenow/sdk-cli` release it has not reviewed, and it checks every copy it can find,
including the one behind a globally installed `now-sdk`. So when someone runs
`npm i -g @servicenow/sdk` and gets a new release, every `--cred-store` consumer on that
machine stops working (`… has not been verified against this shim`) until sn-credstore
allowlists that release and the consumers pick up the new sn-credstore. Nothing is broken
in our code; the shim is refusing an unreviewed release on purpose. The routine's job is to
make that window short.

```
@servicenow/sdk X.Y.Z on npm
  1. sn-credstore         detect -> review seams -> allowlist -> QA -> PR -> merge -> npm   (feat:)
  2. now-sdk-ext-core     raise sn-credstore floor (+ optionally SDK pins) -> QA -> PR -> npm (fix(deps):)
  3. now-sdk-ext-cli  }   bump core / sn-credstore (+ optionally SDK pins) -> QA -> PR -> npm (fix(deps):)
     now-sdk-ext-mcp  }   (separate repos: may run in parallel)
  4. hosts                reinstall global `nex`; MCP clients restart/reinstall
```

Each step starts only after the previous package is **visible on npm** (`watch-release.sh`).

## Roles

| Role | Does | Never |
|---|---|---|
| Engineer agent | runs the check/review/bump scripts, edits, opens PRs, answers review notes, merges after QA passes, watches the release | merges with failing QA or CI; allowlists past a `seams-changed` verdict |
| QA agent | `gh pr checkout <n>`, runs this repo's QA script, posts the JSON summary on the PR, approves or rejects | edits code; runs live checks against production |

## Rules for every repo

- **Production is off limits.** Live checks need `SN_INSTANCE_ALIAS` set to a PDI/dev alias.
  They only read and run `gs.info()` scripts, except core's `--integration`, which creates and
  deletes test records.
- **Never print or commit a secret.** Use `SN_CRED_STORE=file` for live checks. Every QA script
  uses throwaway stores for anything it writes.
- **One merge at a time per repo.** `release.yml` has no concurrency guard. Merge, run
  `watch-release.sh <merge-sha>`, and only then merge the next PR in that repo.
- **PR titles are conventional commits.** `main` only allows squash merges, and the squash
  commit takes the PR title, which semantic-release reads: `feat:` is a minor release,
  `fix:`/`fix(deps):` a patch, and `chore:`/`docs:`/`test:` no release.
- **Stop and escalate to a human** on any of these:
  - a sn-credstore review verdict of `seams-changed` or `error`
  - QA that fails twice for the same reason
  - a blocking review comment you cannot resolve
  - a `watch-release.sh` failure at the `publish` stage

## Script conventions

All scripts live in `scripts/sdk-watch/`.
- Progress goes to **stderr**, and the result is **one JSON document on stdout**.
- `check` scripts exit 0 and describe what is due in `action`/`actions` plus `next` (exact
  commands to run). QA scripts exit 0 only when every step passed. Exit 2 means bad usage.

Host prerequisites:
- Node >= 26, npm, `tar`, `diff`, `gh` (authenticated with push access to the four repos)
- `keyctl` (package `keyutils`) for sn-credstore's headless ladder
- network access to npm
- for live checks only: `SN_CRED_STORE=file` with the alias stored in the sn-credstore file
  store, and `SN_INSTANCE_ALIAS`
- optional: `QA_APP_SCOPE` (a `sys_app` scope on that instance) and `QA_STORE_APP_SCOPE` (a
  `sys_store_app` scope), so the live checks also cover both kinds of app

## Pitfalls we have already hit

- **Green is not published.** A publish job also succeeds when it *skips* an existing version.
  `watch-release.sh` checks the log for `+ <pkg>@<version>`.
- **npm lags.** A new version took 1.5–3.5 minutes to appear. Poll rather than fail.
- **The automated `claude-review` check can fail on its own.** If it fails with
  `Claude execution failed: result is_error:true`, the run crashed rather than reviewed:
  `gh run rerun <run-id> --failed`. Notes it leaves on a passing run are non-blocking unless
  it says otherwise.
- **The SDK logger writes to stdout.** Lines like `[now-sdk] Access Token has expired,
  refreshing token` go to stdout by default. Our scripts redirect them. This corrupts an MCP
  server's JSON-RPC stream, which `stdio-smoke.mjs` checks for.
- **A global `now-sdk` changes behaviour.** QA simulates a global SDK of a given version
  through `NODE_PATH` (sn-credstore searches it) instead of touching the real global install.
- **SDK packages move in lockstep.** `sdk`, `sdk-cli`, `sdk-core`, `sdk-build-core` and
  `sdk-api` share one version. `@servicenow/sdk-cli-core` has its own line, and its `latest`
  tag can lag.
- **Global is only identifiable by its sys_id.** In `sys_scope`, `scope=global` matches every
  global-scoped app. `source=global` also matches apps that now-sdk deployed into global (two on
  one PDI). Script output (`Script completed in scope global`, `rhino.global`) looks identical
  for Global and for those apps, so the live checks assert the sys_id actually sent (`global`).
- **Telemetry.** SDK 4.12+ ships `posthog-node` under `sdk-build-core`. Nothing in our runtime
  loads it, and `NO_TELEMETRY=1` disables it; the MCP stdio smoke asserts it stays unloaded.

---

## This repo: sn-credstore (step 1, the gate)

Read [`AGENTS.md`](../AGENTS.md) first. It holds live OAuth refresh tokens, and its hard rules
apply to the routine too.

| Script | Who | Purpose |
|---|---|---|
| `check-sdk-versions.mjs` | engineer | Published `@servicenow/sdk-cli` releases newer than `KNOWN_GOOD_VERSIONS` (`newVersions`); `action: review` when any. |
| `review-sdk-version.mjs <v> [--baseline <v>] [--out <dir>]` | engineer | The mechanical part of the AGENTS.md review: seam hashes vs reviewed sets, `dist/auth` tree diff, new keychain callers in `sdk-cli` and `sdk`, `sdk-api` `LazyCredential` diff. Writes diffs to `artifacts`. |
| `allowlist-sdk-version.mjs <v> [...]` | engineer | Re-runs the review and refuses unless it allows widening; then makes every allowlist edit (set + review note, `types.ts`, README, exact-list test, real-package test version). |
| `qa-sdk-version.sh <v> [...]` | QA | lint, build, full suite (sandboxed store), then per version against that exact SDK: headless ladder rungs 1–2, OAuth refresh rotation, 20-process contention. |
| `watch-release.sh <merge-sha>` | engineer | release run → version → real publish → visible on npm. |

Existing scripts it builds on: `scripts/headless-candidates.sh`, `scripts/verify-oauth-refresh.mjs`,
`scripts/verify-auth-contention.mjs`, and `npm run test:eval`.

### Review verdicts

| `verdict` | Meaning | Routine does |
|---|---|---|
| `identical` | nothing in `dist/auth` or `LazyCredential` changed | allowlist |
| `seams-identical` | the patched seams are byte-identical or already reviewed; other auth files changed but none touches credential storage | the engineer reads every `reviewItems` diff and states in the PR what changed and why it is safe, then allowlists |
| `seams-changed` | a seam differs, a changed file touches credential storage, or a new keychain caller appeared | **stop**: open an issue with `reasons` and the `artifacts` diffs for a human review. Widening may need new reviewed hashes in `src/shim/patch.ts` and `test/unit/shim/refresh.test.ts`, or shim changes. |

For calibration: 4.13.0/4.13.3 came out `seams-identical` (MFA prompt in `basic-auth/UISession.js`,
a `sdk-api` refactor). 4.12.0 would be `seams-changed`, because `auth/index.d.ts` gained
`credentialProvider`; that release did need a real review.

### Engineer steps

1. Detect:
   ```bash
   git switch main && git pull
   node scripts/sdk-watch/check-sdk-versions.mjs
   ```
   If `action` is `none`, go straight to the consumer checks in the other repos (step 2 of the
   chain); the consumers can still be behind on sn-credstore itself.
2. Review each version in `newVersions`:
   ```bash
   node scripts/sdk-watch/review-sdk-version.mjs <v>
   ```
   Act on the verdict as in the table above.
3. Allowlist on a branch:
   ```bash
   git switch -c feat/sdk-<v>
   node scripts/sdk-watch/allowlist-sdk-version.mjs <v> [<v> ...]
   ```
   Then sanity-check locally against a temp store:
   ```bash
   export SN_CRED_STORE=file SN_CRED_STORE_PATH="$(mktemp -d)/credentials.json"
   npm run lint && npm run build && npm test
   ```
4. Commit `feat: support ServiceNow SDK <v>` and open the PR. Its body says what the review
   found: the verdict, the seam hashes, and each review item with why it is safe.
5. Ask QA to run `scripts/sdk-watch/qa-sdk-version.sh <v> [...]` on the PR branch.
6. Once QA passes, CI is green and the automated review has no blocking notes:
   ```bash
   gh pr merge <n> --squash
   scripts/sdk-watch/watch-release.sh <merge-sha>
   ```
   Then continue with now-sdk-ext-core.

### QA steps

```bash
gh pr checkout <n>
scripts/sdk-watch/qa-sdk-version.sh <v> [<v> ...]   # every version the PR allowlists
```
Post the JSON summary on the PR (`gh pr comment <n> --body-file …`). A missing `keyctl` fails
the run. Set `QA_ALLOW_NO_KEYCTL=1` only on a host where that is a known limitation, and say
so in the comment: the summary records the ladder as `skipped`, not `passed`. Run time is
about 1–2 minutes per version.
