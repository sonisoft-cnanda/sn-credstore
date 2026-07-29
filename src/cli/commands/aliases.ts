/**
 * Per-alias operations: use (set default), delete, show.
 *
 * Deletes go through the vault's explicit removal intent — otherwise the clobber
 * guard would (correctly) refuse them, since a delete looks exactly like the
 * store-wipe it exists to prevent.
 */
import { ResolvedConfig } from '../../config.js';
import { createStore } from '../../store/StoreFactory.js';
import { CredentialVault } from '../../vault/CredentialVault.js';
import { parseKeyStore, serializeKeyStore } from '../../types.js';
import { normalizeDefaults } from '../../vault/merge.js';
import { maskValue } from '../../redact.js';
import { hasFlag } from '../main.js';

function vaultFor(config: ResolvedConfig): CredentialVault {
    return new CredentialVault(createStore(config), {
        blobPath: config.blobPath,
        lockTimeoutMs: config.lockTimeoutMs,
    });
}

export async function cmdUse(argv: string[], config: ResolvedConfig): Promise<number> {
    const alias = argv.find((a) => !a.startsWith('-'));
    if (alias === undefined) {
        process.stderr.write('sn-credstore use: an alias is required\n');
        return 2;
    }

    const vault = vaultFor(config);
    const blob = await vault.getPassword();
    const store = blob === null ? null : parseKeyStore(blob);
    if (store === null || store[alias] === undefined) {
        process.stderr.write(`sn-credstore use: no such alias "${alias}"\n`);
        return 1;
    }

    await vault.setPassword(serializeKeyStore(normalizeDefaults(store, alias)));
    process.stdout.write(`Default alias is now "${alias}"\n`);
    return 0;
}

export async function cmdDelete(argv: string[], config: ResolvedConfig): Promise<number> {
    const all = hasFlag(argv, '--all');
    const alias = argv.find((a) => !a.startsWith('-'));

    if (!all && alias === undefined) {
        process.stderr.write('sn-credstore delete: an alias is required, or --all\n');
        return 2;
    }

    const vault = vaultFor(config);

    if (all) {
        await vault.deletePassword();
        process.stdout.write('Removed all stored credentials.\n');
        return 0;
    }

    const blob = await vault.getPassword();
    const store = blob === null ? null : parseKeyStore(blob);
    if (store === null || store[alias!] === undefined) {
        process.stderr.write(`sn-credstore delete: no such alias "${alias}"\n`);
        return 1;
    }

    const next = { ...store };
    delete next[alias!];

    // Without this the clobber guard refuses the write — a deliberate delete is
    // indistinguishable from an accidental wipe unless intent is declared.
    await vault.withRemovalIntent(async () => {
        await vault.setPassword(serializeKeyStore(normalizeDefaults(next)));
    });

    process.stdout.write(`Removed "${alias}".\n`);
    return 0;
}

export async function cmdShow(argv: string[], config: ResolvedConfig): Promise<number> {
    const reveal = hasFlag(argv, '--reveal');
    const alias = argv.find((a) => !a.startsWith('-'));
    if (alias === undefined) {
        process.stderr.write('sn-credstore show: an alias is required\n');
        return 2;
    }

    const { blob } = await createStore(config).read();
    const store = blob === null ? null : parseKeyStore(blob);
    const entry = store?.[alias];
    if (entry === undefined) {
        process.stderr.write(`sn-credstore show: no such alias "${alias}"\n`);
        return 1;
    }

    const c = entry.creds;
    process.stdout.write(`${alias}${entry.isDefault ? ' (default)' : ''}\n`);
    process.stdout.write(`  host = ${c.instanceUrl}\n`);
    process.stdout.write(`  type = ${c.type}\n`);

    if (c.type === 'basic') {
        process.stdout.write(`  username = ${c.username}\n`);
        process.stdout.write(`  password = ${reveal ? c.password : maskValue(c.password)}\n`);
    } else {
        process.stdout.write(`  expires = ${new Date(c.expires_at * 1000).toISOString()}\n`);
        process.stdout.write(`  access_token  = ${reveal ? c.access_token : maskValue(c.access_token)}\n`);
        process.stdout.write(`  refresh_token = ${reveal ? c.refresh_token : maskValue(c.refresh_token)}\n`);
    }

    if (!reveal) process.stdout.write('\n(secrets masked — pass --reveal to print them)\n');
    return 0;
}
