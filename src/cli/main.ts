/**
 * Zero-dependency CLI.
 *
 * Hand-rolled argv parsing rather than yargs/commander so this package stays
 * installable standalone for the `now-sdk-x` wrapper without pulling a parser
 * (and its transitive tree) onto a machine that only needs credential storage.
 */
import { loadConfig } from '../config.js';
import { cmdImport } from './commands/import.js';
import { cmdList } from './commands/list.js';
import { cmdBackend } from './commands/backend.js';
import { cmdDoctor } from './commands/doctor.js';
import { cmdMigrate } from './commands/migrate.js';
import { cmdUse, cmdDelete, cmdShow } from './commands/aliases.js';
import { isCredentialStoreError } from '../errors.js';

const USAGE = `sn-credstore — headless-safe credential storage for the ServiceNow SDK

USAGE
  sn-credstore <command> [options]

COMMANDS
  list [--json]                       List stored aliases (secrets masked)
  show <alias> [--reveal]             Show one alias; --reveal prints secrets
  use <alias>                         Set the default alias
  delete <alias> | --all              Remove an alias, or every alias
  import --from keyring [--dry-run]   Migrate credentials out of the OS keyring
  import --stdin                      Read a keystore JSON from stdin
  backend                             Show the active backend and probe others
  migrate --to <backend>              Convert the store between backends
  doctor [--json]                     Diagnose the store, shim and SDK copies
  preload-path                        Print the absolute path of preload.cjs

ENVIRONMENT
  SN_CRED_STORE            systemd-creds (default) | file | keyring | auto
  SN_CRED_STORE_PATH       Override the blob location
  SN_CRED_STORE_KEY        systemd-creds key: host (default) | tpm2 | host+tpm2
  SN_CRED_STORE_DEBUG      Verbose diagnostics on stderr
  SN_CRED_STORE_DISABLE    Disable the shim entirely (falls back to the keyring)
`;

export function hasFlag(argv: string[], ...names: string[]): boolean {
    return argv.some((a) => names.includes(a));
}

export function flagValue(argv: string[], name: string): string | undefined {
    const eq = argv.find((a) => a.startsWith(`${name}=`));
    if (eq) return eq.slice(name.length + 1);
    const idx = argv.indexOf(name);
    if (idx >= 0 && argv[idx + 1] && !argv[idx + 1]!.startsWith('-')) return argv[idx + 1];
    return undefined;
}

export async function main(argv: string[]): Promise<number> {
    const [command, ...rest] = argv;

    if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
        process.stdout.write(USAGE);
        return 0;
    }

    const config = loadConfig();

    try {
        switch (command) {
            case 'list':
                return await cmdList(rest, config);
            case 'show':
                return await cmdShow(rest, config);
            case 'use':
                return await cmdUse(rest, config);
            case 'delete':
                return await cmdDelete(rest, config);
            case 'import':
                return await cmdImport(rest, config);
            case 'backend':
                return await cmdBackend(rest, config);
            case 'doctor':
                return await cmdDoctor(rest, config);
            case 'migrate':
                return await cmdMigrate(rest, config);
            case 'preload-path': {
                // Derived from argv[1] (bin/sn-credstore.js -> package root)
                // rather than import.meta.url, because this module is compiled
                // to CommonJS as well and import.meta is a syntax error there.
                const { resolve, dirname } = await import('node:path');
                const binPath = process.argv[1];
                if (binPath === undefined) {
                    process.stderr.write('sn-credstore: cannot determine the package root\n');
                    return 1;
                }
                process.stdout.write(`${resolve(dirname(binPath), '..', 'preload.cjs')}\n`);
                return 0;
            }
            default:
                process.stderr.write(`sn-credstore: unknown command "${command}"\n\n${USAGE}`);
                return 2;
        }
    } catch (err) {
        // Typed errors carry remediation; that is the whole point of them.
        if (isCredentialStoreError(err)) {
            process.stderr.write(`${err.message}\n\nRemediation: ${err.remediation}\n`);
        } else {
            process.stderr.write(`sn-credstore: ${(err as Error).message}\n`);
        }
        return 1;
    }
}
