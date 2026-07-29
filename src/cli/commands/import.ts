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
import { parseKeyStore, serializeKeyStore, KeyStore } from '../../types.js';
import { mergeKeyStores, normalizeDefaults } from '../../vault/merge.js';
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

    const source = parseKeyStore(sourceBlob);
    if (source === null) {
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

    // 3. Merge into the destination rather than replacing it.
    const dest = createStore(config);
    const { blob: existingBlob } = await dest.read();
    const existing = existingBlob === null ? {} : (parseKeyStore(existingBlob) ?? {});

    const collisions = aliases.filter((a) => existing[a] !== undefined);
    if (collisions.length > 0 && !overwrite) {
        process.stdout.write(
            `\nSkipping ${collisions.length} alias(es) already present: ${collisions.join(', ')}\n` +
                `Use --overwrite to replace them.\n`,
        );
    }

    const incoming: KeyStore = { ...existing };
    let imported = 0;
    for (const alias of aliases) {
        if (existing[alias] !== undefined && !overwrite) continue;
        incoming[alias] = source[alias]!;
        imported++;
    }

    // allowRemovals stays false: an import must never delete anything.
    const { merged } = mergeKeyStores(existing, incoming, existing, { allowRemovals: false });
    const preferred = Object.keys(source).find((a) => source[a]?.isDefault);
    const finalStore = normalizeDefaults(merged, preferred);

    await dest.write(serializeKeyStore(finalStore));

    // 4. Verify the round trip rather than trusting the write.
    const { blob: verifyBlob } = await dest.read();
    const verified = verifyBlob === null ? null : parseKeyStore(verifyBlob);
    if (verified === null || Object.keys(verified).length !== Object.keys(finalStore).length) {
        process.stderr.write('Import wrote but could not be verified by reading back. Check `sn-credstore doctor`.\n');
        return 1;
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
