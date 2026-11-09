/**
 * QuickJS runtime for the Cloudflare Worker target.
 *
 * Workers cannot evaluate JavaScript source at runtime, so the dynamic
 * operator, filter, and response-transformer scripts stored in Sub-Store run
 * inside an embedded QuickJS engine instead. Host values and functions are
 * bridged into the guest; `registerQuickJSRuntime` hands the resulting runner
 * to `@/utils/dynamic-function-runtime`.
 *
 * This is not a sandbox: the script is user-authored. The resource limits
 * below only keep a runaway script from taking the Durable Object down.
 */
import quickJSVariant from '@jitl/quickjs-wasmfile-release-sync';
import quickJSWasmModule from '@jitl/quickjs-wasmfile-release-sync/wasm';
import {
    newQuickJSWASMModuleFromVariant,
    newVariant,
    shouldInterruptAfterDeadline,
} from 'quickjs-emscripten-core';
import { registerDynamicFunctionFactory } from '@/utils/dynamic-function-runtime';
import { $persistentStore } from './legacy-globals';

const MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;
const STACK_LIMIT_BYTES = 512 * 1024;
const EXECUTION_LIMIT_MS = 1000;

let quickJSModulePromise;

// Compiling and instantiating the WASM module is shared. QuickJS runtimes are
// not: each invocation gets its own runtime, job queue, interrupt handler, and
// memory limit so nested dynamic scripts cannot interfere with their caller.
function getQuickJSModule() {
    if (!quickJSModulePromise) {
        quickJSModulePromise = newQuickJSWASMModuleFromVariant(
            newVariant(quickJSVariant, {
                wasmModule: quickJSWasmModule,
            }),
        ).catch((error) => {
            quickJSModulePromise = undefined;
            throw error;
        });
    }
    return quickJSModulePromise;
}

async function createQuickJSRuntime() {
    const QuickJS = await getQuickJSModule();
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
    runtime.setMaxStackSize(STACK_LIMIT_BYTES);
    return runtime;
}

// Restart the deadline for each synchronous segment, so wall time spent
// waiting on host I/O outside the VM does not count against the CPU budget.
function refreshDeadline(vm) {
    vm.runtime.setInterruptHandler(
        shouldInterruptAfterDeadline(Date.now() + EXECUTION_LIMIT_MS),
    );
}

