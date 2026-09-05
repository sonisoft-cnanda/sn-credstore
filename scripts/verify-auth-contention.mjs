import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { listAliases, sanitizeProcessError } from '../dist/esm/index.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const directory = await mkdtemp(join(tmpdir(), 'sn-auth-contention-'));
const blobPath = join(directory, 'credentials.json');
const sdkHome = process.env.SN_SDK_HOME && resolve(process.env.SN_SDK_HOME);
if (!sdkHome) throw new Error('Set SN_SDK_HOME to an installed SDK.');
const env = { ...process.env, SN_CRED_STORE: 'file', SN_CRED_STORE_PATH: blobPath,
    SN_CRED_STORE_LOCK_TIMEOUT_MS: '60000', SN_SDK_HOME: sdkHome, REVIEW_ROOT: root };
for (const key of ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'DISPLAY', 'WAYLAND_DISPLAY', 'NODE_ENV',
    'SN_SDK_SESSION_TOKEN', 'SN_SDK_SESSION_BEARER_TOKEN', 'SN_SDK_NODE_ENV', 'SN_CRED_STORE_DISABLE']) delete env[key];
assert.equal((await listAliases({ store: 'file', blobPath, systemdKey: 'host', allowPlaintext: true, lockTimeoutMs: 60000, disabled: false })).path, blobPath);
let refreshes = 0;
let releaseRefresh;
let announceRefresh;
const refreshEntered = new Promise(resolve => { announceRefresh = resolve; });
const refreshGate = new Promise(resolve => { releaseRefresh = resolve; });
let held = true;
const server = createServer(async (request, response) => {
    let body = '';
    for await (const part of request) body += part;
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/oauth_token.do') {
        refreshes++;
        if (new URLSearchParams(body).get('refresh_token') !== 'fabricated-old-refresh') {
            response.writeHead(400); response.end(JSON.stringify({ error: 'invalid_grant' })); return;
        }
        announceRefresh();
        if (held) await refreshGate;
        response.end(JSON.stringify({ access_token: 'fabricated-new-access', refresh_token: 'fabricated-new-refresh',
            expires_in: 3600, token_type: 'Bearer' }));
    } else if (request.url?.startsWith('/angular.do')) {
        response.setHeader('Set-Cookie', 'JSESSIONID=fabricated-session; Path=/; HttpOnly');
        response.end(JSON.stringify({ result: { user_id: 'fixture', user_name: 'fixture' } }));
    } else response.end(JSON.stringify({ result: [] }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const instanceUrl = `http://127.0.0.1:${server.address().port}`;
const basic = alias => ({ alias, isDefault: false, creds: { type: 'basic', instanceUrl, username: 'fixture', password: 'fabricated-password' } });
const oauth = remaining => ({ alias: 'selected', isDefault: true, creds: { type: 'oauth', instanceUrl,
    access_token: 'fabricated-old-access', refresh_token: 'fabricated-old-refresh', token_type: 'Bearer',
    expires_at: Math.floor(Date.now() / 1000) + remaining } });
const prefix = `const {createRequire}=require('node:module'); const req=createRequire(process.env.SN_SDK_HOME+'/package.json'); req('openid-client').custom.setHttpOptionsDefaults({timeout:60000}); const auth=req('@servicenow/sdk-cli/dist/auth/index.js');`;
const children = new Set();
function run(source, extra = {}) {
    return new Promise((resolveRun, reject) => {
        const child = spawn(process.execPath, ['--require', join(root, 'preload.cjs'), '-e', prefix + source],
            { env: { ...env, ...extra }, cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
        children.add(child);
        let output = '';
        child.stdout.on('data', value => { output += value; });
        child.stderr.on('data', value => { output += value; });
        const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
        child.once('error', error => reject(new Error(JSON.stringify(sanitizeProcessError(error)))));
        child.once('close', (code, signal) => {
            clearTimeout(timer); children.delete(child);
            if (code !== 0 || signal || /fabricated-(old|new|password|session)/.test(output)) {
                reject(new Error(`SDK contention fixture failed: exit=${code}, signal=${signal}, secret output withheld`));
            } else resolveRun();
        });
    });
}
const resolveSelected = "auth.getCredentials('selected').then(c=>{if(c.expires_at<=Date.now()/1000)process.exitCode=2}).catch(()=>{process.exitCode=1});";
try {
    await writeFile(blobPath, JSON.stringify({ selected: oauth(-1), survivor: basic('survivor'), remove: basic('remove') }), { mode: 0o600 });
    const owner = run(resolveSelected);
    await Promise.race([refreshEntered, owner.then(() => { throw new Error('Owner did not refresh'); })]);
    const readers = Array.from({ length: 20 }, () => run("auth.getCredentials('survivor').then(c=>{if(c.type!=='basic')process.exitCode=2}).catch(()=>{process.exitCode=1});"));
    const timeout = run("auth.getCredentials('selected').then(()=>{process.exitCode=2}).catch(e=>{if(e.code!=='LOCK_TIMEOUT')process.exitCode=3});", { SN_CRED_STORE_LOCK_TIMEOUT_MS: '100' });
    const mutation = run(`(async()=>{await auth.storeCredentials('added',${JSON.stringify(basic('added').creds)},false);await auth.updateDefaultCredential('added');await auth.removeCredentials('remove');})().catch(()=>{process.exitCode=1});`);
    await Promise.all([...readers, timeout]);
    const duration = Number(process.env.REFRESH_HOLD_MS || 35000);
    await new Promise(resolve => setTimeout(resolve, duration));
    assert.equal(refreshes, 1, 'Another refresh started while the first was still active');
    assert.ok((await readdir(directory)).some(name => name.endsWith('.lock')));
    releaseRefresh(); held = false;
    await Promise.all([owner, mutation]);
    const result = JSON.parse(await readFile(blobPath, 'utf8'));
    assert.deepEqual(Object.keys(result).sort(), ['added', 'selected', 'survivor']);
    assert.equal(result.added.isDefault, true);
    assert.equal(Object.values(result).filter(entry => entry.isDefault).length, 1);
    assert.ok(result.selected.creds.refresh_token === 'fabricated-new-refresh');
    assert.equal(refreshes, 1);
    assert.deepEqual(await readdir(blobPath + '.lock.queue'), []);
    process.stdout.write(`PASS: ${duration}ms refresh retains exclusivity; 20 unrelated reads, typed timeout, SDK add/use/delete succeed\n`);
    await writeFile(blobPath, JSON.stringify({ selected: oauth(950), unused: { ...oauth(-100), alias: 'unused', isDefault: false } }), { mode: 0o600 });
    await Promise.all(Array.from({ length: 20 }, () => run(resolveSelected)));
    assert.equal(refreshes, 1);
    assert.ok(!(await readdir(directory)).some(name => name.endsWith('.lock')));
    process.stdout.write('PASS: unused expired alias and 900–960 second band cause no refresh or idle lease\n');
    await writeFile(blobPath, JSON.stringify({ selected: oauth(-1), survivor: basic('survivor') }), { mode: 0o600 });
    await run("(async()=>{const lazy=await auth.credentialProvider('selected');await auth.getCredentials('selected');await lazy.getHeaders();})().catch(()=>{process.exitCode=1});");
    assert.equal(refreshes, 2);
    process.stdout.write('PASS: lazy credentials created before rotation reuse the persisted token\n');
} finally {
    releaseRefresh();
    for (const child of children) child.kill('SIGKILL');
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
}
