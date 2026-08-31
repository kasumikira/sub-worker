import quickJSVariant from '@jitl/quickjs-wasmfile-release-sync';
import quickJSWasmModule from '@jitl/quickjs-wasmfile-release-sync/wasm';
import {
    newQuickJSWASMModuleFromVariant,
    newVariant,
    shouldInterruptAfterDeadline,
} from 'quickjs-emscripten-core';
import { registerDynamicFunctionFactory } from '@/utils/dynamic-function-runtime';

const MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;
const STACK_LIMIT_BYTES = 512 * 1024;
const EXECUTION_LIMIT_MS = 1000;
const MAX_PENDING_JOB_PASSES = 1000;
const UNSUPPORTED_PREFIX = '[QuickJS runtime]';

const cloudflareVariant = newVariant(quickJSVariant, {
    wasmModule: quickJSWasmModule,
});

let quickJSModulePromise;
let quickJSRuntimePromise;

function getQuickJSModule() {
    if (!quickJSModulePromise) {
        quickJSModulePromise =
            newQuickJSWASMModuleFromVariant(cloudflareVariant);
    }
    return quickJSModulePromise;
}

function getQuickJSRuntime() {
    if (!quickJSRuntimePromise) {
        quickJSRuntimePromise = getQuickJSModule()
            .then((QuickJS) => {
                const runtime = QuickJS.newRuntime();
                runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
                runtime.setMaxStackSize(STACK_LIMIT_BYTES);
                return runtime;
            })
            .catch((error) => {
                quickJSRuntimePromise = undefined;
                throw error;
            });
    }
    return quickJSRuntimePromise;
}

function unsupported(feature, detail) {
    const suffix = detail ? `: ${detail}` : '';
    throw new Error(
        `${UNSUPPORTED_PREFIX} ${feature} is not supported on Cloudflare${suffix}`,
    );
}

function unsupportedFunction(feature, detail) {
    return () => unsupported(feature, detail);
}

function isPromiseLike(value) {
    return value && typeof value.then === 'function';
}

function toQuickJSHandle(vm, value, seen = new Set(), path = 'value') {
    if (typeof value === 'undefined') return vm.undefined;
    if (value === null) return vm.null;
    if (typeof value === 'boolean') return value ? vm.true : vm.false;
    if (typeof value === 'number') return vm.newNumber(value);
    if (typeof value === 'string') return vm.newString(value);
    if (typeof value === 'bigint') return vm.newBigInt(value);
    if (typeof value === 'function') {
        unsupported(`function-valued data at ${path}`);
    }
    if (typeof value !== 'object') {
        unsupported(`${typeof value} data at ${path}`);
    }
    if (seen.has(value)) {
        unsupported(`cyclic data at ${path}`);
    }

    seen.add(value);
    try {
        if (value instanceof Date) return vm.newString(value.toISOString());
        if (value instanceof ArrayBuffer) return vm.newArrayBuffer(value);
        if (ArrayBuffer.isView(value)) {
            return vm.newArrayBuffer(
                value.buffer.slice(
                    value.byteOffset,
                    value.byteOffset + value.byteLength,
                ),
            );
        }

        const handle = Array.isArray(value) ? vm.newArray() : vm.newObject();
        try {
            Object.entries(value).forEach(([key, child]) => {
                const childHandle = toQuickJSHandle(
                    vm,
                    child,
                    seen,
                    `${path}.${key}`,
                );
                try {
                    vm.setProp(handle, key, childHandle);
                } finally {
                    childHandle.dispose();
                }
            });
            return handle;
        } catch (error) {
            handle.dispose();
            throw error;
        }
    } finally {
        seen.delete(value);
    }
}

function dumpArgument(vm, handle, feature) {
    const type = vm.typeof(handle);
    if (type === 'function') {
        unsupported(
            `${feature} callback arguments`,
            'use native JavaScript array methods inside the script instead',
        );
    }
    if (type === 'symbol') unsupported(`${feature} symbol arguments`);
    return vm.dump(handle);
}

