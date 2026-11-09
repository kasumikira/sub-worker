function trackerKey(bucket, key) {
    return `${bucket}\0${key}`;
}

function isTrackable(value) {
    return value !== null && typeof value === 'object';
}

export class TrackedStorageAdapter {
    constructor(storage) {
        this.storage = storage;
        this.entries = new Map();
    }

    track(bucket, key, value, replace = false) {
        const id = trackerKey(bucket, key);
        if (!isTrackable(value)) {
            this.entries.delete(id);
        } else if (replace || !this.entries.has(id)) {
            this.entries.set(id, {
                bucket,
                key,
                value,
                snapshot: JSON.stringify(value),
            });
        }
        return value;
    }

    getData(key) {
        return this.track('data', key, this.storage.getData(key));
    }

    putData(key, value) {
        const result = this.storage.putData(key, value);
        this.track('data', key, value, true);
        return result;
    }

    deleteData(key) {
        const result = this.storage.deleteData(key);
        this.entries.delete(trackerKey('data', key));
        return result;
    }

    getRoot(key) {
        return this.track('root', key, this.storage.getRoot(key));
    }

    putRoot(key, value) {
        const result = this.storage.putRoot(key, value);
        this.track('root', key, value, true);
        return result;
    }

    deleteRoot(key) {
        const result = this.storage.deleteRoot(key);
        this.entries.delete(trackerKey('root', key));
        return result;
    }

    loadData() {
        return this.storage.loadData();
    }

    replaceData(data) {
        const result = this.storage.replaceData(data);
        for (const [id, entry] of this.entries) {
            if (entry.bucket === 'data') this.entries.delete(id);
        }
        return result;
    }

    flushImplicitWrites() {
        const changed = [];
        for (const entry of this.entries.values()) {
            const current = JSON.stringify(entry.value);
            if (current === entry.snapshot) continue;
            if (entry.bucket === 'data') {
                this.storage.putData(entry.key, entry.value);
            } else {
                this.storage.putRoot(entry.key, entry.value);
            }
            entry.snapshot = current;
            changed.push(`${entry.bucket}:${entry.key}`);
        }
        return changed;
    }
}
