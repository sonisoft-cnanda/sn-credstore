import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp, writeFile, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {listAliases} from '../dist/esm/index.js';
import {sanitizeProcessError} from '../dist/esm/redact.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sdkHome = process.env.SN_SDK_HOME && resolve(process.env.SN_SDK_HOME);
if (!sdkHome) throw new Error('Set SN_SDK_HOME to an installed @servicenow/sdk package.');
const sandbox = await mkdtemp(join(tmpdir(), 'sn-refresh-'));
const path = join(sandbox, 'credentials.json');
let refreshes = 0;
const server = createServer(async (request, response) => {
    let body = '';
    for await (const part of request) body += part;
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/oauth_token.do') {
        const form = new URLSearchParams(body);
        if (form.get('refresh_token') !== 'synthetic-refresh-old') {
            response.writeHead(400);
            response.end(JSON.stringify({error: 'invalid_grant'}));
            return;
        }
        refreshes++;
        response.end(JSON.stringify({access_token: 'synthetic-access-new', refresh_token: 'synthetic-refresh-new',
            expires_in: 3600, token_type: 'Bearer'}));
    } else if (request.url?.startsWith('/angular.do')) {
        response.setHeader('Set-Cookie', 'JSESSIONID=synthetic-session; Path=/; HttpOnly');
        response.end(JSON.stringify({result: {user_id: 'synthetic-user', user_name: 'tester'}}));
    } else {
        response.end(JSON.stringify({result: []}));
    }
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
const instanceUrl = 'http://127.0.0.1:' + address.port;
const env = {...process.env, SN_CRED_STORE: 'file', SN_CRED_STORE_PATH: path,
    SN_CRED_STORE_ENABLE: '1', SN_SDK_HOME: sdkHome, SN_SDK_TELEMETRY: '0'};
for (const key of ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'DISPLAY', 'WAYLAND_DISPLAY',
    'SN_SDK_SESSION_TOKEN', 'SN_SDK_SESSION_BEARER_TOKEN', 'SN_SDK_NODE_ENV', 'SN_CRED_STORE_DISABLE']) delete env[key];