function createHostFunction(vm, name, fn, receiver) {
    return vm.newFunction(
        name.split('.').pop() || 'hostFunction',
        (...args) => {
            if (fn.constructor?.name === 'AsyncFunction') {
                unsupported(`${name} asynchronous host API`);
            }
            const result = fn.apply(
                receiver,
                args.map((arg) => dumpArgument(vm, arg, name)),
            );
            if (isPromiseLike(result)) {
                unsupported(`${name} asynchronous host API`);
            }
            return toQuickJSHandle(vm, result, new Set(), `${name} result`);
        },
    );
}

function createHostNamespace(vm, value, name, seen = new Set()) {
    if (typeof value === 'function') {
        return createHostFunction(vm, name, value, undefined);
    }
    if (!value || typeof value !== 'object') {
        return toQuickJSHandle(vm, value, new Set(), name);
    }
    if (seen.has(value)) unsupported(`cyclic host namespace ${name}`);

    seen.add(value);
    const handle = vm.newObject();
    try {
        Object.keys(value).forEach((key) => {
            const child = value[key];
            const childHandle =
                typeof child === 'function'
                    ? createHostFunction(vm, `${name}.${key}`, child, value)
                    : createHostNamespace(vm, child, `${name}.${key}`, seen);
            try {
                vm.setProp(handle, key, childHandle);
            } finally {
                childHandle.dispose();
            }
        });
        return handle;
    } catch (error) {
        handle.dispose();
        throw error;
    } finally {
        seen.delete(value);
    }
}

function setGlobal(vm, name, handle) {
    try {
        vm.setProp(vm.global, name, handle);
    } finally {
        handle.dispose();
    }
}

function createUnsupportedNamespace(features) {
    return Object.fromEntries(
        features.map((feature) => [feature, unsupportedFunction(feature)]),
    );
}

function createSafeBindings(bindings) {
    const {
        $arguments,
        $options,
        $substore,
        lodash,
        ProxyUtils,
        yaml,
        b64d,
        b64e,
        DOMAIN_RESOLVERS,
        scriptResourceCache,
        flowUtils,
    } = bindings;

    const safeSubstore = {
        env: $substore.env,
        read: $substore.read.bind($substore),
        write: $substore.write.bind($substore),
        delete: $substore.delete.bind($substore),
        log: $substore.log.bind($substore),
        info: $substore.info.bind($substore),
        warn: $substore.warn.bind($substore),
        error: $substore.error.bind($substore),
        notify: $substore.notify.bind($substore),
        http: createUnsupportedNamespace([
            '$substore.http.request',
            '$substore.http.get',
            '$substore.http.post',
            '$substore.http.put',
            '$substore.http.patch',
            '$substore.http.delete',
            '$substore.http.head',
            '$substore.http.options',
        ]),
    };
    const safeLodash = Object.fromEntries(
        Object.entries(lodash).filter(([, value]) => {
            return (
                value === null ||
                ['function', 'string', 'number', 'boolean'].includes(
                    typeof value,
                )
            );
        }),
    );
    const safeProxyUtils = {
        parse: ProxyUtils.parse,
        produce: ProxyUtils.produce,
        age: ProxyUtils.age,
        getRandomPort: ProxyUtils.getRandomPort,
        isIPv4: ProxyUtils.isIPv4,
        isIPv6: ProxyUtils.isIPv6,
        isIP: ProxyUtils.isIP,
        yaml: ProxyUtils.yaml,
        getFlag: ProxyUtils.getFlag,
        removeFlag: ProxyUtils.removeFlag,
        getISO: ProxyUtils.getISO,
        Base64: ProxyUtils.Base64,
        JSON5: ProxyUtils.JSON5,
        hex_md5: ProxyUtils.hex_md5,
        process: unsupportedFunction('ProxyUtils.process'),
        processResponse: unsupportedFunction('ProxyUtils.processResponse'),
        download: unsupportedFunction('ProxyUtils.download'),
        downloadFile: unsupportedFunction('ProxyUtils.downloadFile'),
        doh: unsupportedFunction('ProxyUtils.doh'),
        Gist: unsupportedFunction('ProxyUtils.Gist'),
        MMDB: unsupportedFunction('ProxyUtils.MMDB'),
        ipAddress: unsupportedFunction('ProxyUtils.ipAddress'),
        Buffer: unsupportedFunction('ProxyUtils.Buffer'),
    };
    const safeDomainResolvers = Object.fromEntries(
        Object.keys(DOMAIN_RESOLVERS).map((name) => [
            name,
            unsupportedFunction(`DOMAIN_RESOLVERS.${name}`),
        ]),
    );
    const safeScriptResourceCache = {
        get: scriptResourceCache.get.bind(scriptResourceCache),
        gettime: scriptResourceCache.gettime.bind(scriptResourceCache),
        set: scriptResourceCache.set.bind(scriptResourceCache),
        revokeAll: scriptResourceCache.revokeAll.bind(scriptResourceCache),
    };

    return {
        $arguments,
        $options,
        $substore: safeSubstore,
        lodash: safeLodash,
        ProxyUtils: safeProxyUtils,
        yaml,
        b64d,
        b64e,
        DOMAIN_RESOLVERS: safeDomainResolvers,
        scriptResourceCache: safeScriptResourceCache,
        flowUtils,
        produceArtifact: unsupportedFunction('produceArtifact'),
        require: unsupportedFunction('require'),
    };
}

