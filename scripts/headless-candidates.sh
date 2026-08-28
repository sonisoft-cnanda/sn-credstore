#!/usr/bin/env bash
set -euo pipefail

if (($# == 0)); then
    echo 'usage: scripts/headless-candidates.sh <sdk-version> [...]' >&2
    exit 2
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fixture_alias='nex108fixture'

for version in "$@"; do
    sdk_root="$work/sdk-$version"
    store_path="$work/store-$version.json"
    npm install --silent --no-audit --no-fund --prefix "$sdk_root" "@servicenow/sdk@$version"
    printf '%s' '{"nex108fixture":{"isDefault":true,"alias":"nex108fixture","creds":{"instanceUrl":"https://fixture.invalid","type":"basic","username":"fixture","password":"fabricated"}}}' >"$store_path"
    chmod 600 "$store_path"

    export SN_CRED_STORE=file
    export SN_CRED_STORE_PATH="$store_path"
    reported_path="$(node ./bin/sn-credstore.js doctor --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).config.blobPath))")"
    if [[ "$reported_path" != "$store_path" ]]; then
        echo "sdk $version: refusing to run; sandbox path mismatch" >&2
        exit 1
    fi

    stock_out="$work/stock-$version.out"
    wrapped_out="$work/wrapped-$version.out"
    headless=(env -u DBUS_SESSION_BUS_ADDRESS -u XDG_RUNTIME_DIR -u DISPLAY -u WAYLAND_DISPLAY -u NODE_ENV keyctl session -)
    "${headless[@]}" node "$sdk_root/node_modules/@servicenow/sdk/bin/index.js" auth --list >"$stock_out" 2>&1 || true
    "${headless[@]}" env SN_SDK_HOME="$sdk_root/node_modules/@servicenow/sdk" node ./bin/now-sdk-wrapped.cjs auth --list >"$wrapped_out" 2>&1
    stock_has_fixture=false
    wrapped_has_fixture=false
    grep -q "$fixture_alias" "$stock_out" && stock_has_fixture=true
    grep -q "$fixture_alias" "$wrapped_out" && wrapped_has_fixture=true
    if [[ "$stock_has_fixture" != false || "$wrapped_has_fixture" != true ]]; then
        echo "sdk $version: stock_has_fixture=$stock_has_fixture wrapped_has_fixture=$wrapped_has_fixture path_verified=true" >&2
        exit 1
    fi
    echo "sdk $version: stock_has_fixture=false wrapped_has_fixture=true path_verified=true"
done
