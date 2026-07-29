/**
 * Atomic file primitives shared by the store backends.
 *
 * Why atomic writes matter here beyond the usual reasons: the encrypted blob is
 * AES-GCM, so a torn write is not "partially readable", it is permanently
 * undecryptable. And an unreadable blob feeds straight into the SDK's
 * read-modify-write, which seeds from `(await getParsedCredentials()) ?? {}` —
 * so a truncated file becomes a full store wipe on the next write.
 *
 * Writing to a temp file in the SAME directory and renaming makes the swap
 * atomic on POSIX, which also means readers never observe a partial blob and
 * therefore never need to take the lock.
 */
import { open, mkdir, rename, unlink, stat, readFile } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Owner-only. The store holds cleartext credentials in the file backend. */
export const FILE_MODE = 0o600;
export const DIR_MODE = 0o700;

/**
 * Opaque compare-and-swap token for a file's identity+state.
 * Cheap to compute and good enough to detect "someone else wrote since I read".
 */
export function versionOf(s: { ino: bigint | number; mtimeMs: number; size: number }): string {
    return `${s.ino}-${s.mtimeMs}-${s.size}`;
}

export async function ensureDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
}

export interface ReadResult {
    content: string | null;
    version: string | null;
}

/** Read a file. A missing file is `{content: null}`, not an error. */
export async function readFileVersioned(path: string): Promise<ReadResult> {
    try {
        const [content, s] = await Promise.all([readFile(path, 'utf8'), stat(path, { bigint: false })]);
        return { content, version: versionOf(s) };
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { content: null, version: null };
        throw err;
    }
}

/**
 * Write atomically: temp in the same dir at 0600, fsync the file, rename, then
 * fsync the directory.
 *
 * The directory fsync is not paranoia — without it the rename can be lost on
 * power failure even though the file contents were durable, which would leave
 * the old blob in place and silently discard a rotated refresh token.
 */
export async function writeFileAtomic(path: string, content: string): Promise<string> {
    const dir = dirname(path);
    await ensureDir(dir);

    const tmpPath = join(dir, `.${basename(path)}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`);

    let handle;
    try {
        handle = await open(tmpPath, 'wx', FILE_MODE);
        await handle.writeFile(content, 'utf8');
        await handle.sync();
    } finally {
        await handle?.close();
    }

    try {
        await rename(tmpPath, path);
    } catch (err) {
        await unlink(tmpPath).catch(() => {});
        throw err;
    }

    // Best-effort: some filesystems reject opening a directory for fsync.
    let dirHandle;
    try {
        dirHandle = await open(dir, 'r');
        await dirHandle.sync();
    } catch {
        /* not fatal */
    } finally {
        await dirHandle?.close().catch(() => {});
    }

    const s = await stat(path, { bigint: false });
    return versionOf(s);
}

export async function deleteFileIfExists(path: string): Promise<boolean> {
    try {
        await unlink(path);
        return true;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw err;
    }
}

/** Current version token, or null when the file does not exist. */
export async function currentVersion(path: string): Promise<string | null> {
    try {
        return versionOf(await stat(path, { bigint: false }));
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
    }
}
