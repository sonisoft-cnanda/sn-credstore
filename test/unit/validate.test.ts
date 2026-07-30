import { describe, it, expect } from '@jest/globals';
import {
    findCredentialProblems,
    findCredsProblems,
    blockingProblems,
    describeProblems,
    isPlausibleExpiresAtSeconds,
} from '../../src/validate.js';
import type { KeyStore, StoredCredential } from '../../src/types.js';

/** Seconds, i.e. correct. Roughly 2026. */
const VALID_EXPIRES_AT = 1_785_000_000;
/** The same instant in milliseconds — the bug this exists to catch. */
const EXPIRES_AT_IN_MS = 1_785_000_000_000;

function oauth(alias: string, overrides: Partial<Record<string, unknown>> = {}): StoredCredential {
    return {
        isDefault: false,
        alias,
        creds: {
            instanceUrl: `https://${alias}.service-now.com`,
            type: 'oauth',
            access_token: 'AT',
            token_type: 'Bearer',
            refresh_token: 'RT',
            expires_at: VALID_EXPIRES_AT,
            ...overrides,
        },
    } as StoredCredential;
}

function basic(alias: string, overrides: Partial<Record<string, unknown>> = {}): StoredCredential {
    return {
        isDefault: false,
        alias,
        creds: {
            instanceUrl: `https://${alias}.service-now.com`,
            type: 'basic',
            username: 'admin',
            password: 'pw',
            ...overrides,
        },
    } as StoredCredential;
}

function store(...entries: StoredCredential[]): KeyStore {
    return Object.fromEntries(entries.map((e) => [e.alias, e]));
}

describe('isPlausibleExpiresAtSeconds', () => {
    it('accepts a seconds timestamp', () => {
        expect(isPlausibleExpiresAtSeconds(VALID_EXPIRES_AT)).toBe(true);
        expect(isPlausibleExpiresAtSeconds(1)).toBe(true);
    });

    it('rejects a milliseconds timestamp', () => {
        // The whole point: this is the same instant, and it makes the SDK's refresh
        // condition permanently false.
        expect(isPlausibleExpiresAtSeconds(EXPIRES_AT_IN_MS)).toBe(false);
    });

    it('rejects values that are not usable timestamps at all', () => {
        for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '123', null, undefined, {}]) {
            expect(isPlausibleExpiresAtSeconds(bad)).toBe(false);
        }
    });
});

describe('findCredsProblems — oauth', () => {
    it('passes a well-formed credential', () => {
        expect(findCredsProblems('dev', oauth('dev').creds)).toEqual([]);
    });

    it('blocks a milliseconds expires_at and explains the consequence', () => {
        const problems = findCredsProblems('dev', oauth('dev', { expires_at: EXPIRES_AT_IN_MS }).creds);
        const blocking = blockingProblems(problems);

        expect(blocking).toHaveLength(1);
        expect(blocking[0].field).toBe('expires_at');
        expect(blocking[0].message).toMatch(/401/);
    });

    it('blocks a past-dated expires_at only when it is not a valid seconds value', () => {
        // A past seconds value is legitimate — it just means "refresh now".
        expect(blockingProblems(findCredsProblems('dev', oauth('dev', { expires_at: 1 }).creds))).toEqual([]);
        expect(
            blockingProblems(findCredsProblems('dev', oauth('dev', { expires_at: -5 }).creds)),
        ).toHaveLength(1);
    });

    it('blocks a missing access_token', () => {
        const blocking = blockingProblems(findCredsProblems('dev', oauth('dev', { access_token: '' }).creds));
        expect(blocking).toHaveLength(1);
        expect(blocking[0].field).toBe('access_token');
    });

    it('only warns about token_type and instanceUrl', () => {
        const problems = findCredsProblems('dev', oauth('dev', { token_type: '', instanceUrl: '' }).creds);
        expect(blockingProblems(problems)).toEqual([]);
        expect(problems).toHaveLength(2);
    });

    it('tolerates an absent expires_at rather than inventing a requirement', () => {
        const creds = oauth('dev').creds as Record<string, unknown>;
        delete creds.expires_at;
        expect(blockingProblems(findCredsProblems('dev', creds as never))).toEqual([]);
    });
});

describe('findCredsProblems — basic', () => {
    it('passes a well-formed credential', () => {
        expect(findCredsProblems('dev', basic('dev').creds)).toEqual([]);
    });

    it('blocks a non-string username or password', () => {
        expect(blockingProblems(findCredsProblems('dev', basic('dev', { username: 42 }).creds))).toHaveLength(1);
        expect(blockingProblems(findCredsProblems('dev', basic('dev', { password: null }).creds))).toHaveLength(1);
    });

    it('allows an empty password, which the SDK does store', () => {
        expect(blockingProblems(findCredsProblems('dev', basic('dev', { password: '' }).creds))).toEqual([]);
    });
});

describe('findCredentialProblems', () => {
    it('reports nothing for a clean store', () => {
        expect(findCredentialProblems(store(oauth('dev'), basic('prod')))).toEqual([]);
    });

    it('labels each problem with its alias', () => {
        const problems = findCredentialProblems(
            store(oauth('dev', { expires_at: EXPIRES_AT_IN_MS }), oauth('prod')),
        );
        expect(problems).toHaveLength(1);
        expect(problems[0].alias).toBe('dev');
    });

    it('blocks an entry with no credential at all', () => {
        const broken = { dev: { isDefault: false, alias: 'dev' } } as unknown as KeyStore;
        expect(blockingProblems(findCredentialProblems(broken))).toHaveLength(1);
    });
});

describe('describeProblems', () => {
    it('names fields without ever printing a value', () => {
        const text = describeProblems(
            findCredentialProblems(store(basic('dev', { password: 12345 }))),
        );
        expect(text).toContain('dev.password');
        expect(text).not.toContain('12345');
    });
});
