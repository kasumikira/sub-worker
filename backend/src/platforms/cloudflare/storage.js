export const MAX_VALUE_BYTES = 1_900_000;

function storageKey(bucket, key) {
    return `${bucket}\0${key}`;
}

function encodeValue(bucket, key, value) {
    const encoded = JSON.stringify(value);
    const bytes = new TextEncoder().encode(encoded).byteLength;
    if (bytes > MAX_VALUE_BYTES) {
        throw new Error(
            `Durable Object storage value ${bucket}:${key} is ${bytes} bytes; the adapter limit is ${MAX_VALUE_BYTES} bytes`,
        );
    }
    return encoded;
}

export class DOStorageAdapter {
    constructor(storage) {
        if (!storage) throw new Error('Missing Durable Object storage');
        this.kv = storage.kv;
    }

    loadBucket(bucket) {
        const entries = {};
        const prefix = `${bucket}\0`;
        for (const [key, value] of this.kv.list({ prefix })) {
            entries[key.slice(prefix.length)] = JSON.parse(value);
        }
        return entries;
    }

    loadCache() {
        return structuredClone(this.loadBucket('cache'));
    }

    loadRoot() {
        return this.loadBucket('root');
    }

    getRoot(key) {
        const value = this.kv.get(storageKey('root', key));
        return value == null ? undefined : JSON.parse(value);
    }

    replaceCache(cache) {
        const prefix = 'cache\0';
        const existing = new Map();
        for (const [key, value] of this.kv.list({ prefix })) {
            existing.set(key, value);
        }
        for (const key of existing.keys()) {
            if (!Object.hasOwn(cache, key.slice(prefix.length))) {
                this.kv.delete(key);
            }
        }
        for (const [key, value] of Object.entries(cache)) {
            const storedKey = storageKey('cache', key);
            const stored = existing.has(storedKey)
                ? JSON.parse(existing.get(storedKey))
                : undefined;
            if (JSON.stringify(stored) !== JSON.stringify(value)) {
                this.kv.put(storedKey, encodeValue('cache', key, value));
            }
        }
    }

    putCache(key, value) {
        this.kv.put(storageKey('cache', key), encodeValue('cache', key, value));
    }

    putRoot(key, value) {
        this.kv.put(storageKey('root', key), encodeValue('root', key, value));
    }

    deleteCache(key) {
        this.kv.delete(storageKey('cache', key));
    }

    deleteRoot(key) {
        this.kv.delete(storageKey('root', key));
    }
}
