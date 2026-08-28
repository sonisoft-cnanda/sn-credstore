import { execFile } from 'node:child_process';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { sanitizeProcessError } from '../../src/redact.js';

const execFileAsync = promisify(execFile);
const fixtureRoot = resolve(process.cwd(), '.fixtures', 'sdk-cli');

export interface SdkCliFixture {
    base: string;
    packageRoot: string;
    keychainPath: string;
    keyringPath: string;
}

async function run(command: string, args: string[]): Promise<void> {
    try {
        await execFileAsync(command, args, { timeout: 120_000 });
    } catch (err) {
        throw new Error(`published-package fixture command failed: ${JSON.stringify(sanitizeProcessError(err))}`);
    }
}

export async function ensureSdkCliFixture(version: string): Promise<SdkCliFixture> {
    const base = join(fixtureRoot, version);
    const packageRoot = join(base, 'node_modules', '@servicenow', 'sdk-cli');
    const keychainPath = join(packageRoot, 'dist', 'auth', 'keychain', 'index.js');
    const keyringPath = join(base, 'node_modules', '@napi-rs', 'keyring');

    try {
        await access(keychainPath);
    } catch {
        if (process.env.SN_CRED_STORE_TEST_OFFLINE === '1') {
            throw new Error(`offline fixture missing at ${packageRoot}; prepare it without SN_CRED_STORE_TEST_OFFLINE`);
        }
        await rm(base, { recursive: true, force: true });
        const packDir = join(base, 'pack');
        await mkdir(packDir, { recursive: true });
        await run('npm', ['pack', `@servicenow/sdk-cli@${version}`, '--pack-destination', packDir]);
        const tarball = join(packDir, `servicenow-sdk-cli-${version}.tgz`);
        await mkdir(packageRoot, { recursive: true });
        await run('tar', ['-xzf', tarball, '-C', packageRoot, '--strip-components=1']);
    }

    await mkdir(keyringPath, { recursive: true });
    await writeFile(join(keyringPath, 'package.json'), JSON.stringify({ name: '@napi-rs/keyring', main: 'index.js' }));
    await writeFile(
        join(keyringPath, 'index.js'),
        "let count = 0; class Entry { constructor() { count += 1; throw new Error('OS keyring reached'); } } module.exports = { Entry, getConstructionCount: () => count };\n",
    );
    return { base, packageRoot, keychainPath, keyringPath };
}
