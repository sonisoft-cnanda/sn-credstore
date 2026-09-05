import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, readlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { promisify } from 'node:util';
import { sanitizeProcessError } from '../redact.js';
import { logger } from '../logger.js';

const execute = promisify(execFile);
const hash = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 24);
const read = async (path: string): Promise<string | null> => readFile(path, 'utf8').then(s => s.trim(), () => null);

export interface Owner {
    pid: number;
    hostname: string;
    bootId: string | null;
    machine: string | null;
    namespace: string | null;
    processStart: string | null;
}

async function command(bin: string, args: string[]): Promise<string | null> {
    try {
        return (await execute(bin, args, { timeout: 2000, maxBuffer: 1024 * 1024,
            env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } })).stdout.trim();
    } catch (error: unknown) {
        logger.debug('could not inspect lock owner', sanitizeProcessError(error));
        return null;
    }
}

async function processStart(pid: number): Promise<string | null> {
    if (process.platform === 'linux') {
        const value = await read(`/proc/${pid}/stat`);
        const fields = value?.slice(value.lastIndexOf(')') + 2).split(' ');
        return fields && fields[0] !== 'Z' && fields[19] ? hash(fields[19]) : null;
    }
    if (process.platform === 'darwin') {
        const value = await command('/bin/ps', ['-p', String(pid), '-o', 'stat=', '-o', 'lstart=']);
        const match = value?.match(/^(\S+)\s+(.+)$/);
        return match && !match[1]?.includes('Z') ? hash(match[2]!) : null;
    }
    return null;
}

let identity: Promise<Owner> | undefined;

export function currentOwner(): Promise<Owner> {
    return identity ??= (async () => {
        let bootId = await read('/proc/sys/kernel/random/boot_id');
        let machine = await read('/etc/machine-id');
        if (process.platform === 'darwin') {
            bootId = await command('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']);
            const platform = await command('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
            machine = platform?.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] ?? null;
        }
        return {
            pid: process.pid, hostname: hostname(), bootId,
            machine: machine ? hash(machine) : null,
            namespace: await readlink('/proc/self/ns/pid').then(hash, () => null),
            processStart: await processStart(process.pid),
        };
    })();
}

export async function ownerIsDead(owner: Partial<Owner>): Promise<boolean> {
    const current = await currentOwner();
    if (owner.hostname !== current.hostname || !Number.isInteger(owner.pid) || (owner.pid ?? 0) <= 0) return false;
    for (const field of ['bootId', 'machine', 'namespace', 'processStart'] as const) {
        if (owner[field] !== undefined && owner[field] !== null && typeof owner[field] !== 'string') return false;
    }
    if (owner.machine && current.machine && owner.machine !== current.machine) return false;
    if (owner.bootId && current.bootId && owner.bootId !== current.bootId) {
        return !!owner.machine && owner.machine === current.machine;
    }
    if (owner.namespace && owner.namespace !== current.namespace) return false;
    try {
        process.kill(owner.pid!, 0);
    } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') return true;
        if (code !== 'EPERM') return false;
    }
    if (owner.processStart) {
        const actual = await processStart(owner.pid!);
        return actual !== null && actual !== owner.processStart;
    }
    return false;
}

export function ownerName(owner: Owner): string {
    return [hash(owner.hostname), owner.bootId ? hash(owner.bootId) : '-', owner.machine ?? '-',
        owner.namespace ?? '-', owner.pid, owner.processStart ?? '-'].join('.');
}

export async function namedOwnerIsDead(name: string): Promise<boolean> {
    const [host, boot, machine, namespace, pid, start] = name.split('.');
    const current = await currentOwner();
    if (host !== hash(current.hostname)) return false;
    if (machine !== '-' && machine !== current.machine) return false;
    if (boot !== '-' && current.bootId && boot !== hash(current.bootId)) return machine !== '-' && machine === current.machine;
    if (namespace !== '-' && namespace !== current.namespace) return false;
    return ownerIsDead({ ...current, pid: Number(pid), processStart: start === '-' ? null : start });
}
