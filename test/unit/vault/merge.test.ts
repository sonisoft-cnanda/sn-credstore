import { describe, it, expect } from '@jest/globals';
import { diffKeyStores, mergeKeyStores, detectClobber, normalizeDefaults } from '../../../src/vault/merge.js';
import type { KeyStore, StoredCredential } from '../../../src/types.js';

function oauth(alias: string, expiresAt: number, isDefault = false, token = 'AT'): StoredCredential {
    return {
        isDefault,
        alias,
        creds: {
            instanceUrl: `https://${alias}.service-now.com`,
            type: 'oauth',
            access_token: token,
            token_type: 'Bearer',
            refresh_token: `RT-${token}`,
            expires_at: expiresAt,
        },
    };
}

function store(...entries: StoredCredential[]): KeyStore {
    return Object.fromEntries(entries.map((e) => [e.alias, e]));
}

describe('diffKeyStores', () => {
    it('classifies additions, modifications and removals', () => {
        const base = store(oauth('a', 100), oauth('b', 100));
        const incoming = store(oauth('a', 999), oauth('c', 100));

        const d = diffKeyStores(base, incoming);
        expect(d.added).toEqual(['c']);
        expect(d.modified).toEqual(['a']);
        expect(d.removed).toEqual(['b']);
    });

    it('reports no changes for an identical store', () => {
        const s = store(oauth('a', 100));
        expect(diffKeyStores(s, structuredClone(s))).toEqual({ added: [], modified: [], removed: [] });
    });
});

describe('mergeKeyStores', () => {
    it('does not clobber a concurrent refresh of a different alias', () => {
        // We handed the SDK {a,b}. It refreshed 'a'. Meanwhile another agent
        // refreshed 'b'. Persisting `incoming` verbatim would revert 'b'.
        const base = store(oauth('a', 100), oauth('b', 100));
        const incoming = store(oauth('a', 5000, false, 'A-new'), oauth('b', 100));
        const current = store(oauth('a', 100), oauth('b', 6000, false, 'B-new'));

        const { merged } = mergeKeyStores(base, incoming, current);

        expect((merged.a!.creds as { access_token: string }).access_token).toBe('A-new');
        expect((merged.b!.creds as { access_token: string }).access_token).toBe('B-new');
    });

    it('keeps the newer token when both sides refreshed the same alias', () => {
        // The later expires_at is the token the server issued most recently;
        // persisting the older one guarantees a 401 on next use.
        const base = store(oauth('a', 100));
        const incoming = store(oauth('a', 500, false, 'older'));
        const current = store(oauth('a', 900, false, 'newer'));

        const { merged } = mergeKeyStores(base, incoming, current);
        expect((merged.a!.creds as { access_token: string }).access_token).toBe('newer');
    });

    it('PRESERVES aliases the caller dropped when removals are not authorised', () => {
        // This is the store-wipe guard: the SDK seeds writes from `{}` after a
        // failed read, which looks exactly like "remove everything".
        const base = store(oauth('a', 100), oauth('b', 100));
        const incoming: KeyStore = {};
        const current = store(oauth('a', 100), oauth('b', 100));

        const { merged, protectedAliases } = mergeKeyStores(base, incoming, current);

        expect(Object.keys(merged).sort()).toEqual(['a', 'b']);
        expect(protectedAliases.sort()).toEqual(['a', 'b']);
    });

    it('DOES remove aliases when removal was explicitly authorised', () => {
        // Otherwise `now-sdk auth --delete` would silently never work.
        const base = store(oauth('a', 100), oauth('b', 100));
        const incoming = store(oauth('a', 100));
        const current = store(oauth('a', 100), oauth('b', 100));

        const { merged } = mergeKeyStores(base, incoming, current, { allowRemovals: true });
        expect(Object.keys(merged)).toEqual(['a']);
    });

    it('does not resurrect an alias a peer deleted, when we did not touch it', () => {
        const base = store(oauth('a', 100), oauth('b', 100));
        const incoming = store(oauth('a', 500), oauth('b', 100)); // only 'a' changed
        const current = store(oauth('a', 100)); // peer removed 'b'

        const { merged } = mergeKeyStores(base, incoming, current);
        expect(Object.keys(merged)).toEqual(['a']);
    });
});

describe('normalizeDefaults', () => {
    it('collapses multiple defaults to exactly one', () => {
        const s = store(oauth('a', 1, true), oauth('b', 1, true));
        const n = normalizeDefaults(s);
        expect(Object.values(n).filter((e) => e.isDefault)).toHaveLength(1);
    });

    it('honours the preferred alias', () => {
        const s = store(oauth('a', 1, true), oauth('b', 1, false));
        const n = normalizeDefaults(s, 'b');
        expect(n.b!.isDefault).toBe(true);
        expect(n.a!.isDefault).toBe(false);
    });

    it('leaves an empty store alone', () => {
        expect(normalizeDefaults({})).toEqual({});
    });
});

describe('detectClobber', () => {
    it('reports aliases that would vanish', () => {
        expect(detectClobber(store(oauth('a', 1), oauth('b', 1)), store(oauth('a', 1)))).toEqual(['b']);
    });

    it('reports nothing when there is no prior read to compare against', () => {
        // No baseline means we cannot distinguish a wipe from a first write.
        expect(detectClobber(null, {})).toEqual([]);
    });

    it('reports nothing when everything is retained', () => {
        expect(detectClobber(store(oauth('a', 1)), store(oauth('a', 1), oauth('b', 1)))).toEqual([]);
    });
});
