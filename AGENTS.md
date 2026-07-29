# AGENTS.md

Operating rules for automated agents working in this repository.

For architecture, layout and build commands, read [`CLAUDE.md`](./CLAUDE.md).
This file is only about the things that will bite you here and not elsewhere.

---

## What this repository is

A credential store. It holds **live OAuth refresh tokens** for real ServiceNow
instances. A mistake here does not produce a failing test — it produces a
developer who has to re-authenticate, or worse, a leaked token.

Work accordingly.

---

## Hard rules

### 1. Never run anything that mutates the real store

The default store path is `$XDG_STATE_HOME/sn-credstore/credentials.json`
(usually `~/.local/state/sn-credstore/credentials.json`). Anything that writes —
`use`, `delete`, `import`, `migrate`, or any test that exercises the vault — must
be pointed elsewhere **first**:

```bash
export SN_CRED_STORE=file
export SN_CRED_STORE_PATH="$(mktemp -d)/credentials.json"
```

**This has already gone wrong once.** A test file mocked the store instead of
redirecting it; under jest's ESM mode the mock silently did not apply to a
dynamic `import()`, and `auth delete --all` wiped a real credential store. It was
recoverable only because the keyring rollback copy still existed.

The lesson is not "mock more carefully". It is: **verify the redirection took
effect rather than assuming it did**, by asking the code where it actually
resolved:

```ts
const { result } = await runCommand(['auth', 'list', '--json'])
if (result.path !== sandboxPath) throw new Error('refusing to run')
```

### 2. Never print a secret

Not in logs, not in test output, not in an error message, not in a commit
message, not in a report back to the user.

`src/redact.ts` exists specifically because Node attaches `stdout`/`stderr` to
`child_process` errors — and for `SystemdCredsStore`, **stdout is the credential
blob**. Any new `child_process` use must route errors through
`sanitizeProcessError()`.

When you need to show that a value exists, show `maskValue()` or a boolean.

### 3. Never characterise a credential you have not examined

If you are asked whether something leaked, determine what the value actually
*is*. Placeholders (`${NPM_TOKEN}`, `REDACTED_*`, `changeme`) look exactly like
secrets to a grep for `token=`.

**This has already gone wrong once**, in the opposite direction: a confident
report of a compromised token that turned out to be placeholders throughout. The
instinct to avoid printing a secret is right; skipping the check and reporting
anyway is not. Inspect it without echoing it, and say plainly what you verified.

### 4. Unit tests cannot prove this package works

They run in a developer's desktop session, where the keyring works fine. The bug
this package exists for only appears where there is no D-Bus secret service and
no populated session keyring.

A self-deadlock in the refresh lease once shipped with **every unit test green**,
while a real headless call burned 20 seconds on a lock it already held. It was
caught by an actual API call, not the suite.

So: any change to the shim, the vault, the lock or a store must be verified on
the **headless ladder**, cheapest first:

```bash
# 1. Strip the session markers
env -u DBUS_SESSION_BUS_ADDRESS -u XDG_RUNTIME_DIR -u DISPLAY -u WAYLAND_DISPLAY <cmd>

# 2. Fresh anonymous session keyring — what SSH and systemd units actually get.
#    Run stock and wrapped SIDE BY SIDE; that one output proves bug and fix.
env -u DBUS_SESSION_BUS_ADDRESS -u XDG_RUNTIME_DIR -u DISPLAY -u WAYLAND_DISPLAY \
  keyctl session - sh -c 'now-sdk auth --list; now-sdk-x auth --list'

# 3. systemd-run --user --scope
# 4. ssh -o BatchMode=yes localhost
# 5. A container with no systemd — proves the file backend and the refuse-to-downgrade error
```

`test/unit/shim/headless.test.ts` encodes rungs 1–2. Extend it rather than
testing by hand and discarding the result.

### 5. Concurrency claims need concurrent evidence

"Should be safe" is not a finding. The established bar for this repo is: seed an
alias near expiry, run ~20 processes against it, and assert **exactly one**
refresh, **no alias lost**, no leftover `.tmp.*`, and the `isDefault` invariant
intact. Then `kill -9` mid-write and assert the blob still parses and the stale
lock is reclaimed.

---

## Things that look like bugs and are not

- **`SystemdCredsStore` shells out per read.** Deliberate — the API is only
  exposed over a socket. The in-process cache is what keeps it viable.
- **`--with-key=host`, never `auto` or `tpm2`.** `auto` could silently start
  producing TPM-bound blobs after a firmware update; the next PCR change would
  make them permanently undecryptable.
- **`now-sdk-x` does not overwrite the `now-sdk` symlink.** The next
  `npm i -g @servicenow/sdk` would clobber it silently.
- **`installKeyChainShim()` is not in the consumers' generated barrels.**
  Importing a library must never monkeypatch a global as a side effect.
- **`setPassword` swallows errors and writes a sidecar.** Its upstream call site
  has no `try`/`catch`; throwing would lose a rotated refresh token permanently.
- **`listAliases` reads the raw store, not the vault.** Going through the vault
  would arm the refresh lease, so listing could block behind another process's
  token refresh.

---

## When you change the SDK-facing surface

The shim asserts the `sdk-cli` version is in a known-good allowlist
(`KNOWN_GOOD_VERSIONS` in `src/shim/locateSdkCli.ts`) and that all three
`KeyChain` methods exist before replacing them.

If a new SDK version ships, **read the new `keychain/index.js` before widening
the allowlist**. The failure mode of a wrong assumption here is silent: the shim
patches something that is no longer called, the SDK falls back to the keyring,
and the first write reseeds from a failed read and wipes the store.

---

## Reporting

State what you verified and how. "Tests pass" is not the same as "I ran it
headless and it returned data". If you did not run the ladder, say so.

If a change is blocked or partially done, say which part and why — do not narrow
the scope silently.
