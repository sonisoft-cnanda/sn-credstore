# sn-credstore

Headless-safe credential storage for the ServiceNow SDK (`@servicenow/sdk-cli`).
Zero runtime dependencies, dual ESM + CJS build.

**Read [`AGENTS.md`](./AGENTS.md) before changing anything.** This package holds
live OAuth credentials, and several of its invariants are not recoverable if
broken.

## Project Overview

`@servicenow/sdk-cli` stores credentials in the OS keyring. Non-interactive
sessions cannot unlock it — even as the same user — and the SDK swallows the
failure and reports "Default Credential has not been set", which is
indistinguishable from having no credentials at all.

This package patches `KeyChain.prototype` so the blob lives somewhere a headless
process can reach, leaving the SDK's entire auth stack (alias resolution, OAuth
refresh, `--list`, `--use`, `--delete`) untouched.

## The seam

`node_modules/@servicenow/sdk-cli/dist/auth/keychain/index.js` — 43 lines of
CommonJS, three methods, hardcoded `service='ServiceNow'`, `account='now-sdk'`,
storing `JSON.stringify({[alias]: {isDefault, alias, creds}})`.

Two facts, established empirically, shape the whole design:

1. **The patch does not need to beat `dist/auth/index.js`'s module load.** That
   module does `const keyChain = new KeyChain(SERVICE)` at import time, but
   methods resolve through the prototype at *call* time and `_entry` is only
   constructed inside the method bodies we replace. So `@napi-rs/keyring`'s
   `Entry` is never constructed, and patching after the module loaded still
   works.
2. **There are 2–4 copies of `sdk-cli` in a typical tree** (repo-local, nested
   under core, global under `@servicenow/sdk`). A single `require.resolve`
   patches the wrong one about half the time. Hence the `Module._load` hook.

Patch `KeyChain.prototype` — **never** `exports.KeyChain` and never the instance.
Replacing the export is a no-op once the singleton exists.

## Two axes, kept separate

- A **store** is *where the blob lives*: file, systemd-creds, keyring.
- A **provider** is *how a `Creds` is minted and renewed*: basic, OAuth code
  grant, client credentials.

Conflating these is how the abstraction rots. Keep them apart.

## Directory Structure

```
preload.cjs / src/register.ts     Side-effect entry points over installKeyChainShim()
src/index.ts                      Public API — NO side effects on import
src/api.ts                        Programmatic facade (shared with `nex auth`)
src/types.ts                      Creds, StoredCredential, KeyStore — mirror the SDK exactly
src/errors.ts                     Typed errors, each carrying .code + .remediation
src/redact.ts                     Blanks password/access_token/refresh_token/client_secret
src/config.ts                     XDG paths, backend precedence, env parsing
src/logger.ts

src/store/ICredentialStore.ts     Blob-level read/write with a CAS version token
src/store/FileStore.ts            0600 JSON
src/store/SystemdCredsStore.ts    DEFAULT — stdin/stdout only, --with-key=host
src/store/KeyringStore.ts         READ-ONLY; lazy @napi-rs/keyring from the SDK tree
src/store/StoreFactory.ts         Selection + probeAll() for doctor
src/store/atomicFile.ts           temp -> fsync -> rename -> fsync dir

src/lock/FileLock.ts              O_EXCL lockfile, pid/bootId staleness, jittered backoff
src/vault/CredentialVault.ts      Lease, clobber guard, sidecars, in-process cache
src/vault/merge.ts                Base-diff changeset, three-way apply, isDefault invariant

src/shim/locateSdkCli.ts          Shared by doctor and the wrapper
src/shim/patch.ts                 Module._load hook + require.cache sweep + eager resolve
src/cli/                          Zero-dep argv dispatch
bin/sn-credstore.js               CLI
bin/now-sdk-wrapped.cjs           `now-sdk-x` — in-process wrapper, no spawn
```

## Build & Test

```bash
npm run build      # clean + build:esm + build:cjs (stamps dist/cjs/package.json)
npm test
npm run lint       # tsc --noEmit
```

The CJS build exists solely so `preload.cjs` can be used with
`NODE_OPTIONS=--require`. All three consumer repos are ESM-only.

## Key Patterns

- **Errors carry remediation.** Every error class has `.code` and `.remediation`.
  Consumers surface `.remediation` verbatim; a bare message loses the only
  actionable part.
- **`ICredentialStore` is blob-level, not alias-level.** It maps 1:1 onto
  `KeyChain`, which preserves the SDK's own semantics for free.
