/**
 * Diagnose the whole path: store, SDK copies, shim, keyring, and drift.
 *
 * Exits non-zero when the active store cannot round-trip, so it is usable as a
 * health check in a script rather than something a human has to read.
 */
import { ResolvedConfig, SYSTEMD_CRED_NAME } from '../../config.js';
import { createStore, probeAll } from '../../store/StoreFactory.js';
import { detectSystemdUserCredsSupport } from '../../store/systemdSupport.js';
import { KeyringStore } from '../../store/KeyringStore.js';
import { findSdkCliCandidates, KNOWN_GOOD_VERSIONS } from '../../shim/locateSdkCli.js';
import { PATCHED_ENV_VAR } from '../../shim/patch.js';
import { parseKeyStore } from '../../types.js';
import { describeProblems, findCredentialProblems } from '../../validate.js';
import { stat } from 'node:fs/promises';
import { hasFlag } from '../main.js';
import { isCredentialStoreError } from '../../errors.js';

interface Check {
    name: string;
    ok: boolean;
    detail: string;
}

export async function cmdDoctor(argv: string[], config: ResolvedConfig): Promise<number> {
    const json = hasFlag(argv, '--json');
    const checks: Check[] = [];

    checks.push({ name: 'node', ok: true, detail: process.version });
    checks.push({
        name: 'shim installed',
        ok: process.env[PATCHED_ENV_VAR] === '1',
        detail:
            process.env[PATCHED_ENV_VAR] === '1'
                ? 'yes'
                : 'no — this process was not preloaded (expected for a bare `sn-credstore` run)',
    });

    // SDK copies. Multiple installs are normal; unknown versions are not.
    const candidates = findSdkCliCandidates();
    for (const c of candidates) {
        const known = c.version !== null && KNOWN_GOOD_VERSIONS.has(c.version);
        checks.push({
            name: `sdk-cli ${c.version ?? 'unknown'}`,
            ok: known,
            detail: `${c.packageRoot}${known ? '' : '  <-- NOT in the verified list; the shim will refuse it'}`,
        });
    }
    if (candidates.length === 0) {
        checks.push({ name: 'sdk-cli', ok: false, detail: 'no @servicenow/sdk-cli installation found' });
    }

    // Backends.
    for (const p of await probeAll(config)) {
        checks.push({
            name: `backend:${p.id}`,
            ok: p.available,
            detail: `${p.available ? 'available' : 'unavailable'}${p.error ? ` (${p.error})` : ''}`,
        });
    }

    // Informational: whether this host can run `systemd-creds --user` at all.
    // A deliberate SN_CRED_STORE=file user will see a FAIL row here but the
    // exit code is still decided by the round trip below.
    const support = detectSystemdUserCredsSupport();
    checks.push({
        name: 'systemd user-creds',
        ok: support.supported,
        detail: support.supported
            ? `available${support.systemdVersion !== undefined && support.systemdVersion !== null ? ` (systemd ${support.systemdVersion})` : ''}`
            : (support.reason ?? 'unavailable'),
    });

    // Active store round trip — the check that decides the exit code.
    let roundTrip = false;
    let aliasCount = 0;
    try {
        // Inside the try: in auto mode createStore itself refuses on hosts
        // where systemd-creds is unusable and plaintext was not permitted.
        const store = createStore(config);
        const { blob } = await store.read();
        const parsed = blob === null ? {} : parseKeyStore(blob);
        roundTrip = parsed !== null;
        aliasCount = parsed === null ? 0 : Object.keys(parsed).length;
        checks.push({
            name: 'active store',
            ok: roundTrip,
            detail: roundTrip
                ? `${store.describe()} — ${aliasCount} alias(es)`
                : `${store.describe()} — blob present but unparseable`,
        });

        // Reported separately from parseability, because a store can round-trip
        // perfectly and still hold an expires_at in milliseconds — which surfaces
        // as silent 401s and looks like anything but a units bug.
        if (parsed !== null) {
            const problems = findCredentialProblems(parsed);
            const blocking = problems.filter((p) => p.severity === 'blocking');
            checks.push({
                name: 'credential fields',
                ok: blocking.length === 0,
                detail:
                    problems.length === 0
                        ? 'all credentials well-formed'
                        : `${blocking.length} blocking, ${problems.length - blocking.length} warning\n` +
                          describeProblems(problems),
            });
        }
    } catch (err) {
        const detail = isCredentialStoreError(err)
            ? `${err.message}\n        Remediation: ${err.remediation}`
            : (err as Error).message;
        checks.push({ name: 'active store', ok: false, detail });
    }

    // File mode. 0600 is the only thing protecting a plaintext store.
    try {
        const s = await stat(config.blobPath);
        const mode = (s.mode & 0o777).toString(8);
        checks.push({ name: 'blob permissions', ok: mode === '600', detail: `${mode} at ${config.blobPath}` });
    } catch {
        checks.push({ name: 'blob permissions', ok: true, detail: 'no blob yet' });
    }

    if (config.store === 'systemd-creds') {
        checks.push({ name: 'systemd-creds key', ok: true, detail: `--with-key=${config.systemdKey}, --name=${SYSTEMD_CRED_NAME}` });
    }

    // Drift: a non-preloaded `now-sdk` still reads and writes the OS keyring, so
    // the two stores can diverge silently. Report it rather than pretend.
    try {
        const keyring = new KeyringStore(5000);
        if (await keyring.isAvailable()) {
            const { blob } = await keyring.read();
            const kAliases = blob === null ? [] : Object.keys(parseKeyStore(blob) ?? {});
            checks.push({
                name: 'keyring drift',
                ok: true,
                detail:
                    kAliases.length === 0
                        ? 'keyring is empty'
                        : `keyring still holds ${kAliases.length} alias(es): ${kAliases.join(', ')} — ` +
                          `a bare \`now-sdk\` (without the wrapper) would use these instead`,
            });
        }
    } catch (err) {
        checks.push({ name: 'keyring drift', ok: true, detail: `keyring unreadable (${(err as Error).message})` });
    }

    if (json) {
        process.stdout.write(
            `${JSON.stringify({ config: { store: config.store, blobPath: config.blobPath }, checks, ok: roundTrip }, null, 2)}\n`,
        );
    } else {
        for (const c of checks) {
            process.stdout.write(`${c.ok ? '  ok  ' : ' FAIL '} ${c.name.padEnd(24)} ${c.detail}\n`);
        }
        process.stdout.write(
            roundTrip ? '\nThe active credential store is readable.\n' : '\nThe active credential store is NOT usable.\n',
        );
    }

    return roundTrip ? 0 : 1;
}
