/**
 * Can this host actually run `systemd-creds --user`?
 *
 * The answer is not "is systemd-creds installed". Both `--user` and the
 * /run/systemd/io.systemd.Credentials varlink socket it rides on only exist in
 * systemd >= 256, so on a 255 host (Ubuntu 24.04, current WSL images) the
 * binary is present, `--version` exits 0, and every real encrypt/decrypt dies
 * with "unrecognized option '--user'". Detection therefore has to be
 * version-aware, and it has to be synchronous — createStore() runs on the
 * shim's module-load path where an await is not an option.
 */
import { existsSync as fsExistsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export const VARLINK_SOCKET = '/run/systemd/io.systemd.Credentials';

/** `systemd-creds --user` and the varlink socket both arrived in this release. */
export const MIN_SYSTEMD_VERSION = 256;

export interface SystemdUserCredsSupport {
    supported: boolean;
    /** Why not, phrased for an error message. Absent when supported. */
    reason?: string;
    systemdVersion?: number | null;
}

export interface SystemdDetectDeps {
    existsSync(path: string): boolean;
    /** stdout of `systemd-creds --version`, or null if it could not be run. */
    getVersionOutput(): string | null;
    getuid(): number | undefined;
}

const defaultDeps: SystemdDetectDeps = {
    existsSync: fsExistsSync,
    getVersionOutput: () => {
        try {
            const res = spawnSync('systemd-creds', ['--version'], {
                encoding: 'utf8',
                timeout: 5_000,
            });
            if (res.error || res.status !== 0) return null;
            return res.stdout;
        } catch {
            return null;
        }
    },
    getuid: () => process.getuid?.(),
};

/** First line looks like `systemd 255 (255.4-1ubuntu8.17)`. */
export function parseSystemdVersion(output: string): number | null {
    const match = /systemd (\d+)/.exec(output);
    return match ? Number(match[1]) : null;
}

export function detectSystemdUserCredsSupport(
    deps: Partial<SystemdDetectDeps> = {},
): SystemdUserCredsSupport {
    const d = { ...defaultDeps, ...deps };

    // The socket only exists when systemd >= 256 is running as the service
    // manager, so its presence answers everything with a single stat — the
    // common healthy path never pays for a subprocess.
    if (d.existsSync(VARLINK_SOCKET)) return { supported: true };

    const output = d.getVersionOutput();
    if (output === null) {
        return {
            supported: false,
            reason: 'systemd-creds is not installed or not runnable on this host',
        };
    }

    const systemdVersion = parseSystemdVersion(output);
    if (systemdVersion !== null && systemdVersion < MIN_SYSTEMD_VERSION) {
        return {
            supported: false,
            systemdVersion,
            reason:
                `systemd ${systemdVersion} detected; ` +
                `systemd-creds --user requires systemd >= ${MIN_SYSTEMD_VERSION}`,
        };
    }

    // Version is new enough (or unparseable — trust the working binary). Root
    // can reach the host key directly without the socket; everyone else needs
    // the socket, so its absence means systemd is not the service manager here.
    if (d.getuid() === 0) return { supported: true, systemdVersion };

    return {
        supported: false,
        systemdVersion,
        reason:
            `${VARLINK_SOCKET} is missing — systemd is not running as the ` +
            `service manager (container without systemd?)`,
    };
}
