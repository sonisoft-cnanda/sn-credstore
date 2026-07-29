# @sonisoft/sn-credstore

Headless-safe credential storage for the ServiceNow SDK.

Lets non-interactive sessions — SSH, `systemd` units, CI runners, AI agents —
share the OAuth credentials that the OS keyring cannot serve them, without
changing how `now-sdk` works for everyone else.

---

## The problem

`@servicenow/sdk-cli` stores credentials in the OS keyring. A non-interactive
session cannot unlock that keyring, **even running as the same user**, so any
agent, cron job or CI step that shells out to `now-sdk` fails.

It fails badly, too. The SDK's keychain wrapper is:

```js
async getPassword() { try { return this.getEntry().getPassword() } catch { return null } }
```

A locked keyring is swallowed and returned as `null`, which is indistinguishable
from "no credentials configured". So you get:

```
Default Credential has not been set
```

…and go looking for a missing alias that is in fact sitting right there.

### Why the SDK's own headless options don't cover it

- `SN_SDK_SESSION_BEARER_TOKEN` makes `getCredentials()` **throw by design**:
  *"Pre-authenticated sessions do not expose raw credentials."*
- `SN_SDK_NODE_ENV=SN_SDK_CI_INSTALL` returns real credentials but is **global,
  not per-alias** — `--auth <alias>` is ignored once set, so one process can only
  ever reach one instance.

---

## What this does

Patches `KeyChain.prototype` inside `@servicenow/sdk-cli` so credential reads and
writes go to a store that works without a session. Nothing else about the SDK
changes: alias resolution, OAuth refresh, `auth --list`, `--use` and `--delete`
all behave exactly as before. Only the storage location moves.

It is **opt-in everywhere**. Installing this package changes nothing until you
ask for it.

---

## Install

```bash
npm install -g @sonisoft/sn-credstore
```

### Migrate your existing credentials

Run this **from a desktop session on a TTY** — your credentials are currently in
the keyring, so the wallet will prompt to unlock.

```bash
sn-credstore doctor                        # what is where
sn-credstore import --from keyring --dry-run   # preview; secrets masked
sn-credstore import --from keyring             # migrate
```

The keyring copy is **left intact** as a rollback path. Pruning it is a separate,
explicit step (`now-sdk auth --delete all`) — don't do it until you are happy.

### Verify

```bash
# Simulate a headless session: no D-Bus, no display, a fresh session keyring.
env -u DBUS_SESSION_BUS_ADDRESS -u XDG_RUNTIME_DIR -u DISPLAY -u WAYLAND_DISPLAY \
  keyctl session - sh -c 'now-sdk auth --list; now-sdk-x auth --list'
```

Stock `now-sdk` reports no credentials. `now-sdk-x` lists them. That single
output is the proof of both the bug and the fix.

---

## Using it

### With `now-sdk`

Use the `now-sdk-x` wrapper, which runs the real SDK in-process with the shim
installed:

```bash
now-sdk-x auth --list
now-sdk-x app install --auth dev206299
```

`now-sdk-x` is a separate binary on purpose. It does **not** overwrite the
npm-managed `now-sdk` symlink, because the next `npm i -g @servicenow/sdk` would
silently clobber it. To make it the default for your shell, either alias it or
put a `now-sdk` shim earlier on your `PATH`.

### With `nex` (`@sonisoft/now-sdk-ext-cli`)

Pass `--cred-store`:

```bash
nex aggregate count --table incident --auth dev206299 --cred-store
```

Or set it for the whole session:

```bash
export SN_CRED_STORE_ENABLE=1
```

Without the flag, `nex` uses the stock SDK keyring exactly as it always has.

### With the MCP server (`@sonisoft/now-sdk-ext-mcp`)

Set `SN_CRED_STORE_ENABLE=1` in the server's `env` block. This is usually the
one you want: an MCP server is always launched as a non-interactive child
process.

