import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { listAliases, sanitizeProcessError } from '../dist/esm/index.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const directory = await mkdtemp(join(tmpdir(), 'sn-lock-recovery-'));
const path = join(directory, 'credentials.json');
const env = { ...process.env, SN_CRED_STORE: 'file', SN_CRED_STORE_PATH: path, REVIEW_ROOT: root };
assert.equal((await listAliases({ store: 'file', blobPath: path, systemdKey: 'host', allowPlaintext: true, lockTimeoutMs: 20000, disabled: false })).path, path);
const children = new Set();
function child(source, phase) {
    const processChild = spawn(process.execPath, ['-e', source], { env: { ...env, PHASE: phase }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    children.add(processChild);
    const messages = new Map();
    processChild.on('message', value => messages.get(value)?.());
    const waitFor = message => new Promise(resolve => messages.set(message, resolve));
    const timer = setTimeout(() => processChild.kill('SIGKILL'), 25000);
    const done = new Promise((resolve, reject) => {
        processChild.once('error', error => reject(new Error(JSON.stringify(sanitizeProcessError(error)))));
        processChild.once('exit', (code, signal) => { clearTimeout(timer); children.delete(processChild); resolve({ code, signal }); });
    });
    return { process: processChild, waitFor, done };
}
const crashSource = `
    const fs=require('node:fs/promises');
    const path=process.env.SN_CRED_STORE_PATH;
    const park=async()=>{process.send('ready');await new Promise(()=>setInterval(()=>{},1000));};
    const mkdir=fs.mkdir;
    fs.mkdir=async(...args)=>{const result=await mkdir(...args);if(process.env.PHASE==='choosing'&&String(args[0]).startsWith(path+'.lock.queue/v1.'))await park();return result;};
    const link=fs.link;
    fs.link=async(...args)=>{const result=await link(...args);if(process.env.PHASE==='published'&&args[1]===path+'.lock')await park();return result;};
    const {acquireLock}=require(process.env.REVIEW_ROOT+'/dist/cjs/lock/FileLock.js');
    acquireLock(path+'.lock').then(park).catch(()=>process.exit(1));
`;
const contenderSource = `
    const fs=require('node:fs/promises');
    const path=process.env.SN_CRED_STORE_PATH;
    const {acquireLock}=require(process.env.REVIEW_ROOT+'/dist/cjs/lock/FileLock.js');
    const {writeFileAtomic}=require(process.env.REVIEW_ROOT+'/dist/cjs/store/atomicFile.js');
    process.once('message',async()=>{
        try{
            for(let i=0;i<2;i++){
                const lock=await acquireLock(path+'.lock');
                const guard=await fs.open(path+'.critical','wx');
                const value=JSON.parse(await fs.readFile(path,'utf8'));
                await new Promise(resolve=>setImmediate(resolve));
                await writeFileAtomic(path,JSON.stringify({counter:value.counter+1}));
                await guard.close();await fs.unlink(path+'.critical');await lock.release();
            }
            process.disconnect();
        }catch{process.exit(1);}
    });
    process.send('ready');
`;
try {
    for (const phase of ['choosing', 'published', 'held']) {
        await writeFile(path, JSON.stringify({ counter: 0 }), { mode: 0o600 });
        const owner = child(crashSource, phase);
        await Promise.race([owner.waitFor('ready'), owner.done.then(() => { throw new Error('Crash owner exited early'); })]);
        owner.process.kill('SIGKILL');
        await owner.done;
        const contenders = Array.from({ length: 20 }, () => child(contenderSource, phase));
        await Promise.all(contenders.map(value => Promise.race([value.waitFor('ready'), value.done.then(() => { throw new Error('Contender exited early'); })])));
        for (const contender of contenders) contender.process.send('start');
        const results = await Promise.all(contenders.map(value => value.done));
        assert.ok(results.every(value => value.code === 0 && !value.signal), 'Concurrent lock holders overlapped or failed');
        assert.equal(JSON.parse(await readFile(path, 'utf8')).counter, 40);
        assert.deepEqual(await readdir(path + '.lock.queue'), []);
        assert.ok(!(await readdir(directory)).some(name => name.endsWith('.lock') || name.endsWith('.critical') || name.includes('.tmp.')));
        process.stdout.write(`PASS: ${phase} SIGKILL recovery, 20 processes, 40 exclusive writes\n`);
    }
} finally {
    for (const processChild of children) processChild.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
}
