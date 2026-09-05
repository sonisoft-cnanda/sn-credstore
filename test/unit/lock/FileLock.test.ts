import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';
import {mkdtemp, rm, writeFile, utimes} from 'node:fs/promises';
import {tmpdir, hostname} from 'node:os';
import {join} from 'node:path';
import {acquireLock} from '../../../src/lock/FileLock.js';

let directory: string;
let path: string;
beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sn-lock-'));
    path = join(directory, 'credentials.lock');
});
afterEach(async () => { await rm(directory, {recursive: true, force: true}); });
describe('lock acquisition races', () => {
    it('does not steal a newly opened, incomplete lock', async () => {
        await writeFile(path, '');
        await expect(acquireLock(path, {timeoutMs: 1})).rejects.toMatchObject({code: 'LOCK_TIMEOUT'});
    });
    it('reclaims an abandoned incomplete lock after its grace period', async () => {
        await writeFile(path, '');
        await utimes(path, 1, 1);
        const lock = await acquireLock(path, {timeoutMs: 100});
        await lock.release();
    });
    it('does not steal from a living local process merely because its lock is old', async () => {
        await writeFile(path, JSON.stringify({
            pid: process.pid, hostname: hostname(), bootId: null, startedAt: 1, op: 'fixture',
        }));
        await expect(acquireLock(path, {timeoutMs: 1})).rejects.toMatchObject({code: 'LOCK_TIMEOUT'});
    });
});
