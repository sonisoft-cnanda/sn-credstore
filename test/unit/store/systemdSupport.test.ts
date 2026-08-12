import { describe, it, expect, jest } from '@jest/globals';
import {
    detectSystemdUserCredsSupport,
    parseSystemdVersion,
    VARLINK_SOCKET,
    MIN_SYSTEMD_VERSION,
} from '../../../src/store/systemdSupport.js';

const V255 = 'systemd 255 (255.4-1ubuntu8.17)\n+PAM +AUDIT +SELINUX\n';
const V257 = 'systemd 257 (257.1)\n';

describe('parseSystemdVersion', () => {
    it('parses the Ubuntu-style banner', () => {
        expect(parseSystemdVersion(V255)).toBe(255);
    });

    it('parses a bare version line', () => {
        expect(parseSystemdVersion('systemd 256.7')).toBe(256);
    });

    it('returns null for garbage', () => {
        expect(parseSystemdVersion('not systemd output')).toBeNull();
    });
});

describe('detectSystemdUserCredsSupport', () => {
    it('is supported when the varlink socket exists, without spawning', () => {
        const getVersionOutput = jest.fn<() => string | null>();
        const result = detectSystemdUserCredsSupport({
            existsSync: (p) => p === VARLINK_SOCKET,
            getVersionOutput,
        });
        expect(result.supported).toBe(true);
        expect(getVersionOutput).not.toHaveBeenCalled();
    });

    it('is unsupported when systemd-creds cannot be run at all', () => {
        const result = detectSystemdUserCredsSupport({
            existsSync: () => false,
            getVersionOutput: () => null,
        });
        expect(result.supported).toBe(false);
        expect(result.reason).toContain('not installed');
    });

    it('is unsupported on systemd 255 for a normal user', () => {
        const result = detectSystemdUserCredsSupport({
            existsSync: () => false,
            getVersionOutput: () => V255,
            getuid: () => 1000,
        });
        expect(result.supported).toBe(false);
        expect(result.systemdVersion).toBe(255);
        expect(result.reason).toContain('systemd 255');
        expect(result.reason).toContain(`>= ${MIN_SYSTEMD_VERSION}`);
    });

    it('is unsupported on systemd 255 even as root — the flag does not exist there', () => {
        const result = detectSystemdUserCredsSupport({
            existsSync: () => false,
            getVersionOutput: () => V255,
            getuid: () => 0,
        });
        expect(result.supported).toBe(false);
        expect(result.reason).toContain('systemd 255');
    });

    it('is supported for root on systemd >= 256 without the socket', () => {
        const result = detectSystemdUserCredsSupport({
            existsSync: () => false,
            getVersionOutput: () => V257,
            getuid: () => 0,
        });
        expect(result.supported).toBe(true);
        expect(result.systemdVersion).toBe(257);
    });

    it('is unsupported for a normal user on systemd >= 256 when the socket is missing', () => {
        const result = detectSystemdUserCredsSupport({
            existsSync: () => false,
            getVersionOutput: () => V257,
            getuid: () => 1000,
        });
        expect(result.supported).toBe(false);
        expect(result.reason).toContain(VARLINK_SOCKET);
    });
});
