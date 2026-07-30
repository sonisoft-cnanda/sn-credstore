/**
 * Field-level validation for stored credentials.
 *
 * Separate from `parseKeyStore` on purpose. That function drives the *quarantine*
 * path in CredentialVault.getPassword: a blob it rejects is moved aside and the
 * user is told to re-import. Tightening it would mean a store that works today —
 * one stray field from a slightly different SDK build — gets quarantined on the
 * next read, which is a far worse outcome than the problem being fixed. So
 * `parseKeyStore` stays structural and permissive, and this decides separately
 * whether the *contents* are sane.
 *
 * The high-value check is `expires_at`. From types.ts, which documents the hazard
 * but never enforced it: the SDK refreshes when `expires_at - now <= 15 * 60`.
 * A millisecond value makes that permanently false, so the token is never
 * refreshed and every agent starts getting silent 401s once it really expires. A
 * past value makes it permanently true, producing a refresh storm across every
 * concurrent agent. Neither failure looks like a units bug from the outside,
 * which is exactly why it is worth catching at the boundary.
 */

import { Creds, KeyStore, isOAuthCred } from './types.js';

export type ProblemSeverity = 'blocking' | 'warning';

export interface CredentialProblem {
    alias: string;
    field: string;
    severity: ProblemSeverity;
    message: string;
}

/**
 * Upper bound separating a UNIX-seconds timestamp from a milliseconds one.
 *
 * Any millisecond timestamp for a date after 2001 is >= ~1e12; any seconds
 * timestamp for a date before ~year 5138 is <= ~1e11. Anything in between is not
 * a date anyone means, so the gap is wide enough to decide without guessing.
 */
const MAX_PLAUSIBLE_EXPIRES_AT_SEC = 100_000_000_000;

/** True when `value` could be a UNIX **seconds** timestamp. */
export function isPlausibleExpiresAtSeconds(value: unknown): boolean {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    if (!Number.isInteger(value)) return false;
    if (value <= 0) return false;
    return value < MAX_PLAUSIBLE_EXPIRES_AT_SEC;
}

function nonEmptyString(value: unknown): boolean {
    return typeof value === 'string' && value.length > 0;
}

/** Problems with a single credential. `alias` is only used to label them. */
export function findCredsProblems(alias: string, creds: Creds): CredentialProblem[] {
    const problems: CredentialProblem[] = [];
    const blocking = (field: string, message: string): void => {
        problems.push({ alias, field, severity: 'blocking', message });
    };
    const warn = (field: string, message: string): void => {
        problems.push({ alias, field, severity: 'warning', message });
    };

    // Missing instanceUrl does not corrupt anything, but every request derives its
    // target host from it, so it is worth surfacing in `doctor`.
    if (!nonEmptyString((creds as { instanceUrl?: unknown }).instanceUrl)) {
        warn('instanceUrl', 'missing or empty');
    }

    if (isOAuthCred(creds)) {
        if (!nonEmptyString(creds.access_token)) {
            blocking('access_token', 'missing or empty on an oauth credential');
        }
        if (!nonEmptyString(creds.token_type)) {
            warn('token_type', 'missing or empty');
        }
        if (creds.expires_at !== undefined && !isPlausibleExpiresAtSeconds(creds.expires_at)) {
            blocking(
                'expires_at',
                `${JSON.stringify(creds.expires_at)} is not a UNIX seconds timestamp. ` +
                    `Milliseconds stop the SDK ever refreshing (silent 401s); a past value ` +
                    `makes every agent refresh at once.`,
            );
        }
        return problems;
    }

    // basic
    if (typeof creds.username !== 'string') {
        blocking('username', 'missing or not a string on a basic credential');
    }
    if (typeof creds.password !== 'string') {
        blocking('password', 'missing or not a string on a basic credential');
    }
    return problems;
}

/** Every problem across a whole store. */
export function findCredentialProblems(store: KeyStore): CredentialProblem[] {
    const problems: CredentialProblem[] = [];
    for (const [alias, entry] of Object.entries(store)) {
        if (!entry || typeof entry !== 'object' || !entry.creds) {
            problems.push({
                alias,
                field: 'creds',
                severity: 'blocking',
                message: 'entry has no credential',
            });
            continue;
        }
        problems.push(...findCredsProblems(alias, entry.creds));
    }
    return problems;
}

export function blockingProblems(problems: CredentialProblem[]): CredentialProblem[] {
    return problems.filter((p) => p.severity === 'blocking');
}

/** One line per problem. Never includes a credential value — only field names. */
export function describeProblems(problems: CredentialProblem[]): string {
    return problems.map((p) => `  ${p.alias}.${p.field}: ${p.message}`).join('\n');
}