const config = {store: 'file', blobPath: path, systemdKey: 'host', allowPlaintext: true, lockTimeoutMs: 60000, disabled: false};
assert.equal((await listAliases(config)).path, path);
async function seed() {
    refreshes = 0;
    await writeFile(path, JSON.stringify({
        test: {alias: 'test', isDefault: true, creds: {type: 'oauth', instanceUrl,
            access_token: 'synthetic-access-old', refresh_token: 'synthetic-refresh-old',
            token_type: 'Bearer', expires_at: Math.floor(Date.now() / 1000) - 1}},
        survivor: {alias: 'survivor', isDefault: false,
            creds: {type: 'basic', instanceUrl, username: 'synthetic-user', password: 'synthetic-password'}},
    }), {mode: 0o600});
}
function run(args) {
    return new Promise((resolveRun, reject) => {
        const child = spawn(process.execPath, args, {env, cwd: sandbox, stdio: ['ignore', 'pipe', 'pipe']});
        let output = '';
        child.stdout.on('data', value => { output += value; });
        child.stderr.on('data', value => { output += value; });
        const timer = setTimeout(() => child.kill('SIGKILL'), 300000);
        child.on('error', error => { clearTimeout(timer); sanitizeProcessError(error); reject(new Error('Child could not start')); });
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            const exposed = ['synthetic-access-', 'synthetic-refresh-', 'synthetic-password', 'synthetic-session']
                .some(value => output.includes(value));
            if (process.env.REFRESH_DIAGNOSTICS) process.stdout.write(JSON.stringify({code, signal, exposed, warnings: /refusing|malformed|failed to|proceeding without|expired without/.test(output)}) + '\n');
            if (code !== 0 || signal || exposed) reject(new Error('Refresh subprocess failed or exposed synthetic secrets; exit=' + code));
            else resolveRun();
        });
    });
}
async function verify() {
    const data = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(refreshes, 1);
    assert.deepEqual(Object.keys(data).sort(), ['survivor', 'test']);
    assert.ok(data.test.creds.refresh_token === 'synthetic-refresh-new', 'Rotated refresh token was not persisted');
    assert.equal(Object.values(data).filter(value => value.isDefault).length, 1);
    assert.ok(!(await readdir(sandbox)).some(name => name.includes('.tmp.') || name.endsWith('.lock')));
}
try {
    await seed();
    const resolver = "const {createRequire}=require('node:module'); const req=createRequire(process.env.SN_SDK_HOME+'/package.json'); const auth=req('@servicenow/sdk-cli/dist/auth/index.js'); auth.getCredentials('test').then(c=>{if(c.expires_at<=Date.now()/1000)process.exitCode=2}).catch(()=>{process.exitCode=1});";
    await Promise.all(Array.from({length: Number(process.env.REFRESH_CLIENTS || 20)}, () => run(['--require', join(root, 'preload.cjs'), '-e', resolver])));
    await verify();
    process.stdout.write('PASS: stripped-session SDK processes, exactly one refresh, aliases/default preserved, no secret output or leftover locks/temp files\n');
    const crashScript = `
        const fs = require('node:fs/promises');
        const {acquireLock} = require(process.argv[1] + '/dist/cjs/lock/FileLock.js');
        const {writeFileAtomic} = require(process.argv[1] + '/dist/cjs/store/atomicFile.js');
        fs.rename = async () => { process.send('before-rename'); await new Promise(() => setInterval(() => {}, 1000)); };
        (async () => {
            await acquireLock(process.env.SN_CRED_STORE_PATH + '.lock', {timeoutMs: 2000, op: 'crash-test'});
            await writeFileAtomic(process.env.SN_CRED_STORE_PATH, await fs.readFile(process.env.SN_CRED_STORE_PATH, 'utf8'));
        })().catch(() => process.exit(1));
    `;
    const crashed = spawn(process.execPath, ['-e', crashScript, root], {env, stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
    await new Promise((ready, reject) => {
        const timer = setTimeout(() => { crashed.kill('SIGKILL'); reject(new Error('Crash fixture timed out')); }, 60000);
        crashed.once('message', () => { clearTimeout(timer); ready(); });
        crashed.once('error', error => { clearTimeout(timer); sanitizeProcessError(error); reject(new Error('Crash fixture failed')); });
        crashed.once('exit', () => { clearTimeout(timer); reject(new Error('Crash fixture exited before rename')); });
    });
    const killed = new Promise(done => crashed.once('exit', done));
    crashed.kill('SIGKILL');
    await killed;
    const survivingBlob = await readFile(path, 'utf8');
    assert.doesNotThrow(() => JSON.parse(survivingBlob));
    // A refresh after reseeding must reclaim the dead process's lock.
    await seed();
    await run(['--require', join(root, 'preload.cjs'), '-e', resolver]);
    assert.equal(refreshes, 1);
    assert.ok(!(await readdir(sandbox)).some(name => name.endsWith('.lock')));
    process.stdout.write('PASS: SIGKILL before atomic rename preserves JSON; next refresh reclaims stale lock\n');
    for (const name of await readdir(sandbox)) if (name.includes('.tmp.')) await rm(join(sandbox, name));
    await seed();
    await run([join(root, 'bin/now-sdk-wrapped.cjs'), 'query', 'sys_scope', '--query', 'sys_idISNOTEMPTY', '--auth', 'test', '--output', 'json']);
    await verify();
    process.stdout.write('PASS: real now-sdk-x query refreshes and persists credentials\n');
    if (process.env.NEX_TEST_BIN) {
        await seed();
        await run([resolve(process.env.NEX_TEST_BIN), 'query', '-t', 'sys_scope', '-q', 'sys_idISNOTEMPTY', '-a', 'test', '--cred-store', '--json']);
        await verify();
        process.stdout.write('PASS: real nex query refreshes and persists credentials\n');
    }
} finally {
    await new Promise(resolveClose => server.close(resolveClose));
    await rm(sandbox, {recursive: true, force: true});
}