```json
{
  "mcpServers": {
    "now-sdk-ext": {
      "command": "npx",
      "args": ["-y", "@sonisoft/now-sdk-ext-mcp"],
      "env": {
        "SN_AUTH_ALIAS": "dev206299",
        "SN_CRED_STORE_ENABLE": "1"
      }
    }
  }
}
```

### From your own code

```js
// Applications that own their entry point — install before anything reads a credential.
import '@sonisoft/sn-credstore/register'
```

```js
// Or explicitly, e.g. behind your own flag.
import { installKeyChainShim } from '@sonisoft/sn-credstore'
installKeyChainShim()
```

Importing the package root has **no side effects**. Only `/register` or an
explicit call patches anything.

For CommonJS, or to install the shim before any of your own code runs:

```bash
NODE_OPTIONS="--require $(sn-credstore preload-path)" some-tool
```

---

## Commands

```
sn-credstore list [--json]                  List aliases (secrets never printed)
sn-credstore show <alias> [--reveal]        Show one alias; --reveal prints secrets
sn-credstore use <alias>                    Set the default alias
sn-credstore delete <alias> | --all         Remove an alias, or every alias
sn-credstore import --from keyring [--dry-run]  Migrate out of the OS keyring
sn-credstore import --stdin                 Read a keystore JSON from stdin
sn-credstore backend                        Show the active backend, probe others
sn-credstore migrate --to <backend>         Convert between backends
sn-credstore doctor [--json]                Diagnose store, shim and SDK copies
sn-credstore preload-path                   Print the absolute path of preload.cjs
```

`nex auth list|use|delete|doctor` mirrors the common ones.

---

## Configuration

Precedence: environment variable → `$XDG_CONFIG_HOME/sn-credstore/config.json` →
default.

| Variable | Default | Meaning |
|---|---|---|
| `SN_CRED_STORE` | `auto` → `systemd-creds` | Backend: `systemd-creds`, `file`, `auto` |
| `SN_CRED_STORE_PATH` | `$XDG_STATE_HOME/sn-credstore/credentials.json` | Blob location |
| `SN_CRED_STORE_KEY` | `host` | systemd-creds key: `host`, `tpm2`, `host+tpm2` |
| `SN_CRED_STORE_ENABLE` | _(unset)_ | Opt in from `nex` / the MCP server |
| `SN_CRED_STORE_DISABLE` | _(unset)_ | Hard off switch; wins over everything |
| `SN_CRED_STORE_ALLOW_PLAINTEXT` | _(unset)_ | Permit the unencrypted file backend |
| `SN_CRED_STORE_LOCK_TIMEOUT_MS` | `20000` | Write-lock timeout |
| `SN_CRED_STORE_DEBUG` | _(unset)_ | Verbose diagnostics on stderr |

### Backends

**`systemd-creds` (default).** Encrypts with `systemd-creds --user`, pinned to
`--with-key=host`.

Be clear about what this buys, because it is easy to overestimate. **On-host it
protects nothing**: `/run/systemd/io.systemd.Credentials` is mode `0666` and
`systemd-creds@.service` runs as root, so it is a root-run decryption oracle
available to any process with your uid — the same population that can read a
`0600` file. Its real value is **off-host**: a copied blob simply does not
decrypt, so backups, rsync'd home directories, VM snapshots and stray `git add`s
are inert.

It is bound to **uid + username + machine-id**, *not* to a session or process,
which is why many concurrent headless agents can all use it. Verified: 20
concurrent processes in a stripped session, 0 read failures, exactly 1 token
refresh, all aliases intact.

The corollary is that **blobs cannot move between machines**. A reimage,
machine-id change or container clone makes them permanently undecryptable. Treat
the store as a cache, not a system of record.

`--with-key=auto` and `tpm2` are deliberately not used: `auto` could silently
start producing TPM-bound blobs after a firmware update, and the next PCR change
(kernel update, Secure Boot toggle) would brick them.

**`file`.** A `0600` JSON file. Use it in containers without systemd:

```bash
export SN_CRED_STORE=file SN_CRED_STORE_ALLOW_PLAINTEXT=1
```