function isPromiseLike(value) {
    return value && typeof value.then === 'function';
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

/* ------------------------- host value → guest value ------------------------- */

// Data is copied by value and functions become callable bridges. A function
// that is a member of an object is called with that object as its receiver, so
// `ProxyUtils.yaml.safeDump()` keeps the right `this` inside the guest.
function toGuestValue(
    vm,
    value,
    seen = new Set(),
    path = 'value',
    onFatal = undefined,
) {
    if (typeof value === 'undefined') return vm.undefined;
    if (value === null) return vm.null;
    if (typeof value === 'boolean') return value ? vm.true : vm.false;
    if (typeof value === 'number') return vm.newNumber(value);
    if (typeof value === 'string') return vm.newString(value);
    if (typeof value === 'bigint') return vm.newBigInt(value);
    if (typeof value === 'function') {
        return createHostFunction(vm, value, undefined, path, onFatal);
    }
    if (typeof value !== 'object') {
        throw new Error(`Cannot copy ${typeof value} into QuickJS`);
    }
    if (seen.has(value)) {
        throw new Error(
            `Cannot copy a circular host value (${path}) into QuickJS`,
        );
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

        const isArray = Array.isArray(value);
        const prototype = Object.getPrototypeOf(value);
        if (
            !isArray &&
            prototype !== Object.prototype &&
            prototype !== null
        ) {
            const typeName = value.constructor?.name || 'object';
            throw new Error(
                `Cannot copy host ${typeName} value (${path}) into QuickJS`,
            );
        }

        const handle = isArray ? vm.newArray() : vm.newObject();
        try {
            Object.entries(value).forEach(([key, child]) => {
                const childPath = `${path}.${key}`;
                const childHandle =
                    typeof child === 'function'
                        ? createHostFunction(
                              vm,
                              child,
                              value,
                              childPath,
                              onFatal,
                          )
                        : toGuestValue(vm, child, seen, childPath, onFatal);
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

function createHostFunction(vm, fn, receiver, name, onFatal) {
    return vm.newFunction(name, (...argHandles) => {
        const callbackHandles = [];
        try {
            const result = fn.apply(
                receiver,
                argHandles.map((argHandle) =>
                    dumpArgument(vm, argHandle, callbackHandles, onFatal),
                ),
            );
            return isPromiseLike(result)
                ? bridgeHostPromise(vm, result, name, onFatal)
                : toGuestValue(vm, result, new Set(), name, onFatal);
        } finally {
            callbackHandles.forEach((handle) => handle.dispose());
        }
    });
}

// Guest callbacks can be used by synchronous host APIs such as lodash. The
// duplicated handle stays alive for the duration of the host call. Retaining
// the callback and invoking it asynchronously is intentionally unsupported.
function createGuestCallback(vm, handle, callbackHandles, onFatal) {
    const callbackHandle = handle.dup();
    callbackHandles.push(callbackHandle);
    return (...args) => {
        const argumentHandles = args.map((arg, index) =>
            toGuestValue(
                vm,
                arg,
                new Set(),
                `callback argument ${index}`,
                onFatal,
            ),
        );
        try {
            const result = vm.callFunction(
                callbackHandle,
                vm.undefined,
                argumentHandles,
            );
            const valueHandle = unwrapQuickJSResult(vm, result);
            try {
                return vm.dump(valueHandle);
            } finally {
                valueHandle.dispose();
            }
        } finally {
            argumentHandles.forEach((argumentHandle) =>
                argumentHandle.dispose(),
            );
        }
    };
}

function dumpArgument(vm, handle, callbackHandles, onFatal) {
    const type = vm.typeof(handle);
    if (type === 'function') {
        return createGuestCallback(vm, handle, callbackHandles, onFatal);
    }
    if (type === 'symbol') {
        throw new Error('Cannot pass a symbol from the script to a host API');
    }
    return vm.dump(handle);
}

// A host function that returns a promise is represented in the guest by a
// deferred promise, resolved or rejected once the host side settles.
function bridgeHostPromise(vm, promise, name, onFatal) {
    const deferred = vm.newPromise();

    const settle = (method, value) => {
        if (!vm.alive) {
            deferred.dispose();
            return;
        }
        try {
            const handle =
                method === 'resolve'
                    ? toGuestValue(vm, value, new Set(), name, onFatal)
                    : vm.newError(formatQuickJSError(value));
            try {
                deferred[method](handle);
            } finally {
                handle.dispose();
            }
        } catch (error) {
            // The result may not be representable as a guest value (Map,
            // cycles, ...); surface that as a rejection for the script.
            const errorHandle = vm.newError(formatQuickJSError(error));
            try {
                deferred.reject(errorHandle);
            } finally {
                errorHandle.dispose();
            }
        }
    };

    Promise.resolve(promise).then(
        (value) => settle('resolve', value),
        (error) => settle('reject', error),
    );

    // Settling only queues a guest job; pump the queue so the script's `await`
    // can continue.
    void deferred.settled.then(() => {
        if (!vm.alive) return;
        refreshDeadline(vm);
        const jobs = vm.runtime.executePendingJobs();
        if (jobs.error) {
            const error = vm.dump(jobs.error);
            jobs.error.dispose();
            const message = formatQuickJSError(error);
            if (onFatal) {
                onFatal(new Error(message));
            } else {
                console.error('[Cloudflare] QuickJS job failed', message);
            }
        }
    });

    return deferred.handle;
}

/* ------------------------- globals visible to scripts ----------------------- */

// Binary data cannot be copied into the guest as-is, so Buffer values cross
// the bridge as strings. Enough for the usual
// `Buffer.from(x, 'base64').toString('utf8')` compatibility patterns.
function createBufferBridge(BufferImpl) {
    const wrap = (buffer) => {
        const value = {
            __subStoreBuffer: true,
            length: buffer.length,
            toString: (encoding = 'utf8', start, end) =>
                buffer.toString(encoding, start, end),
            slice: (start, end) => wrap(buffer.slice(start, end)),
            subarray: (start, end) => wrap(buffer.subarray(start, end)),
            toJSON: () => ({ type: 'Buffer', data: Array.from(buffer) }),
        };
        buffer.forEach((byte, index) => {
            value[index] = byte;
        });
        return value;
    };

    return {
        from(value, encoding = 'utf8') {
            return wrap(BufferImpl.from(value, encoding));
        },
        byteLength(value, encoding = 'utf8') {
            return BufferImpl.byteLength(value, encoding);
        },
    };
}

function createBindings(bindings) {
    const $substore = bindings.$substore;
    const bind = (fn) => fn.bind($substore);
    const scriptResourceCache = bindings.scriptResourceCache;
    const Buffer = createBufferBridge(bindings.ProxyUtils.Buffer);
    // The lodash export is itself a function. Treating it as a host function
    // hides its methods (`lodash.map`, `lodash.filter`, ...), while copying the
    // entire object reaches the circular `templateSettings.imports._` member.
    // Dynamic scripts use lodash as a method namespace, so expose its callable
    // and primitive members without the circular configuration objects.
    const lodash = Object.fromEntries(
        Object.entries(bindings.lodash).filter(([, value]) => {
            return (
                value === null ||
                ['function', 'string', 'number', 'boolean'].includes(
                    typeof value,
                )
            );
        }),
    );

    return {
        ...bindings,
        lodash,
        // `$substore` is the app instance, which carries the whole database
        // (`$.root`) and `$.cache`; copy only the members scripts use.
        $substore: {
            env: $substore.env,
            read: bind($substore.read),
            write: bind($substore.write),
            delete: bind($substore.delete),
            log: bind($substore.log),
            info: bind($substore.info),
            warn: bind($substore.warn),
            error: bind($substore.error),
            notify: bind($substore.notify),
        },
        ProxyUtils: {
            ...bindings.ProxyUtils,
            Buffer,
        },
        Buffer,
        atob: bindings.b64d,
        btoa: bindings.b64e,
        // Methods of a class instance live on its prototype and are not
        // enumerable, so bind them explicitly.
        scriptResourceCache: {
            get: scriptResourceCache.get.bind(scriptResourceCache),
            gettime: scriptResourceCache.gettime.bind(scriptResourceCache),
            set: scriptResourceCache.set.bind(scriptResourceCache),
            revokeAll: scriptResourceCache.revokeAll.bind(scriptResourceCache),
        },
        $persistentStore,
        $notification: {
            post: bind($substore.notify),
        },
        console: {
            log: bind($substore.log),
            info: bind($substore.info),
            warn: bind($substore.warn),
            error: bind($substore.error),
            debug: bind($substore.log),
        },
    };
}

function setGlobal(vm, name, handle) {
    try {
        vm.setProp(vm.global, name, handle);
    } finally {
        handle.dispose();
    }
}

/* --------------------------------- entry point ------------------------------ */

function unwrapQuickJSResult(vm, result) {
    if (result.error) {
        const error = vm.dump(result.error);
        result.error.dispose();
        throw new Error(formatQuickJSError(error));
    }
    return result.value;
}

async function executeQuickJSScript({ name, script, bindings }, args) {
    const runtime = await createQuickJSRuntime();
    const vm = runtime.newContext();
    let rejectFatal;
    const fatalError = new Promise((resolve, reject) => {
        rejectFatal = reject;
    });
    let active = true;
    const onFatal = (error) => {
        if (active) rejectFatal(error);
    };

    try {
        refreshDeadline(vm);
        Object.entries(createBindings(bindings)).forEach(
            ([bindingName, value]) => {
                setGlobal(
                    vm,
                    bindingName,
                    toGuestValue(
                        vm,
                        value,
                        new Set(),
                        bindingName,
                        onFatal,
                    ),
                );
            },
        );
        setGlobal(
            vm,
            '__subStoreInvocationArguments',
            toGuestValue(
                vm,
                args,
                new Set(),
                'invocation arguments',
                onFatal,
            ),
        );

        // Keep the identity check inside QuickJS. vm.dump intentionally copies
        // values and may omit the non-index metadata used to brand a Buffer.
        const bufferSetup = vm.evalCode(`
            Buffer.isBuffer = (value) =>
                value !== null &&
                typeof value === 'object' &&
                value.__subStoreBuffer === true;
            ProxyUtils.Buffer = Buffer;
        `);
        unwrapQuickJSResult(vm, bufferSetup).dispose();

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
            // `resolvePromise` only attaches `.then(resolve, reject)` to the
            // guest promise, and those callbacks run when the job queue is
            // pumped below, so this has to happen first.
            const pending = vm.resolvePromise(promiseHandle);
            refreshDeadline(vm);
            const jobs = runtime.executePendingJobs();
            if (jobs.error) {
                const error = vm.dump(jobs.error);
                jobs.error.dispose();
                throw new Error(formatQuickJSError(error));
            }

            // While the script waits on host I/O (`await produceArtifact(...)`)
            // this stays pending; the deferred bridges keep pumping the job
            // queue as they settle.
            // A failure returned by executePendingJobs is not guaranteed to
            // settle the promise observed by resolvePromise. Race it against
            // an invocation-level error channel so an async continuation can
            // never leave this call waiting forever.
            const resolved = await Promise.race([pending, fatalError]);
            if (resolved.error) {
                const error = vm.dump(resolved.error);
                resolved.error.dispose();
                throw new Error(formatQuickJSError(error));
            }
            const output = vm.dump(resolved.value);
            resolved.value.dispose();
            return output;
        } finally {
            promiseHandle.dispose();
        }
    } finally {
        active = false;
        vm.dispose();
        runtime.dispose();
    }
}

export function registerQuickJSRuntime() {
    registerDynamicFunctionFactory(({ name, script, bindings }) => {
        return (...args) =>
            executeQuickJSScript({ name, script, bindings }, args);
    });
}
