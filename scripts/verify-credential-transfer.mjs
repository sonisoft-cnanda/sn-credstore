import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAliases, readCredentialSnapshot, applyCredentialChanges } from '../dist/esm/index.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const directory = await mkdtemp(join(tmpdir(), 'sn-transfer-headless-'));
const blobPath = join(directory, 'credentials.json');
const config = { store: 'file', blobPath, systemdKey: 'host', allowPlaintext: true, lockTimeoutMs: 60000, disabled: false };
const env = { ...process.env, SN_CRED_STORE: 'file', SN_CRED_STORE_PATH: blobPath, SN_CRED_STORE_LOCK_TIMEOUT_MS: '60000', REVIEW_ROOT: root };
for (const key of ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'DISPLAY', 'WAYLAND_DISPLAY', 'NODE_ENV', 'SN_CRED_STORE_DISABLE']) delete env[key];
assert.equal((await listAliases(config)).path, blobPath);
const basic = () => ({ type: 'basic', instanceUrl: 'https://example.invalid', username: 'fixture', password: 'fabricated-password' });
const selected = { type: 'oauth', instanceUrl: 'https://example.invalid', access_token: 'fabricated-old-access',
    token_type: 'Bearer', refresh_token: 'fabricated-old-refresh', expires_at: Math.floor(Date.now() / 1000) - 1 };