There is **no silent downgrade** from an encrypted backend to plaintext. If
`systemd-creds` is selected and unavailable you get an error naming the fallback,
not a quietly unencrypted file.

**`keyring`.** Read-only. Exists solely for `import --from keyring`.

### Switching backends

```bash
sn-credstore migrate --to systemd-creds
```

Reads through the current backend, writes through the target, then verifies by
reading back through the target before reporting success. A backup is kept —
a half-finished migration that has already overwritten the blob is unrecoverable.
Migrating `file` → `systemd-creds` warns that the backup is **plaintext**; delete
it once you have verified.

---

## Concurrency and safety

Every SDK write path is a read-modify-write seeded from that error-swallowing
read:

```js
const keyStore = (await getParsedCredentials()) ?? {}   // null on ANY failure
```

**One transient read failure followed by any write silently replaces the entire
multi-alias store with a single alias.** With the keyring this is nearly
unreachable; any store with real failure modes makes it routine — and it fires
unattended during OAuth refresh. Making that safe is most of what this package
does:

- **Clobber guard** — refuses to persist a blob whose alias set is a strict
  subset of the last good read, unless a delete explicitly asked for it.
- **Three-way merge** — diffs incoming against the base that was handed out and
  re-reads current under the lock, so a concurrent refresh of a *different* alias
  is never lost.
- **Refresh lease** — all agents share one `expires_at`, so they stampede in
  lockstep inside the same 15-minute window. One process takes the lease and
  refreshes; the rest re-read and use the fresh token.
- **Atomic writes** — temp → `fsync` → `rename` → `fsync` dir. Readers never see
  a partial blob, so reads take no lock.
- **`setPassword` never throws** — its call site upstream has no `try`/`catch`.
  On repeated failure it writes a `.pending-*` sidecar and returns; the next read
  merges and clears it. Silently swallowing would lose a rotated refresh token
  permanently.

**Honest limit:** if ServiceNow rotates refresh tokens on use, two genuinely
concurrent refreshes still invalidate one token. The lease prevents the double
refresh and the merge prevents persisting the loser, but neither can help if a
*non-shimmed* `now-sdk` runs at the same time.

---

## Troubleshooting

```bash
sn-credstore doctor          # or: nex auth doctor
SN_CRED_STORE_DEBUG=1 <cmd>  # verbose, on stderr
```

**"No credentials found" but `sn-credstore list` shows the alias.** The shim is
not active for that process. Check `NOW_SDK_KEYCHAIN_PATCHED=1`, and that you
passed `--cred-store` / set `SN_CRED_STORE_ENABLE=1`.

**"the systemd-creds backend is not usable on this host".** No
`/run/systemd/io.systemd.Credentials` — typically a container. Use
`SN_CRED_STORE=file SN_CRED_STORE_ALLOW_PLAINTEXT=1`.

**Decryption fails after a machine change.** Expected: blobs are bound to
uid + username + machine-id. Re-import from the keyring, or re-authenticate.

**Credentials diverge from a colleague's / an IDE's.** Any `now-sdk` running
without the shim still reads and writes the OS keyring. `doctor` detects the
divergence.

---

## Known limitations

- **Non-shimmed `now-sdk` diverges.** A colleague, an IDE extension, or a bare
  `npx @servicenow/sdk` still uses the keyring.
- **Blobs are host-bound** under `systemd-creds`. Not portable, by design.
- **Refresh-token rotation** under true concurrency is mitigated, not eliminated.
- **No headless interactive login.** ServiceNow has no device-code grant.
  Provision with `import --stdin`, `--password-stdin`, or the `SN_SDK_*` env vars.

---

## Development

```bash
npm install
npm run build     # dual ESM + CJS
npm test
npm run lint
```

Zero runtime dependencies. `@napi-rs/keyring` is resolved lazily from the SDK's
own tree, only for `import --from keyring`.

See [`CLAUDE.md`](./CLAUDE.md) for architecture and [`AGENTS.md`](./AGENTS.md)
for the rules that apply when an automated agent changes this code.

## License

MIT
