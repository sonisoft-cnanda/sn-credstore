import { BasicCred, Creds, KeyStore } from '../types.js';
import { StoreCorruptError } from '../errors.js';
import { isPlausibleExpiresAtSeconds } from '../validate.js';

/** Compare-and-replace intent; null requires the alias to be absent. */
export type CredentialChange = { alias: string; expected: Creds | null; creds: Creds };

function invalid(): never {
    throw new StoreCorruptError('Invalid credential transfer data.', 'Supply complete SDK credential fields and matching, safe aliases.');
}

function record(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !descriptors[key]?.enumerable || !('value' in descriptors[key]!))) invalid();
    return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, names: string[]): void {
    const keys = Object.keys(value);
    if (keys.length !== names.length || names.some(name => !Object.hasOwn(value, name))) invalid();
}

function aliasOf(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || ['__proto__', 'constructor', 'prototype'].includes(value)) invalid();
    return value;
}

function stringOf(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0) invalid();
    return value;
}

export function copyCreds(value: unknown): Creds {
    const creds = record(value);
    const instanceUrl = stringOf(creds.instanceUrl);
    if (creds.type === 'basic') {
        const names = ['type', 'instanceUrl', 'username', 'password'];
        const hasHost = Object.hasOwn(creds, 'host');
        if (hasHost) names.push('host');
        fields(creds, names);
        const copied: BasicCred = { type: 'basic', instanceUrl, username: stringOf(creds.username), password: stringOf(creds.password) };
        if (hasHost) {
            const host = stringOf(creds.host);
            if (host !== instanceUrl) invalid();
            copied.host = host;
        }
        return copied;
    }
    if (creds.type !== 'oauth') invalid();
    fields(creds, ['type', 'instanceUrl', 'access_token', 'token_type', 'refresh_token', 'expires_at']);
    if (!isPlausibleExpiresAtSeconds(creds.expires_at)) invalid();
    return { type: 'oauth', instanceUrl, access_token: stringOf(creds.access_token), token_type: stringOf(creds.token_type),
        refresh_token: stringOf(creds.refresh_token), expires_at: creds.expires_at as number };
}

export function copyKeyStore(value: unknown): KeyStore {
    const source = record(value);
    const entries = Object.entries(source).map(([key, value]) => {
        const alias = aliasOf(key);
        const entry = record(value);
        fields(entry, ['alias', 'isDefault', 'creds']);
        if (entry.alias !== alias || typeof entry.isDefault !== 'boolean') invalid();
        return [alias, { alias, isDefault: entry.isDefault, creds: copyCreds(entry.creds) }] as const;
    });
    if (entries.filter(([, entry]) => entry.isDefault).length > 1) invalid();
    return Object.fromEntries(entries);
}

export function copyChanges(value: readonly CredentialChange[]): CredentialChange[] {
    if (!Array.isArray(value)) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).length !== value.length + 1) invalid();
    const seen = new Set<string>();
    return Array.from({ length: value.length }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor?.enumerable || !('value' in descriptor)) invalid();
        const change = record(descriptor.value);
        fields(change, ['alias', 'expected', 'creds']);
        const alias = aliasOf(change.alias);
        if (seen.has(alias)) invalid();
        seen.add(alias);
        return { alias, expected: change.expected === null ? null : copyCreds(change.expected), creds: copyCreds(change.creds) };
    });
}

export function sameCreds(left: Creds, right: Creds): boolean {
    return JSON.stringify(copyCreds(left)) === JSON.stringify(copyCreds(right));
}
