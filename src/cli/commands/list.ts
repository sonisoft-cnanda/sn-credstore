/**
 * List stored aliases. Secrets are never printed — see `show --reveal` for that.
 *
 * Rendering only; the read lives in ../../api.ts so that `nex auth list` and
 * this command cannot drift apart.
 */
import { ResolvedConfig } from '../../config.js';
import { listAliases } from '../../api.js';
import { hasFlag } from '../main.js';

export async function cmdList(argv: string[], config: ResolvedConfig): Promise<number> {
    const summary = await listAliases(config);

    if (hasFlag(argv, '--json')) {
        // Deliberately the projected metadata, not the raw entries — a --json
        // flag is exactly where secrets end up piped into a log otherwise.
        process.stdout.write(
            `${JSON.stringify(
                { store: summary.store, path: summary.path, credentials: summary.aliases },
                null,
                2,
            )}\n`,
        );
        return 0;
    }

    if (summary.aliases.length === 0) {
        process.stdout.write(
            `No credentials stored in ${summary.description}\n\n` +
                `Import existing ones:  sn-credstore import --from keyring\n` +
                `Or add a new one:      now-sdk-x auth --add <instance>\n`,
        );
        return 0;
    }

    process.stdout.write(`${summary.description}\n\n`);
    for (const info of summary.aliases) {
        process.stdout.write(`${info.isDefault ? '*' : ' '} ${info.alias}\n`);
        process.stdout.write(`      host = ${info.instanceUrl}\n`);
        process.stdout.write(`      type = ${info.type}\n`);
        if (info.type === 'basic') {
            process.stdout.write(`      username = ${info.username}\n`);
        } else {
            process.stdout.write(
                `      expires = ${new Date(info.expiresAt! * 1000).toISOString()}` +
                    `${info.expired ? '  (EXPIRED — refreshes on next use)' : ''}\n`,
            );
        }
    }
    return 0;
}
