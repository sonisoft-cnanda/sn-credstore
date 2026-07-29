/**
 * Minimal stderr-only logger.
 *
 * stderr, never stdout: the MCP server speaks JSON-RPC over stdout, and a single
 * stray line there corrupts the protocol. The shim runs inside that process.
 *
 * No winston, no dependencies — this package must stay installable standalone
 * for the `now-sdk-x` wrapper without dragging a logging stack along.
 */
import { redact } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const PREFIX = '[sn-credstore]';

function debugEnabled(): boolean {
    const v = process.env.SN_CRED_STORE_DEBUG;
    return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

/** Values are redacted before rendering. See redact.ts for why that is mandatory. */
function emit(level: LogLevel, message: string, detail?: unknown): void {
    if (level === 'debug' && !debugEnabled()) return;
    const line = detail === undefined ? `${PREFIX} ${message}` : `${PREFIX} ${message} ${JSON.stringify(redact(detail))}`;
    process.stderr.write(`${line}\n`);
}

export const logger = {
    debug: (message: string, detail?: unknown) => emit('debug', message, detail),
    info: (message: string, detail?: unknown) => emit('info', message, detail),
    warn: (message: string, detail?: unknown) => emit('warn', message, detail),
    error: (message: string, detail?: unknown) => emit('error', message, detail),
};

export type Logger = typeof logger;

/**
 * Print something once per process, keyed by a tag.
 *
 * For warnings that are true on every call — e.g. "you are storing credentials
 * unencrypted" — where repeating them per credential read would train the user
 * to ignore all our output.
 */
const emittedOnce = new Set<string>();
export function warnOnce(tag: string, message: string): void {
    if (emittedOnce.has(tag)) return;
    emittedOnce.add(tag);
    emit('warn', message);
}
