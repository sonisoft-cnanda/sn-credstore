/**
 * Secret redaction.
 *
 * This is not defensive boilerplate — this codebase has already shipped a
 * credential-logging bug (`authenticated-command.ts` logged the whole credential
 * object at debug level), and the SDK's own logger does `JSON.stringify(arg)` on
 * any non-Error object, so passing a Creds anywhere near it prints cleartext
 * passwords and refresh tokens.
 *
 * Rule for this package: credentials, keystores and child-process results never
 * reach a logger at any level. Use `redact()` if you must render one.
 */

const SECRET_KEYS = new Set([
    'password',
    'access_token',
    'refresh_token',
    'client_secret',
    'clientsecret',
    'usertoken',
    'user_token',
    'cookie',
    'authorization',
    'secret',
    'token',
]);

const MASK = '***REDACTED***';

/** Mask a secret while keeping enough shape to be debuggable. */
export function maskValue(value: string): string {
    if (value.length === 0) return '';
    if (value.length <= 8) return MASK;
    return `${value.slice(0, 4)}${MASK}${value.slice(-2)} (len ${value.length})`;
}

/**
 * Deep-clone with every known secret field masked. Safe to log or print.
 *
 * Handles cycles, because a child-process error object can reference itself and
 * we do not want the redactor itself to be the thing that crashes.
 */
export function redact<T>(input: T, seen: WeakSet<object> = new WeakSet()): unknown {
    if (input === null || input === undefined) return input;
    if (typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') return input;
    if (typeof input !== 'object') return `[${typeof input}]`;

    if (seen.has(input as object)) return '[Circular]';
    seen.add(input as object);

    if (Array.isArray(input)) return input.map((item) => redact(item, seen));

    // Buffers routinely carry raw process output. Never render their contents.
    if (Buffer.isBuffer(input)) return `[Buffer ${input.length} bytes]`;

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        if (SECRET_KEYS.has(key.toLowerCase())) {
            out[key] = typeof value === 'string' ? maskValue(value) : MASK;
        } else {
            out[key] = redact(value, seen);
        }
    }
    return out;
}

/**
 * Sanitize a child-process error before it goes anywhere near a log.
 *
 * Node attaches `cmd`, `args`, and for spawnSync also `output`/`stdout`/`stderr`
 * as Buffers. For us stdout IS the plaintext credential blob, so a bare
 * `logger.error('failed', err)` would print every credential we have.
 */
export function sanitizeProcessError(err: unknown): Record<string, unknown> {
    if (err === null || typeof err !== 'object') return { error: String(err) };
    const e = err as Record<string, unknown>;
    return {
        name: typeof e.name === 'string' ? e.name : undefined,
        message: typeof e.message === 'string' ? e.message : undefined,
        code: e.code,
        errno: e.errno,
        signal: e.signal,
        status: e.status,
        // Deliberately omitted: stdout, stderr, output, cmd, args.
        note: 'stdout/stderr withheld — they may contain plaintext credentials',
    };
}
