import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';
import {mkdtemp, rm, writeFile, utimes} from 'node:fs/promises';
import {tmpdir, hostname} from 'node:os';
import {join} from 'node:path';
import {acquireLock} from '../../../src/lock/FileLock.js';
import {currentOwner} from '../../../src/lock/owner.js';

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
    it('does not steal a different boot merely because the hostname matches', async () => {
        await writeFile(path, JSON.stringify({ pid: process.pid, hostname: hostname(), bootId: 'foreign-boot', startedAt: 1 }));
        await expect(acquireLock(path, { timeoutMs: 1 })).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
    });
    it('retains a live owner when optional payload fields change shape', async () => {
        await writeFile(path, JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: 'future-format', extra: true }));
        await utimes(path, 1, 1);
        await expect(acquireLock(path, { timeoutMs: 1 })).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
    });
    it('does not infer death from an unfamiliar identity-field format', async () => {
        const owner = await currentOwner();
        await writeFile(path, JSON.stringify({ ...owner, bootId: { generation: 2 }, processStart: 123, startedAt: 1 }));
        await expect(acquireLock(path, { timeoutMs: 1 })).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
    });
    it('recognizes a live owner across client timezone settings', async () => {
        await writeFile(path, JSON.stringify({ ...await currentOwner(), startedAt: 1 }));
        const previous = process.env.TZ;
        process.env.TZ = 'Pacific/Honolulu';
        try {
            await expect(acquireLock(path, { timeoutMs: 1 })).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
        } finally {
            if (previous === undefined) delete process.env.TZ;
            else process.env.TZ = previous;
        }
    });
    it('reclaims a recycled PID using its process start identity', async () => {
        const owner = await currentOwner();
        if (owner.processStart === null) return;
        await writeFile(path, JSON.stringify({ ...owner, processStart: 'previous-process', startedAt: 1 }));
        const lock = await acquireLock(path, { timeoutMs: 1000 });
        await lock.release();
    });
    it('recovers an empty legacy lock within the normal acquisition timeout', async () => {
        await writeFile(path, '');
        await utimes(path, new Date(Date.now() - 1500), new Date(Date.now() - 1500));
        const lock = await acquireLock(path, { timeoutMs: 2000 });
        await lock.release();
    });
    it('serializes simultaneous contenders after a dead owner', async () => {
        await writeFile(path, JSON.stringify({ pid: 2147483647, hostname: hostname(), bootId: null, startedAt: 1 }));
        let active = 0;
        let maximum = 0;
        await Promise.all(Array.from({ length: 20 }, async () => {
            const lock = await acquireLock(path, { timeoutMs: 20000 });
            active++;
            maximum = Math.max(maximum, active);
            await new Promise(resolve => setImmediate(resolve));
            active--;
            await lock.release();
        }));
        expect(maximum).toBe(1);
    }, 30000);
});
