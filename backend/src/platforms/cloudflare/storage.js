import { migrateLegacyKV } from './storage-migration.js';

export const MAX_VALUE_BYTES = 1_900_000;

const TABLES = {
    data: 'sub_store_data',
    root: 'sub_store_root',
};

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

function decodeValue(value) {
    return value == null ? undefined : JSON.parse(value);
}

export class DOStorageAdapter {
    constructor(storage) {
        if (!storage) throw new Error('Missing Durable Object storage');
        this.storage = storage;
        this.sql = storage.sql;
        this.caches = {
            data: new Map(),
            root: new Map(),
        };

        this.sql.exec(`
            CREATE TABLE IF NOT EXISTS sub_store_data (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            ) WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS sub_store_root (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            ) WITHOUT ROWID;
        `);
        migrateLegacyKV(storage);
    }

    get(bucket, key) {
        const cache = this.caches[bucket];
        if (!cache.has(key)) {
            const row = this.sql
                .exec(`SELECT value FROM ${TABLES[bucket]} WHERE key = ?`, key)
                .toArray()[0];
            cache.set(key, decodeValue(row?.value));
        }
        return cache.get(key);
    }

    put(bucket, key, value) {
        try {
            const encoded = encodeValue(bucket, key, value);
            this.sql.exec(
                `INSERT INTO ${TABLES[bucket]} (key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value
                 WHERE value <> excluded.value`,
                key,
                encoded,
            );
        } finally {
            this.caches[bucket].delete(key);
        }
    }

    delete(bucket, key) {
        try {
            this.sql.exec(`DELETE FROM ${TABLES[bucket]} WHERE key = ?`, key);
        } finally {
            this.caches[bucket].delete(key);
        }
    }

    getData(key) {
        return this.get('data', key);
    }

    putData(key, value) {
        this.put('data', key, value);
    }

    deleteData(key) {
        this.delete('data', key);
    }

    getRoot(key) {
        return this.get('root', key);
    }

    putRoot(key, value) {
        this.put('root', key, value);
    }

    deleteRoot(key) {
        this.delete('root', key);
    }

    loadData() {
        const data = {};
        for (const { key, value } of this.sql.exec(
            'SELECT key, value FROM sub_store_data',
        )) {
            data[key] = JSON.parse(value);
        }
        return data;
    }

    replaceData(data) {
        try {
            const entries = Object.entries(data).map(([key, value]) => [
                key,
                encodeValue('data', key, value),
            ]);
            this.storage.transactionSync(() => {
                this.sql.exec('DELETE FROM sub_store_data');
                for (const [key, value] of entries) {
                    this.sql.exec(
                        'INSERT INTO sub_store_data (key, value) VALUES (?, ?)',
                        key,
                        value,
                    );
                }
            });
        } finally {
            this.caches.data.clear();
        }
    }
}