const children = new Set();
function child(args, input) {
    const checkedImport = `
        const {loadConfig,listAliases}=require(process.env.REVIEW_ROOT+'/dist/cjs/index.js');
        (async()=>{
            const config=loadConfig();
            if(config.blobPath!==process.env.SN_CRED_STORE_PATH||(await listAliases(config)).path!==config.blobPath)throw new Error('Unsafe fixture store path');
            await import(require('node:url').pathToFileURL(process.argv[1]).href);
        })().catch(()=>{process.exitCode=1});
    `;
    const invocation = args[0] === join(root, 'bin/sn-credstore.js') ? ['-e', checkedImport, ...args] : args;
    const processChild = spawn(process.execPath, invocation, { env, cwd: directory, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    children.add(processChild);
    let exposed = false;
    for (const stream of [processChild.stdout, processChild.stderr]) {
        stream.on('data', chunk => { if (/fabricated-/.test(String(chunk))) exposed = true; });
    }
    processChild.stdin.end(input);
    const timer = setTimeout(() => processChild.kill('SIGKILL'), 75000);
    const done = new Promise((resolveDone, reject) => {
        processChild.once('error', () => reject(new Error('Transfer fixture could not start.')));
        processChild.once('exit', (code, signal) => {
            clearTimeout(timer); children.delete(processChild);
            if (exposed) reject(new Error('Transfer fixture exposed fabricated secrets.'));
            else resolveDone({ code, signal });
        });
    });
    return { process: processChild, done };
}
const refresh = `
    const fs = require('node:fs/promises');
    const {loadConfig,listAliases,vaultFor,isInRefreshWindow} = require(process.env.REVIEW_ROOT+'/dist/cjs/index.js');
    (async()=>{
        const config=loadConfig();
        if((await listAliases(config)).path!==process.env.SN_CRED_STORE_PATH)throw new Error('Unsafe path');
        const vault=vaultFor(config);
        const creds=JSON.parse(await vault.getPassword()).selected.creds;
        await vault.refreshCredentials(creds,async current=>{
            if(!isInRefreshWindow(current))return undefined;
            const countPath=process.env.SN_CRED_STORE_PATH+'.refreshes';
            const count=Number(await fs.readFile(countPath,'utf8').catch(()=>0));
            await fs.writeFile(countPath,String(count+1));
            await new Promise(resolve=>setTimeout(resolve,40));
            return {access_token:'fabricated-new-access',token_type:'Bearer',expires_at:Math.floor(Date.now()/1000)+3600};
        });
    })().catch(()=>{process.exitCode=1});
`;
try {
    await writeFile(blobPath, JSON.stringify({ selected: { alias: 'selected', isDefault: true, creds: selected },
        survivor: { alias: 'survivor', isDefault: false, creds: basic() } }), { mode: 0o600 });
    const workers = Array.from({ length: 20 }, (_, index) => index % 2 === 0
        ? child(['-e', refresh])
        : child([join(root, 'bin/sn-credstore.js'), 'import', '--stdin'], JSON.stringify({
            ['imported-' + index]: { alias: 'imported-' + index, isDefault: true, creds: basic() },
        })));
    const results = await Promise.all(workers.map(worker => worker.done));
    assert.ok(results.every(result => result.code === 0 && !result.signal), 'Headless transfer workers failed');
    const snapshot = await readCredentialSnapshot(config);
    assert.equal(Object.keys(snapshot).length, 12);
    assert.equal(snapshot.selected.isDefault, true);
    assert.equal(Object.values(snapshot).filter(entry => entry.isDefault).length, 1);
    assert.ok(snapshot.selected.creds.access_token === 'fabricated-new-access', 'Refresh was not persisted');
    assert.ok(snapshot.selected.creds.refresh_token === selected.refresh_token, 'Omitted refresh token was erased');
    assert.equal(await readFile(blobPath + '.refreshes', 'utf8'), '1');
    assert.ok(!(await readdir(directory)).some(name => name.includes('.tmp.') || name.endsWith('.lock')));
    assert.deepEqual(await readdir(blobPath + '.lock.queue'), []);
    process.stdout.write('PASS: 20 stripped-session import/refresh processes; one refresh, all aliases/default retained, no temp files or secret output\n');

    const beforeCrash = await readFile(blobPath, 'utf8');
    const crashSource = `
        const fs=require('node:fs/promises');
        const open=fs.open;
        fs.open=async(path,...args)=>{
            const handle=await open(path,...args);
            if(String(path).includes('.credentials.json.tmp.')){
                handle.writeFile=async content=>{
                    await handle.write(content.slice(0,Math.floor(content.length/2)),0,'utf8');
                    await handle.sync();process.send('mid-write');
                    await new Promise(()=>setInterval(()=>{},1000));
                };
            }
            return handle;
        };
        const {loadConfig,listAliases,applyCredentialChanges}=require(process.env.REVIEW_ROOT+'/dist/cjs/index.js');
        (async()=>{
            const config=loadConfig();
            if((await listAliases(config)).path!==process.env.SN_CRED_STORE_PATH)throw new Error('Unsafe path');
            await applyCredentialChanges([{alias:'crashed',expected:null,creds:{type:'basic',instanceUrl:'https://example.invalid',username:'fixture',password:'fabricated-'+ 'x'.repeat(1024*1024)}}],config);
        })().catch(()=>process.exit(1));
    `;
    const crashed = child(['-e', crashSource]);
    await Promise.race([new Promise(resolveReady => crashed.process.once('message', resolveReady)),
        crashed.done.then(() => { throw new Error('Crash fixture exited before partial write'); })]);
    crashed.process.kill('SIGKILL');
    assert.equal((await crashed.done).signal, 'SIGKILL');
    assert.equal(await readFile(blobPath, 'utf8'), beforeCrash);
    const partials = (await readdir(directory)).filter(name => name.includes('.tmp.'));
    assert.equal(partials.length, 1);
    await applyCredentialChanges([{ alias: 'recovered', expected: null, creds: basic() }], config);
    assert.equal(Object.keys(await readCredentialSnapshot(config)).length, 13);
    assert.ok(!(await readdir(directory)).some(name => name.endsWith('.lock')));
    assert.deepEqual(await readdir(blobPath + '.lock.queue'), []);
    for (const file of partials) await rm(join(directory, file));
    process.stdout.write('PASS: SIGKILL mid-transfer leaves valid original; next transfer reclaims stale lock (orphan temp removed by fixture)\n');
} finally {
    for (const processChild of children) processChild.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
}
