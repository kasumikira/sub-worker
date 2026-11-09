const STORAGE_VERSION_KEY = '\0cloudflare-storage-version';
const MARK_MIGRATED = 'INSERT INTO sub_store_root (key, value) VALUES (?, ?)';

export function migrateLegacyKV(storage) {
    const { sql, kv } = storage;
    const migrated = sql
        .exec('SELECT 1 FROM sub_store_root WHERE key = ?', STORAGE_VERSION_KEY)
        .toArray()[0];
    if (migrated) return;

    const legacy = [];
    for (const [bucket, table] of [
        ['cache', 'sub_store_data'],
        ['root', 'sub_store_root'],
    ]) {
        const prefix = `${bucket}\0`;
        for (const [storageKey, value] of kv.list({ prefix })) {
            legacy.push({
                table,
                storageKey,
                key: storageKey.slice(prefix.length),
                value,
            });
        }
    }

    if (!legacy.length) {
        sql.exec(MARK_MIGRATED, STORAGE_VERSION_KEY, '1');
        return;
    }

    storage.transactionSync(() => {
        sql.exec('DELETE FROM sub_store_data');
        sql.exec('DELETE FROM sub_store_root');

        for (const { table, key, value } of legacy) {
            sql.exec(
                `INSERT INTO ${table} (key, value) VALUES (?, ?)`,
                key,
                value,
            );
        }

        for (const { storageKey } of legacy) kv.delete(storageKey);
        sql.exec(MARK_MIGRATED, STORAGE_VERSION_KEY, '1');
    });
}
