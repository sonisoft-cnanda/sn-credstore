/**
 * Advisory lock guarding mutations of the credential blob.
 *
 * Why not flock(2): Node has no core binding for it. The options are a native
 * addon (unacceptable for a zero-dependency package that must install cleanly
 * for the wrapper) or shelling out to flock(1), which ties the lock's lifetime
 * to a child process — awkward, because we hold this lock across an awaited
 * network round trip during OAuth refresh.
 *
 * So: O_EXCL lockfile, with explicit staleness detection. The tradeoff is that
 * we must handle stale locks ourselves rather than getting kernel-on-death
 * release for free. That is what bootId + pid liveness below is for.
 */
import { open, readFile, unlink } from 'node:fs/promises';
import { readFileSync, unlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { LockTimeoutError } from '../errors.js';
import { logger } from '../logger.js';
import { FILE_MODE, ensureDir } from '../store/atomicFile.js';
import { dirname } from 'node:path';

interface LockPayload {
    pid: number;
    hostname: string;
    /** Distinguishes a live pid from a recycled one after a reboot. */
    bootId: string | null;
    startedAt: number;
    op: string;
}

/** Steal any lock older than this, on the assumption its holder died badly. */
const DEFAULT_MAX_AGE_MS = 60_000;
const BACKOFF_BASE_MS = 25;
const BACKOFF_CAP_MS = 500;

function readBootId(): string | null {
    try {
        return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    } catch {
        return null;
    }
}

const BOOT_ID = readBootId();

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

/** Full jitter — avoids the lockstep retry storm that a fixed backoff creates. */
function backoffDelay(attempt: number): number {
    const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
    return Math.random() * ceiling;
}

export interface LockHandle {
    release(): Promise<void>;
    readonly path: string;
}

export interface AcquireOptions {
    timeoutMs?: number;
    maxAgeMs?: number;
    /** Recorded in the lockfile so a stuck lock says what it was doing. */
    op?: string;
}

/**
 * A held lock is registered here so process-exit handlers can clean up.
 * Belt and braces only — stale detection is the real backstop, because exit
 * handlers do not run on SIGKILL or OOM.
 */
const held = new Set<string>();
let exitHandlersInstalled = false;

function installExitHandlers(): void {
    if (exitHandlersInstalled) return;
    exitHandlersInstalled = true;

    const cleanup = (): void => {
        for (const path of held) {
            try {
                // Must be sync: async work is not guaranteed to complete during
                // 'exit', so an await here would silently leave the lock behind.
                unlinkSync(path);
            } catch {
                /* already gone, or no longer ours */
            }
        }
        held.clear();
    };

    process.on('exit', cleanup);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
        process.on(sig, () => {
            cleanup();
            process.exit(sig === 'SIGINT' ? 130 : 143);
        });
    }
}

async function readLock(path: string): Promise<LockPayload | null> {
    try {
        return JSON.parse(await readFile(path, 'utf8')) as LockPayload;
    } catch {
        // Unparseable or vanished mid-read. Treat as stale rather than wedging
        // forever on a corrupt lockfile.
        return null;
    }
}

/**
 * A lock is stale when its holder is provably gone, or it is simply too old.
 *
 * The bootId check matters: after a reboot, pid N may well exist again as an
 * unrelated process, and `kill(pid, 0)` would report it alive forever.
 */
function isStale(payload: LockPayload | null, maxAgeMs: number): boolean {
    if (payload === null) return true;

    const age = Date.now() - payload.startedAt;
    if (age > maxAgeMs) {
        logger.warn(`stealing lock held by pid ${payload.pid} for ${Math.round(age / 1000)}s (op=${payload.op})`);
        return true;
    }

    const sameMachine = payload.hostname === hostname() && payload.bootId === BOOT_ID;
    if (sameMachine && payload.bootId !== null) {
        try {
            process.kill(payload.pid, 0);
            return false; // alive
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
                logger.debug(`stealing lock from dead pid ${payload.pid}`);
                return true;
            }
            // EPERM means it exists but belongs to another user — alive.
            return false;
        }
    }
    return false;
}

export async function acquireLock(path: string, options: AcquireOptions = {}): Promise<LockHandle> {
    const timeoutMs = options.timeoutMs ?? 20_000;
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    const op = options.op ?? 'unknown';

    installExitHandlers();
    await ensureDir(dirname(path));

    const deadline = Date.now() + timeoutMs;
    let attempt = 0;

    for (;;) {
        try {
            const handle = await open(path, 'wx', FILE_MODE);
            const payload: LockPayload = {
                pid: process.pid,
                hostname: hostname(),
                bootId: BOOT_ID,
                startedAt: Date.now(),
                op,
            };
            await handle.writeFile(JSON.stringify(payload), 'utf8');
            await handle.close();
            held.add(path);

            let released = false;
            return {
                path,
                release: async (): Promise<void> => {
                    if (released) return;
                    released = true;
                    held.delete(path);
                    await unlink(path).catch(() => {});
                },
            };
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

            if (isStale(await readLock(path), maxAgeMs)) {
                await unlink(path).catch(() => {});
                continue; // retry immediately after a steal
            }

            if (Date.now() >= deadline) {
                const holder = await readLock(path);
                throw new LockTimeoutError(
                    `timed out after ${timeoutMs}ms waiting for ${path}` +
                        (holder ? ` (held by pid ${holder.pid}, op=${holder.op}, age ${Date.now() - holder.startedAt}ms)` : ''),
                    `Another process is updating the credential store. If nothing is running, remove the stale lock: rm ${path}`,
                );
            }
            await sleep(backoffDelay(attempt++));
        }
    }
}

/** Run `fn` while holding the lock. Always releases, including on throw. */
export async function withLock<T>(path: string, options: AcquireOptions, fn: () => Promise<T>): Promise<T> {
    const lock = await acquireLock(path, options);
    try {
        return await fn();
    } finally {
        await lock.release();
    }
}