function installConsole(vm, $substore) {
    const consoleApi = {
        log: $substore.log.bind($substore),
        info: $substore.info.bind($substore),
        warn: $substore.warn.bind($substore),
        error: $substore.error.bind($substore),
        debug: $substore.log.bind($substore),
    };
    setGlobal(vm, 'console', createHostNamespace(vm, consoleApi, 'console'));
}

function installUnsupportedGlobals(vm, $substore) {
    const functions = [
        'fetch',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'queueMicrotask',
    ];
    functions.forEach((name) => {
        setGlobal(
            vm,
            name,
            createHostFunction(vm, name, unsupportedFunction(name)),
        );
    });
    setGlobal(
        vm,
        '$httpClient',
        createHostNamespace(
            vm,
            createUnsupportedNamespace([
                '$httpClient.get',
                '$httpClient.post',
                '$httpClient.put',
                '$httpClient.patch',
                '$httpClient.delete',
            ]),
            '$httpClient',
        ),
    );
    setGlobal(
        vm,
        '$persistentStore',
        createHostNamespace(
            vm,
            {
                read: $substore.read.bind($substore),
                write: $substore.write.bind($substore),
            },
            '$persistentStore',
        ),
    );
    setGlobal(
        vm,
        '$notification',
        createHostNamespace(
            vm,
            {
                post: $substore.notify.bind($substore),
            },
            '$notification',
        ),
    );
    const result = vm.evalCode(`
        const __subStoreUnsupportedGlobal = (feature) => new Proxy(function () {}, {
            get() {
                throw new Error('${UNSUPPORTED_PREFIX} ' + feature + ' is not supported on Cloudflare');
            },
            apply() {
                throw new Error('${UNSUPPORTED_PREFIX} ' + feature + ' is not supported on Cloudflare');
            },
            construct() {
                throw new Error('${UNSUPPORTED_PREFIX} ' + feature + ' is not supported on Cloudflare');
            }
        });
        globalThis.process = __subStoreUnsupportedGlobal('process');
        globalThis.global = __subStoreUnsupportedGlobal('global');
        globalThis.module = __subStoreUnsupportedGlobal('module');
        globalThis.exports = __subStoreUnsupportedGlobal('exports');
        globalThis.WebSocket = __subStoreUnsupportedGlobal('WebSocket');
        globalThis.XMLHttpRequest = __subStoreUnsupportedGlobal('XMLHttpRequest');
    `);
    if (result.error) {
        const error = vm.dump(result.error);
        result.error.dispose();
        throw new Error(formatQuickJSError(error));
    }
    result.value.dispose();
}

