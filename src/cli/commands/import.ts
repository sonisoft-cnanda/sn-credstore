/**
 * Migrate credentials into the store.
 *
 * Two sources:
 *   --from keyring : read the SDK's existing OS-keyring blob. Must run from a
 *                    desktop session, because the wallet will prompt.
 *   --stdin        : a keystore JSON on stdin, for headless provisioning.
 *
 * The keyring copy is NEVER deleted here. It is the rollback path, and removing
 * it is a separate, explicit act.
 */
import { ResolvedConfig } from '../../config.js';
import { KeyringStore } from '../../store/KeyringStore.js';
import { createStore } from '../../store/StoreFactory.js';
import { parseKeyStore, KeyStore } from '../../types.js';
import { vaultFor } from '../../api.js';
import { copyKeyStore } from '../../vault/transfer.js';
import { hasFlag, flagValue } from '../main.js';

function describeEntry(alias: string, entry: KeyStore[string]): string {
    const c = entry.creds;
    const detail =
        c.type === 'oauth'
            ? `expires ${new Date(c.expires_at * 1000).toISOString()}${
                  c.expires_at * 1000 < Date.now() ? ' (EXPIRED — will refresh on first use)' : ''
              }`
            : `username ${c.username}`;
    return `  ${entry.isDefault ? '*' : ' '} ${alias.padEnd(20)} ${c.type.padEnd(6)} ${c.instanceUrl}  [${detail}]`;
}

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
}

export async function cmdImport(argv: string[], config: ResolvedConfig): Promise<number> {
    const dryRun = hasFlag(argv, '--dry-run', '-n');
    const overwrite = hasFlag(argv, '--overwrite');
    const from = flagValue(argv, '--from');
    const fromStdin = hasFlag(argv, '--stdin');

    if (!fromStdin && from !== 'keyring') {
        process.stderr.write('sn-credstore import: specify --from keyring or --stdin\n');
        return 2;
    }

    // 1. Read the source.
    let sourceBlob: string | null;
    if (fromStdin) {
        sourceBlob = (await readStdin()).trim() || null;
    } else {
        const keyring = new KeyringStore(25_000);
        process.stderr.write('Reading the OS keyring — this may prompt for your wallet password.\n');
        sourceBlob = (await keyring.read()).blob;
    }

    if (sourceBlob === null) {
        process.stderr.write('Nothing to import: the source is empty.\n');
        return 1;
    }

    const parsed = parseKeyStore(sourceBlob);
    let source: KeyStore;
    try { source = copyKeyStore(parsed); }
    catch {
        process.stderr.write('Nothing to import: the source is not a valid keystore.\n');
        return 1;
    }

    // 2. Report what we found, secrets never printed.
    const aliases = Object.keys(source);
    process.stdout.write(`Found ${aliases.length} credential(s):\n`);
    for (const alias of aliases) process.stdout.write(`${describeEntry(alias, source[alias]!)}\n`);

    if (dryRun) {
        process.stdout.write('\nDry run — nothing was written.\n');
        return 0;
    }

    const dest = createStore(config);
    const vault = vaultFor(config);
    const { imported, skipped, verified } = await vault.importCredentialSnapshot(source, overwrite);
    if (skipped.length > 0) {
        process.stdout.write(`\nSkipping ${skipped.length} alias(es) already present: ${skipped.join(', ')}\nUse --overwrite to replace them.\n`);
    }

    process.stdout.write(
        `\nImported ${imported} credential(s) into ${dest.describe()}\n` +
            `Verified ${Object.keys(verified).length} alias(es) readable.\n`,
    );
    if (from === 'keyring') {
        process.stdout.write(
            'The OS keyring copy was left intact as a rollback path. ' +
                'Remove it later with: now-sdk auth --delete all\n',
        );
    }
    return 0;
}
