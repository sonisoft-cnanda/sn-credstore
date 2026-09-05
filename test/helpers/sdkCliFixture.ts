import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
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

function fixturePaths(base: string): SdkCliFixture {
    const packageRoot = join(base, 'node_modules', '@servicenow', 'sdk-cli');
    const keychainPath = join(packageRoot, 'dist', 'auth', 'keychain', 'index.js');
    const keyringPath = join(base, 'node_modules', '@napi-rs', 'keyring');
    return { base, packageRoot, keychainPath, keyringPath };
}

export async function ensureSdkCliFixture(version: string): Promise<SdkCliFixture> {
    const fixture = fixturePaths(join(fixtureRoot, version));
    try {
        await access(fixture.keychainPath);
        await access(join(fixture.keyringPath, 'index.js'));
        return fixture;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (process.env.SN_CRED_STORE_TEST_OFFLINE === '1') {
        throw new Error(`offline fixture missing at ${fixture.packageRoot}; prepare it without SN_CRED_STORE_TEST_OFFLINE`);
    }

    // Jest workers share this cache; publish only a fully extracted, stubbed tree.
    await mkdir(fixtureRoot, { recursive: true });
    const staging = fixturePaths(await mkdtemp(join(fixtureRoot, `${version}.tmp-`)));
    try {
        const packDir = join(staging.base, 'pack');
        await mkdir(packDir, { recursive: true });
        await run('npm', ['pack', `@servicenow/sdk-cli@${version}`, '--pack-destination', packDir]);
        const tarball = join(packDir, `servicenow-sdk-cli-${version}.tgz`);
        await mkdir(staging.packageRoot, { recursive: true });
        await run('tar', ['-xzf', tarball, '-C', staging.packageRoot, '--strip-components=1']);
        await mkdir(staging.keyringPath, { recursive: true });
        await writeFile(join(staging.keyringPath, 'package.json'), JSON.stringify({ name: '@napi-rs/keyring', main: 'index.js' }));
        await writeFile(
            join(staging.keyringPath, 'index.js'),
            "let count = 0; class Entry { constructor() { count += 1; throw new Error('OS keyring reached'); } } module.exports = { Entry, getConstructionCount: () => count };\n",
        );
        try {
            await rename(staging.base, fixture.base);
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw err;
            await access(fixture.keychainPath);
            await access(join(fixture.keyringPath, 'index.js'));
        }
    } finally {
        await rm(staging.base, { recursive: true, force: true });
    }
    return fixture;
}