function installBufferShim(vm) {
    const result = vm.evalCode(`
        globalThis.Buffer = Object.freeze({
            from(value, encoding = 'utf8') {
                const normalized = String(encoding).toLowerCase();
                const text = normalized === 'base64' ? b64d(String(value)) : String(value);
                return Object.freeze({
                    toString(outputEncoding = 'utf8') {
                        const output = String(outputEncoding).toLowerCase();
                        if (output === 'base64') return b64e(text);
                        if (output === 'utf8' || output === 'utf-8') return text;
                        throw new Error('${UNSUPPORTED_PREFIX} Buffer encoding "' + output + '" is not supported on Cloudflare');
                    }
                });
            }
        });
        ProxyUtils.Buffer = Buffer;
        globalThis.atob = b64d;
        globalThis.btoa = b64e;
    `);
    if (result.error) {
        const error = vm.dump(result.error);
        result.error.dispose();
        throw new Error(formatQuickJSError(error));
    }
    result.value.dispose();
}

function formatQuickJSError(error) {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object') {
        if (error.message && error.stack) {
            return `${error.message}\n${error.stack}`;
        }
        return error.message || error.stack || JSON.stringify(error);
    }
    return String(error);
}

function unwrapQuickJSResult(vm, result) {
    if (result.error) {
        const error = vm.dump(result.error);
        result.error.dispose();
        throw new Error(formatQuickJSError(error));
    }
    return result.value;
}

async function executeQuickJSScript({ name, script, bindings }, args) {
    const runtime = await getQuickJSRuntime();
    runtime.setInterruptHandler(
        shouldInterruptAfterDeadline(Date.now() + EXECUTION_LIMIT_MS),
    );
    const vm = runtime.newContext();

    try {
        const safeBindings = createSafeBindings(bindings);
        Object.entries(safeBindings).forEach(([bindingName, value]) => {
            setGlobal(
                vm,
                bindingName,
                createHostNamespace(vm, value, bindingName),
            );
        });
        setGlobal(
            vm,
            '__subStoreInvocationArguments',
            toQuickJSHandle(vm, args, new Set(), 'invocation arguments'),
        );
        installConsole(vm, bindings.$substore);
        installUnsupportedGlobals(vm, bindings.$substore);
        installBufferShim(vm);

        const evaluation = vm.evalCode(`
            Promise.resolve((() => {
                ${script}
                if (typeof ${name} !== 'function') {
                    throw new Error('Dynamic script must define function ${name}');
                }
                return ${name}(...__subStoreInvocationArguments);
            })())
        `);
        const promiseHandle = unwrapQuickJSResult(vm, evaluation);
        try {
            let state = vm.getPromiseState(promiseHandle);
            let passes = 0;
            while (
                state.type === 'pending' &&
                passes < MAX_PENDING_JOB_PASSES
            ) {
                const jobs = runtime.executePendingJobs();
                if (jobs.error) {
                    const error = vm.dump(jobs.error);
                    jobs.error.dispose();
                    throw new Error(formatQuickJSError(error));
                }
                passes += 1;
                state = vm.getPromiseState(promiseHandle);
                if (state.type === 'pending' && jobs.value === 0) break;
            }
            if (state.type === 'pending') {
                unsupported(
                    'unresolved asynchronous script operations',
                    'host I/O and timers are unavailable',
                );
            }
            if (state.type === 'rejected') {
                const error = vm.dump(state.error);
                state.error.dispose();
                throw new Error(formatQuickJSError(error));
            }
            const output = vm.dump(state.value);
            state.value.dispose();
            return output;
        } finally {
            promiseHandle.dispose();
        }
    } finally {
        vm.dispose();
    }
}

export function registerQuickJSRuntime() {
    registerDynamicFunctionFactory(({ name, script, bindings }) => {
        return (...args) =>
            executeQuickJSScript({ name, script, bindings }, args);
    });
}
