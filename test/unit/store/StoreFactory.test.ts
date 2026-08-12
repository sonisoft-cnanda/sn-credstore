import { describe, it, expect } from '@jest/globals';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../../../src/store/StoreFactory.js';
import { FileStore } from '../../../src/store/FileStore.js';
import { SystemdCredsStore } from '../../../src/store/SystemdCredsStore.js';
import { PlaintextNotPermittedError } from '../../../src/errors.js';
import type { ResolvedConfig } from '../../../src/config.js';

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
    return {
        store: 'auto',
        blobPath: join(tmpdir(), 'sncs-factory-test', 'credentials.json'),
        systemdKey: 'host',
        allowPlaintext: false,
        lockTimeoutMs: 1000,
        disabled: false,
        ...overrides,
    };
}

const UNSUPPORTED = {
    supported: false,
    systemdVersion: 255,
    reason: 'systemd 255 detected; systemd-creds --user requires systemd >= 256',
};

describe('createStore', () => {
    it('returns FileStore for an explicit file selection', () => {
        expect(createStore(config({ store: 'file' }))).toBeInstanceOf(FileStore);
    });

    it('returns SystemdCredsStore for an explicit selection even on an unsupported host', () => {
        const store = createStore(config({ store: 'systemd-creds' }), { systemdSupport: UNSUPPORTED });
        expect(store).toBeInstanceOf(SystemdCredsStore);
    });

    it('refuses the keyring as an active store', () => {
        expect(() => createStore(config({ store: 'keyring' }))).toThrow(PlaintextNotPermittedError);
    });

    it('auto picks SystemdCredsStore when the host supports it', () => {
        const store = createStore(config(), { systemdSupport: { supported: true } });
        expect(store).toBeInstanceOf(SystemdCredsStore);
    });

    it('auto refuses on an unsupported host when plaintext is not permitted', () => {
        let thrown: unknown;
        try {
            createStore(config(), { systemdSupport: UNSUPPORTED });
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeInstanceOf(PlaintextNotPermittedError);
        const err = thrown as PlaintextNotPermittedError;
        expect(err.message).toContain('systemd 255');
        expect(err.remediation).toContain('SN_CRED_STORE_ALLOW_PLAINTEXT');
        expect(err.remediation).toContain('SN_CRED_STORE=file');
    });

    it('auto falls back to FileStore on an unsupported host when plaintext is permitted', () => {
        const store = createStore(config({ allowPlaintext: true }), { systemdSupport: UNSUPPORTED });
        expect(store).toBeInstanceOf(FileStore);
    });
});
