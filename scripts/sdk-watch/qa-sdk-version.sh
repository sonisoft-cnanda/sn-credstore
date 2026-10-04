#!/usr/bin/env bash
# QA gate for allowlisting @servicenow/sdk releases. Run on the branch that allowlists them.
#
# Usage: scripts/sdk-watch/qa-sdk-version.sh <version> [<version> ...]
#
# Steps (all against a throwaway credential store — never the real one):
#   lint, build, full test suite (includes the real-package and refresh-boundary tests
#   for every allowlisted release), then per version, against that exact @servicenow/sdk
#   installed in a temp prefix:
#     headless ladder rungs 1-2   scripts/headless-candidates.sh (needs `keyctl`)
#     OAuth refresh rotation      scripts/verify-oauth-refresh.mjs (fake OAuth server)
#     concurrency / no lost alias scripts/verify-auth-contention.mjs
#
# Prints one JSON summary on stdout; logs per step go to $QA_ARTIFACTS (default: temp dir).
# Exit 0 only when every step passed. Set QA_ALLOW_NO_KEYCTL=1 to run without the headless
# ladder on a host that lacks keyutils (the summary then records it as skipped, not passed).
set -uo pipefail

if (($# == 0)); then
    echo 'usage: scripts/sdk-watch/qa-sdk-version.sh <version> [<version> ...]' >&2
    exit 2
fi

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
artifacts="${QA_ARTIFACTS:-$(mktemp -d -t sdk-qa-XXXXXX)}"
mkdir -p "$artifacts"
results="$artifacts/results.tsv"
: >"$results"

# AGENTS.md rule 1: redirect the store BEFORE anything can write, then prove it took effect.
sandbox="$(mktemp -d -t sdk-qa-store-XXXXXX)"
export SN_CRED_STORE=file
export SN_CRED_STORE_PATH="$sandbox/credentials.json"
unset SN_CRED_STORE_DISABLE SN_CRED_STORE_KEY

step() { # step <name> <command...>
    local name="$1"
    shift
    local log="$artifacts/$name.log" start=$SECONDS status=pass
    echo "== $name" >&2
    "$@" >"$log" 2>&1 || status=fail
    printf '%s\t%s\t%s\t%s\n' "$name" "$status" "$((SECONDS - start))" "$log" >>"$results"
    echo "   $status ($((SECONDS - start))s)" >&2
    [[ $status == pass ]]
}
skip() { printf '%s\tskipped\t0\t%s\n' "$1" "$2" >>"$results"; echo "== $1: skipped ($2)" >&2; }

allowlisted="$(node -e "import('./scripts/sdk-watch/lib.mjs').then(m => console.log(m.knownGoodVersions().join(' ')))")"
for version in "$@"; do
    if [[ " $allowlisted " != *" $version "* ]]; then
        echo "$version is not in KNOWN_GOOD_VERSIONS on this branch; run allowlist-sdk-version.mjs first" >&2
        exit 2
    fi
done

[[ -d node_modules ]] || step npm-ci npm ci
step lint npm run lint
step build npm run build
reported="$(node ./bin/sn-credstore.js doctor --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).config.blobPath)}catch{}})")"
if [[ "$reported" != "$SN_CRED_STORE_PATH" ]]; then
    printf 'sandbox\tfail\t0\tstore resolved to %s, not the sandbox; refusing to run tests\n' "${reported:-?}" >>"$results"
else
    printf 'sandbox\tpass\t0\t%s\n' "$SN_CRED_STORE_PATH" >>"$results"
    step test npm test

    for version in "$@"; do
        prefix="$(mktemp -d -t "sdk-$version-XXXXXX")"
        if ! step "install-sdk-$version" npm install --silent --no-audit --no-fund --prefix "$prefix" "@servicenow/sdk@$version"; then
            continue
        fi
        if command -v keyctl >/dev/null; then
            step "headless-ladder-$version" bash scripts/headless-candidates.sh "$version"
        elif [[ "${QA_ALLOW_NO_KEYCTL:-}" == 1 ]]; then
            skip "headless-ladder-$version" 'keyctl not installed'
        else
            printf 'headless-ladder-%s\tfail\t0\tkeyctl not installed (install keyutils, or set QA_ALLOW_NO_KEYCTL=1)\n' "$version" >>"$results"
        fi
        SN_SDK_HOME="$prefix/node_modules/@servicenow/sdk" step "oauth-refresh-$version" node scripts/verify-oauth-refresh.mjs
        SN_SDK_HOME="$prefix/node_modules/@servicenow/sdk" step "auth-contention-$version" node scripts/verify-auth-contention.mjs
        rm -rf "$prefix"
    done
fi
rm -rf "$sandbox"

node - "$results" "$artifacts" "$@" <<'EOF'
const [results, artifacts, ...versions] = process.argv.slice(2);
const steps = require('node:fs').readFileSync(results, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => { const [name, status, seconds, detail] = l.split('\t'); return { name, status, seconds: Number(seconds), detail }; });
const pass = steps.length > 0 && steps.every((s) => s.status !== 'fail');
process.stdout.write(JSON.stringify({ versions, pass, steps, artifacts }, null, 2) + '\n');
process.exit(pass ? 0 : 1);
EOF
