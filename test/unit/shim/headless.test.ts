import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { execFileSync, execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Phase 5 — the headless ladder, as executable tests.
 *
 * The bug this whole package exists for only appears in a session that lacks a
 * D-Bus secret service AND a populated session keyring. Unit tests cannot see
 * it: they run in the developer's desktop session where the keyring works. The
 * reentrancy self-deadlock is the proof — every unit test was green while a real
 * headless invocation burned 20 seconds on a lock it already held.
 *
 * So these tests actually spawn processes under a stripped environment, and
 * where available under a fresh kernel session keyring via `keyctl session -`,
 * which is what SSH and systemd services really get.
 */

// jest runs from the package root, so cwd is stable here. import.meta.url would
// be more precise but ts-jest compiles this file with a module setting that
// rejects it, and this test does not need that precision.
const pkgRoot = resolve(process.cwd());
const preload = join(pkgRoot, 'preload.cjs');
const wrapper = join(pkgRoot, 'bin', 'now-sdk-wrapped.cjs');

/** Environment variables whose absence defines a headless session. */
const SESSION_VARS = ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'DISPLAY', 'WAYLAND_DISPLAY', 'KDE_FULL_SESSION'];

function have(bin: string): boolean {
    try {
        execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

const hasKeyctl = have('keyctl');
const hasNowSdk = have('now-sdk');

/** A copy of process.env with every desktop-session marker removed. */
function headlessEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env = { ...process.env, ...extra };
    for (const v of SESSION_VARS) delete env[v];

    // Jest sets NODE_ENV=test, and the SDK short-circuits on it:
    // dist/auth/index.js makes fetchCredentials return an empty Map and
    // removeCredentials a no-op when NODE_ENV === 'test'. Inheriting it into a
    // spawned CLI makes `auth --list` report "No credentials found" no matter
    // what the store holds — which looks exactly like the bug under test.
    delete env.NODE_ENV;
    return env;
}

/**
 * Run under a brand-new anonymous session keyring when keyctl is available.
 *
 * This is the part that genuinely reproduces the failure: @napi-rs/keyring reads
 * the keyutils session keyring first, and that keyring is per-login. A fresh one
 * is exactly what an SSH session or systemd service starts with.
 */
async function runHeadless(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
    const useKeyctl = hasKeyctl;
    const [bin, argv] = useKeyctl
        ? ['keyctl', ['session', '-', cmd, ...args]]
        : [cmd, args];
    try {
        const { stdout, stderr } = await execFileAsync(bin, argv, { env, timeout: 60_000 });
        return `${stdout}\n${stderr}`;
    } catch (err) {
        // Non-zero exit is meaningful output here, not a test failure.
        const e = err as { stdout?: string; stderr?: string; message?: string };
        return `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? ''}`;
    }
}

let dir: string;
let blobPath: string;

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sncs-headless-'));
    blobPath = join(dir, 'credentials.json');

    // A plaintext store keeps this test independent of systemd availability;
    // the encrypted backend has its own coverage.
    await writeFile(
        blobPath,
        JSON.stringify({
            headlessfixture: {
                isDefault: true,
                alias: 'headlessfixture',
                creds: {
                    instanceUrl: 'https://headlessfixture.service-now.com',
                    type: 'basic',
                    username: 'svc',
                    password: 'not-a-real-password',
                },
            },
        }),
        { mode: 0o600 },
    );
});

afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('headless session', () => {
    it('reads the store with no D-Bus, no XDG_RUNTIME_DIR and no DISPLAY', async () => {
        const out = await runHeadless(
            process.execPath,
            [join(pkgRoot, 'bin', 'sn-credstore.js'), 'list'],
            headlessEnv({ SN_CRED_STORE: 'file', SN_CRED_STORE_PATH: blobPath }),
        );
        expect(out).toContain('headlessfixture');
    });

    it('does not fall back to the OS keyring when the store is unreadable', async () => {
        // Silent fallback is the dangerous case: the SDK would then see null and
        // its next write would wipe the store.
        const out = await runHeadless(
            process.execPath,
            [join(pkgRoot, 'bin', 'sn-credstore.js'), 'list'],
            headlessEnv({ SN_CRED_STORE: 'file', SN_CRED_STORE_PATH: join(dir, 'does-not-exist.json') }),
        );
        expect(out).toMatch(/No credentials stored/);
        expect(out).not.toContain('headlessfixture');
    });

    (hasNowSdk ? it : it.skip)(
        'the wrapper reads the store where stock now-sdk finds nothing',
        async () => {
            const env = headlessEnv({ SN_CRED_STORE: 'file', SN_CRED_STORE_PATH: blobPath });

            const stock = await runHeadless('now-sdk', ['auth', '--list'], env);
            const wrapped = await runHeadless(process.execPath, [wrapper, 'auth', '--list'], env);

            // The whole point, in one assertion pair.
            expect(stock).not.toContain('headlessfixture');
            expect(wrapped).toContain('headlessfixture');
        },
        90_000,
    );

    (hasNowSdk ? it : it.skip)(
        'the wrapper reports the same version as stock now-sdk',
        async () => {
            // Regression: rewriting argv[1] alone left yargs resolving --version
            // from OUR package.json, so the wrapper reported 0.1.0 rather than
            // the SDK's version.
            // Compare the version line only: keyctl injects its own
            // "Joined session keyring: N" line into the captured output.
            const versionOf = (out: string): string | undefined =>
                out.split('\n').map((l) => l.trim()).find((l) => /^\d+\.\d+\.\d+/.test(l));

            const env = headlessEnv();
            const stock = versionOf(await runHeadless('now-sdk', ['--version'], env));
            const wrapped = versionOf(await runHeadless(process.execPath, [wrapper, '--version'], env));

            expect(stock).toBeDefined();
            expect(wrapped).toBe(stock);
        },
        90_000,
    );

    it('the preload sets the marker that proves it ran', async () => {
        // Consumers can assert this to refuse starting on the broken keyring path.
        const { stdout } = await execFileAsync(
            process.execPath,
            ['--require', preload, '-e', 'process.stdout.write(String(process.env.NOW_SDK_KEYCHAIN_PATCHED))'],
            { env: headlessEnv({ SN_CRED_STORE: 'file', SN_CRED_STORE_PATH: blobPath }), timeout: 30_000 },
        );
        expect(stdout.trim()).toBe('1');
    });

    it('SN_CRED_STORE_DISABLE genuinely disables the shim', async () => {
        const { stdout } = await execFileAsync(
            process.execPath,
            ['--require', preload, '-e', 'process.stdout.write(String(process.env.NOW_SDK_KEYCHAIN_PATCHED))'],
            {
                env: headlessEnv({ SN_CRED_STORE_DISABLE: '1', SN_CRED_STORE_PATH: blobPath }),
                timeout: 30_000,
            },
        );
        expect(stdout.trim()).toBe('undefined');
    });
});
