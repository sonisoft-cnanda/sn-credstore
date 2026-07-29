/**
 * Convert the store between backends in place.
 *
 * Reads through the CURRENT backend, writes through the TARGET one, then
 * verifies by reading back through the target before reporting success. A
 * backup of the original file is kept, because a failed migration that has
 * already overwritten the blob is unrecoverable — systemd-creds blobs cannot be
 * decrypted anywhere but the host that wrote them.
 */
import { ResolvedConfig, StoreId } from '../../config.js';
import { createStore } from '../../store/StoreFactory.js';
import { FileStore } from '../../store/FileStore.js';
import { SystemdCredsStore } from '../../store/SystemdCredsStore.js';
import { ICredentialStore } from '../../store/ICredentialStore.js';
import { parseKeyStore } from '../../types.js';
import { writeFileAtomic, readFileVersioned } from '../../store/atomicFile.js';
import { flagValue, hasFlag } from '../main.js';
import { StoreUnavailableError } from '../../errors.js';

function storeById(id: StoreId, config: ResolvedConfig): ICredentialStore {
    if (id === 'file') return new FileStore(config.blobPath);
    if (id === 'systemd-creds') return new SystemdCredsStore(config.blobPath, config.systemdKey);
    throw new StoreUnavailableError(
        `cannot migrate to "${id}"`,
        'Valid targets are: file, systemd-creds',
        { storeId: id },
    );
}

export async function cmdMigrate(argv: string[], config: ResolvedConfig): Promise<number> {
    const target = flagValue(argv, '--to') as StoreId | undefined;
    const dryRun = hasFlag(argv, '--dry-run', '-n');

    if (target !== 'file' && target !== 'systemd-creds') {
        process.stderr.write('sn-credstore migrate: --to file | systemd-creds\n');
        return 2;
    }

    const source = createStore(config);
    const dest = storeById(target, config);

    if (source.id === dest.id) {
        process.stdout.write(`Already using ${dest.describe()} — nothing to do.\n`);
        return 0;
    }

    if (!(await dest.isAvailable())) {
        throw new StoreUnavailableError(
            `the "${target}" backend is not usable on this host`,
            target === 'systemd-creds'
                ? 'systemd-creds needs /run/systemd/io.systemd.Credentials. In a container without systemd, ' +
                  'use SN_CRED_STORE=file SN_CRED_STORE_ALLOW_PLAINTEXT=1.'
                : 'Check the directory permissions for the store path.',
            { storeId: target },
        );
    }

    const { blob } = await source.read();
    if (blob === null) {
        process.stdout.write(`Nothing stored yet — switch with SN_CRED_STORE=${target}\n`);
        return 0;
    }

    const parsed = parseKeyStore(blob);
    if (parsed === null) {
        process.stderr.write('Refusing to migrate: the current store is not a valid keystore.\n');
        return 1;
    }

    const aliases = Object.keys(parsed);
    process.stdout.write(`Migrating ${aliases.length} alias(es): ${aliases.join(', ')}\n`);
    process.stdout.write(`  from: ${source.describe()}\n    to: ${dest.describe()}\n`);

    if (dryRun) {
        process.stdout.write('\nDry run — nothing was written.\n');
        return 0;
    }

    // Keep the original. A half-finished migration that has already overwritten
    // the blob is not recoverable, and encrypted blobs are host-bound.
    const { content } = await readFileVersioned(config.blobPath);
    const backupPath = `${config.blobPath}.backup-${Date.now()}`;
    if (content !== null) {
        await writeFileAtomic(backupPath, content);
        process.stdout.write(`  backup: ${backupPath}\n`);

        // Migrating file -> systemd-creds leaves the ORIGINAL, which is
        // plaintext. Saying nothing would hand someone an encrypted store with
        // a cleartext copy of the same credentials sitting beside it —
        // undoing exactly what they just asked for.
        if (source.id === 'file') {
            process.stdout.write(
                `\n  WARNING: that backup is UNENCRYPTED — it is a copy of the plaintext store.\n` +
                    `  Once you have verified the migration, delete it:\n` +
                    `      rm ${backupPath}\n`,
            );
        }
    }

    await dest.write(blob);

    // Verify through the TARGET backend, not by trusting the write.
    const verify = await dest.read();
    const verified = verify.blob === null ? null : parseKeyStore(verify.blob);
    if (verified === null || Object.keys(verified).length !== aliases.length) {
        process.stderr.write(
            `\nMigration could not be verified. The original is preserved at ${backupPath}.\n` +
                `Restore it with: cp ${backupPath} ${config.blobPath}\n`,
        );
        return 1;
    }

    process.stdout.write(
        `\nMigrated and verified ${Object.keys(verified).length} alias(es).\n` +
            `Set SN_CRED_STORE=${target} (or leave it unset if that is the default) to use it.\n`,
    );
    return 0;
}
