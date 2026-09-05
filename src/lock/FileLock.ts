import { mkdir, readdir, readFile, unlink, stat, link, rm } from 'node:fs/promises';
import { readFileSync, unlinkSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { LockTimeoutError } from '../errors.js';
import { DIR_MODE, ensureDir, writeFileAtomic } from '../store/atomicFile.js';
import { currentOwner, namedOwnerIsDead, ownerIsDead, ownerName, Owner } from './owner.js';

interface LockPayload extends Owner {
    version: number;
    nonce: string;
    startedAt: number;
    op: string;
}

export interface LockHandle {
    release(): Promise<void>;
    readonly path: string;
}

export interface AcquireOptions {
    timeoutMs?: number;
    /** Grace for an abandoned, empty legacy lock. Live owners never expire by age. */
    maxAgeMs?: number;
    op?: string;
}

const held = new Map<string, { nonce: string; ticket: string }>();
const tickets = new Set<string>();
let installed = false;

function ours(path: string, nonce: string): boolean {
    try { return (JSON.parse(readFileSync(path, 'utf8')) as Partial<LockPayload>).nonce === nonce; }
    catch { return false; }
}

function installExitHandlers(): void {
    if (installed) return;
    installed = true;
    const cleanup = (): void => {
        for (const [path, lock] of held) {
            try { if (ours(path, lock.nonce)) unlinkSync(path); } catch { /* already gone */ }
        }
        for (const ticket of tickets) {
            try { rmSync(ticket, { recursive: true, force: true }); } catch { /* best effort */ }
        }
        held.clear();
        tickets.clear();
    };
    process.on('exit', cleanup);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
        process.on(signal, () => { cleanup(); process.exit(signal === 'SIGINT' ? 130 : 143); });
    }
}

async function payloadAt(path: string): Promise<Partial<LockPayload> | null> {
    try {
        const value: unknown = JSON.parse(await readFile(path, 'utf8'));
        return value !== null && typeof value === 'object' ? value as Partial<LockPayload> : null;
    } catch (error: unknown) {
        if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

async function numberAt(ticket: string): Promise<number | null> {
    try {
        const value: unknown = JSON.parse(await readFile(join(ticket, 'number'), 'utf8'));
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return null;
        return value;
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null;
        throw error;
    }
}

/** Acquire a local-filesystem mutex, retaining the legacy lockfile for older clients. */
export async function acquireLock(path: string, options: AcquireOptions = {}): Promise<LockHandle> {
    const timeoutMs = options.timeoutMs ?? 20_000;
    const deadline = Date.now() + timeoutMs;
    const owner = await currentOwner();
    const nonce = randomUUID();
    const queue = path + '.queue';
    const name = `v1.${ownerName(owner)}.${nonce}`;
    const ticket = join(queue, name);
    const payload: LockPayload = { ...owner, version: 1, nonce, startedAt: Date.now(), op: options.op ?? 'unknown' };
    installExitHandlers();
    await ensureDir(dirname(path));
    await ensureDir(queue);
    await mkdir(ticket, { mode: DIR_MODE });
    tickets.add(ticket);

    let attempt = 0;
    const wait = async (): Promise<void> => {
        if (Date.now() >= deadline) {
            throw new LockTimeoutError(
                `timed out after ${timeoutMs}ms waiting for ${path}`,
                'Another credential operation still owns the lock, or its owner cannot be identified. ' +
                'Retry after that operation finishes. Do not remove a lock while credential clients are running.',
            );
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(deadline - Date.now(), 10 + Math.random() * Math.min(250, 10 * 2 ** attempt++))));
    };
    const peers = async (): Promise<string[]> => {
        const result: string[] = [];
        for (const peer of await readdir(queue)) {
            if (peer === name) continue;
            if (peer.startsWith('v1.') && await namedOwnerIsDead(peer.slice(3))) {
                await rm(join(queue, peer), { recursive: true, force: true });
            } else result.push(peer);
        }
        return result;
    };

    try {
        // Unique ticket paths prevent stale cleanup from unlinking a successor.
        // A directory is the bakery choosing flag, with owner identity in its name.
        let number = 1;
        for (const peer of await peers()) number = Math.max(number, (await numberAt(join(queue, peer)) ?? 0) + 1);
        if (!Number.isSafeInteger(number)) throw new Error('Credential lock queue exhausted');
        await writeFileAtomic(join(ticket, 'number'), JSON.stringify(number));
        for (;;) {
            let blocked = false;
            for (const peer of await peers()) {
                if (!peer.startsWith('v1.')) { blocked = true; break; }
                const other = await numberAt(join(queue, peer));
                if (other === null) {
                    if (await stat(join(queue, peer)).then(() => true, () => false)) blocked = true;
                } else if (other < number || (other === number && peer < name)) blocked = true;
                if (blocked) break;
            }
            if (!blocked) break;
            await wait();
        }

        const prepared = join(ticket, 'payload');
        await writeFileAtomic(prepared, JSON.stringify(payload));
        for (;;) {
            try {
                // Link publishes a complete payload atomically; no empty-file window.
                await link(prepared, path);
                break;
            } catch (error: unknown) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                const previous = await payloadAt(path);
                const emptyAndOld = previous === null && await stat(path)
                    .then(s => s.size === 0 && Date.now() - s.mtimeMs >= (options.maxAgeMs ?? 1000), () => false);
                if ((previous !== null && await ownerIsDead(previous)) || emptyAndOld) {
                    // Only the queue winner may reclaim the shared legacy path.
                    await unlink(path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
                    continue;
                }
                if (await stat(path).then(() => false, error => (error as NodeJS.ErrnoException).code === 'ENOENT')) continue;
                await wait();
            }
        }
        held.set(path, { nonce, ticket });
        let released = false;
        return {
            path,
            release: async (): Promise<void> => {
                if (released) return;
                released = true;
                if (ours(path, nonce)) await unlink(path);
                held.delete(path);
                tickets.delete(ticket);
                await rm(ticket, { recursive: true, force: true });
            },
        };
    } catch (error: unknown) {
        tickets.delete(ticket);
        await rm(ticket, { recursive: true, force: true });
        throw error;
    }
}

/** Run a callback while holding the lock, releasing on success or failure. */
export async function withLock<T>(path: string, options: AcquireOptions, fn: () => Promise<T>): Promise<T> {
    const lock = await acquireLock(path, options);
    try { return await fn(); }
    finally { await lock.release(); }
}