- **Stores throw on failure.** `{blob: null}` means *genuinely empty*, never
  *"something went wrong"* — conflating the two is precisely the SDK bug this
  package exists to fix.
- **`setPassword` must never throw.** Its upstream call site has no `try`/`catch`.
  On repeated failure it writes a `.pending-*` sidecar and returns normally; the
  next read merges and clears it.
- **`expires_at` is UNIX seconds**, matching the SDK. A units slip gives either a
  refresh storm or silent 401s.
- **Never log a credential.** `redact.ts` exists because Node attaches
  stdout/stderr to `child_process` errors — and for `SystemdCredsStore`, stdout
  *is* the credential blob.
- **Backend selection never silently downgrades to plaintext.** If an encrypted
  backend was chosen and is unavailable, throw with remediation.

## The bug that dominates the design

Every SDK write path is a read-modify-write seeded from a read that swallows all
errors:

```js
const keyStore = (await getParsedCredentials()) ?? {}   // null on ANY failure
```

**One transient read failure followed by any write silently replaces the entire
multi-alias store with a single alias.** It affects `updateCredentials`,
`storeCredentials`, `updateDefaultCredential` and `removeCredentials`.

Compounding it: all agents share one `expires_at`, so they don't race randomly —
they stampede in lockstep inside the same 15-minute window
(`if (expiresIn > 15 * 60) return`).

The clobber guard, three-way merge, refresh lease, atomic writes and in-process
cache are all load-bearing responses to this. They are not belt-and-braces.

## Consumer wiring

**Opt-in everywhere.** Installing this package changes nothing until asked.

| Consumer | How it opts in |
|---|---|
| `now-sdk-ext-cli` | `--cred-store` flag or `SN_CRED_STORE_ENABLE=1`; acted on in `bin/credstore-boot.js`, declared in `AuthenticatedCommand.baseFlags` |
| `now-sdk-ext-mcp` | `SN_CRED_STORE_ENABLE=1`; `src/common/credstore-boot.ts` |
| `now-sdk-ext-core` | Explicit `initCredentialStore()` from `PublicApi.ts` |
| `now-sdk` | The separate `now-sdk-x` binary |

The gate lives in each consumer's boot module, not in `installKeyChainShim()` —
`now-sdk-x` and `/register` are already explicit by virtue of being invoked, so
gating them again would just be a second switch to forget.

`nex`'s flag is read straight from `process.argv` because the shim must be
installed before `AuthenticatedCommand.init()` resolves credentials, which is
before oclif has parsed anything.

## Releasing & Publishing

**Publishing to npm uses a Trusted Publisher (OIDC), not an auth token.** npmjs is
phasing token-based publishing out, so nothing here should reintroduce one.

- The workflow needs `permissions: id-token: write`. Without it npm cannot mint
  the OIDC credential, and the failure reads like a missing token — which is the
  wrong thing to go looking for.
- The package must be registered as a trusted publisher on npmjs, bound to this
  repository and workflow file. Renaming `publish.yml` breaks that binding.
- `--provenance` works off the same OIDC identity.
- Do NOT add an `NPM_TOKEN`. If publishing fails, fix the trusted publisher
  configuration on npmjs.

The intended chain: merge to `main` → `release.yml` runs `semantic-release`
(conventional commits, angular preset), which bumps, tags and cuts a GitHub
release with `npmPublish: false` → that release fires `publish.yml`.

Step two fires **only** because `release.yml` runs semantic-release with
`RELEASE_TOKEN` rather than the default `GITHUB_TOKEN`. GitHub suppresses events
raised by `GITHUB_TOKEN` so a workflow cannot trigger further workflows. Since
`release.yml` falls back (`secrets.RELEASE_TOKEN || secrets.GITHUB_TOKEN`),
removing that secret would leave releases working while publishing silently
stopped.

`publish.yml` also accepts `workflow_dispatch` for backfill, dry runs, or
republishing a ref. It skips when the version already exists on npm, so
re-running is a no-op rather than an error.

Historical note: `1.0.0` was published by hand, before this chain existed.

## Conventions

- ES Modules; TypeScript strict; target ES2022
- 4-space indent, single quotes (this repo — the CLI repo uses 2-space)
- Zero runtime dependencies. Keep it that way: this is installed globally on
  hosts that only need credential storage.
- Comments explain *why*, especially where the obvious alternative is wrong.
