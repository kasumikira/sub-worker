import { AsyncLocalStorage } from 'node:async_hooks';

const requestContext = new AsyncLocalStorage();
let attachedStorage;

export const $httpClient = {};

for (const method of ['get', 'post', 'put', 'delete', 'head', 'options', 'patch']) {
    $httpClient[method] = (options, callback) => {
        fetch(options.url, {
            method: method.toUpperCase(),
            headers: options.headers,
            body: ['get', 'head'].includes(method) ? undefined : options.body,
            redirect: 'follow',
        })
            .then(async (response) => {
                const body =
                    options.encoding === null
                        ? await response.arrayBuffer()
                        : await response.text();
                callback(
                    null,
                    {
                        status: response.status,
                        statusCode: response.status,
                        headers: Object.fromEntries(response.headers),
                    },
                    body,
                );
            })
            .catch((error) => callback(error));
    };
}

function storage() {
    return requestContext.getStore()?.storage || attachedStorage;
}

export const $persistentStore = {
    read(key) {
        const adapter = storage();
        if (!adapter) return null;
        if (key === 'sub-store') return JSON.stringify(adapter.loadCache());
        return adapter.getRoot(key);
    },

    write(value, key) {
        const adapter = storage();
        if (!adapter) return false;
        if (key === 'sub-store') {
            adapter.replaceCache(JSON.parse(value || '{}'));
        } else if (value == null) {
            adapter.deleteRoot(key);
        } else {
            adapter.putRoot(key, value);
        }
        return true;
    },
};

export const $request = new Proxy(
    {},
    {
        get(target, property) {
            return requestContext.getStore()?.request?.[property];
        },
    },
);

export function $done(value) {
    const context = requestContext.getStore();
    if (!context) throw new Error('$done called outside a Worker request');
    context.resolve(value?.response || value);
}

export function attachPersistentStore(adapter, app) {
    attachedStorage = adapter;
    app.cache = adapter.loadCache();
}

export function runWithLegacyGlobals(request, adapter, callback) {
    return new Promise((resolve, reject) => {
        requestContext.run({ request, resolve, storage: adapter }, () => {
            try {
                callback();
            } catch (error) {
                reject(error);
            }
        });
    });
}
