/**
 * List stored aliases. Secrets are never printed — see `show --reveal` for that.
 */
import { ResolvedConfig } from '../../config.js';
import { createStore } from '../../store/StoreFactory.js';
import { parseKeyStore } from '../../types.js';
import { hasFlag } from '../main.js';

export async function cmdList(argv: string[], config: ResolvedConfig): Promise<number> {
    const json = hasFlag(argv, '--json');
    const store = createStore(config);
    const { blob } = await store.read();

    const parsed = blob === null ? {} : (parseKeyStore(blob) ?? {});
    const aliases = Object.keys(parsed).sort();

    if (json) {
        // Deliberately projected, not the raw entries — a --json flag is exactly
        // where secrets end up piped into a log otherwise.
        process.stdout.write(
            `${JSON.stringify(
                {
                    store: store.id,
                    path: config.blobPath,
                    credentials: aliases.map((alias) => {
                        const e = parsed[alias]!;
                        return {
                            alias,
                            isDefault: e.isDefault,
                            type: e.creds.type,
                            instanceUrl: e.creds.instanceUrl,
                            ...(e.creds.type === 'oauth'
                                ? { expiresAt: e.creds.expires_at, expired: e.creds.expires_at * 1000 < Date.now() }
                                : { username: e.creds.username }),
                        };
                    }),
                },
                null,
                2,
            )}\n`,
        );
        return 0;
    }

    if (aliases.length === 0) {
        process.stdout.write(
            `No credentials stored in ${store.describe()}\n\n` +
                `Import existing ones:  sn-credstore import --from keyring\n` +
                `Or add a new one:      now-sdk-x auth --add <instance>\n`,
        );
        return 0;
    }

    process.stdout.write(`${store.describe()}\n\n`);
    for (const alias of aliases) {
        const e = parsed[alias]!;
        const c = e.creds;
        process.stdout.write(`${e.isDefault ? '*' : ' '} ${alias}\n`);
        process.stdout.write(`      host = ${c.instanceUrl}\n`);
        process.stdout.write(`      type = ${c.type}\n`);
        if (c.type === 'basic') {
            process.stdout.write(`      username = ${c.username}\n`);
        } else {
            const expired = c.expires_at * 1000 < Date.now();
            process.stdout.write(
                `      expires = ${new Date(c.expires_at * 1000).toISOString()}${expired ? '  (EXPIRED — refreshes on next use)' : ''}\n`,
            );
        }
    }
    return 0;
}
