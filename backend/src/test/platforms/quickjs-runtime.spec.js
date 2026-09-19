/**
 * Integration checks for the Cloudflare QuickJS runtime.
 *
 * The runtime imports its engine as a wasm module, so the spec bundles the
 * entry point the same way the Worker build does and evaluates the result in a
 * Node VM before exercising it.
 */
import { expect } from 'chai';
import { describe, it, before } from 'mocha';
import { build } from 'esbuild';
import { Buffer as NodeBuffer } from 'buffer';
import path from 'path';
import vm from 'vm';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';

const BACKEND_ROOT = path.resolve(__dirname, '../../..');
const WASM_PATH = require.resolve('@jitl/quickjs-wasmfile-release-sync/wasm');

const ENTRY = `
import { registerQuickJSRuntime } from '@/platforms/cloudflare/quickjs-runtime';
import { getDynamicFunctionFactory } from '@/utils/dynamic-function-runtime';

registerQuickJSRuntime();

export function runDynamicFunction(name, script, bindings, args) {
    const factory = getDynamicFunctionFactory();
    return factory({ name, script, bindings })(...(args || []));
}
`;

// The Worker build hands QuickJS a compiled wasm module (wrangler turns
// `import x from './x.wasm'` into a WebAssembly.Module). It must be compiled:
// quickjs-emscripten's instantiateWasm hook reads `.exports` off the result of
// WebAssembly.instantiate, which only works for an already-compiled Module.
const quickjsWasmModulePlugin = {
    name: 'quickjs-wasm-module',
    setup(build) {
        build.onResolve(
            { filter: /quickjs-wasmfile-release-sync\/wasm$/ },
            () => ({ path: WASM_PATH, namespace: 'quickjs-wasm-module' }),
        );
        build.onLoad(
            { filter: /.*/, namespace: 'quickjs-wasm-module' },
            () => ({
                contents: `module.exports = new WebAssembly.Module(require('fs').readFileSync(${JSON.stringify(
                    WASM_PATH,
                )}));`,
                loader: 'js',
            }),
        );
    },
};

function loadBundle(code) {
    const module_ = { exports: {} };
    const require_ = createRequire(
        path.join(BACKEND_ROOT, 'src/test/platforms/quickjs-runtime.spec.js'),
    );
    const run = vm.compileFunction(
        code,
        ['require', 'module', 'exports', '__filename', '__dirname'],
        {
            filename: 'quickjs-runtime.bundle.cjs',
            // The bundled Emscripten wrapper lazily imports `node:module`.
            importModuleDynamically:
                vm.constants?.USE_MAIN_CONTEXT_DEFAULT_LOADER,
        },
    );
    run(require_, module_, module_.exports, __filename, __dirname);
    return module_.exports;
}

class FakeSubStore {
    constructor() {
        this.env = { isNode: false };
        this.state = {};
        // Stands in for `$.root`: the real app object carries the whole
        // database, which must never be copied into the guest.
        this.root = { huge: 'x'.repeat(1024) };
    }

    read(key) {
        return key in this.state ? this.state[key] : null;
    }

    write(value, key) {
        this.state[key] = value;
        return true;
    }

    delete(key) {
        delete this.state[key];
        return true;
    }

    log() {}
    info() {}
    warn() {}
    error() {}
    notify() {}
}

// Methods live on the prototype, like the real `new ResourceCache()`.
class FakeScriptCache {
    constructor() {
        this.entries = {};
        this.ttl = 123;
    }

    get(id) {
        return this.entries[id] ?? null;
    }

    set(id, value) {
        this.entries[id] = value;
    }

    gettime() {
        return this.ttl;
    }

    revokeAll() {
        this.entries = {};
    }
}

function createBindings(overrides = {}) {
    const substore = new FakeSubStore();
    const scriptCache = new FakeScriptCache();
    return {
        bindings: {
            $arguments: {},
            $options: {},
            $substore: substore,
            lodash: {
                chunk: (value) => `chunked:${JSON.stringify(value)}`,
            },
            ProxyUtils: {
                parse: () => 'parsed',
                yaml: {
                    safeDump: (value) => `yaml:${JSON.stringify(value)}`,
                    safeLoad: () => ({ loaded: true }),
                },
                Base64: {
                    decode: (value) => `b64d:${value}`,
                    encode: (value) => `b64e:${value}`,
                },
                age: {
                    label: 'aged',
                    format() {
                        return `${this.label}:formatted`;
                    },
                },
                Buffer: NodeBuffer,
            },
            yaml: { safeDump: (value) => `top-yaml:${JSON.stringify(value)}` },
            b64d: (value) => NodeBuffer.from(value, 'base64').toString('utf8'),
            b64e: (value) => NodeBuffer.from(value, 'utf8').toString('base64'),
            DOMAIN_RESOLVERS: { cloudflare: () => '1.1.1.1' },
            scriptResourceCache: scriptCache,
            // Plain object, like the real `flowUtils` in createDynamicFunction.
            flowUtils: {
                prefix: 'flow',
                getFlowField() {
                    return `${this.prefix}-field`;
                },
            },
            produceArtifact: async (options) => ({
                type: options.type,
                name: options.name,
            }),
            ...overrides,
        },
        substore,
        scriptCache,
    };
}

async function expectRejection(promise, pattern) {
    try {
        await promise;
    } catch (error) {
        expect(`${error?.message ?? error}`).to.match(pattern);
        return;
    }
    throw new Error('expected the dynamic function to reject');
}

describe('Cloudflare QuickJS runtime', function () {
    this.timeout(60000);

    let run;

    before(async function () {
        const result = await build({
            stdin: {
                contents: ENTRY,
                resolveDir: BACKEND_ROOT,
                sourcefile: 'quickjs-runtime-test-entry.js',
                loader: 'js',
            },
            bundle: true,
            write: false,
            platform: 'node',
            format: 'cjs',
            target: 'node20',
            logLevel: 'silent',
            // Emscripten's Node wrapper resolves `createRequire(import.meta.url)`;
            // the bundle is evaluated in-memory, so supply a real file URL.
            define: {
                'import.meta.url': JSON.stringify(
                    pathToFileURL(
                        path.join(
                            BACKEND_ROOT,
                            'src/platforms/cloudflare/quickjs-runtime.js',
                        ),
                    ).href,
                ),
            },
            plugins: [quickjsWasmModulePlugin],
        });
        ({ runDynamicFunction: run } = loadBundle(result.outputFiles[0].text));
    });

    it('runs a plain synchronous operator', async function () {
        const { bindings } = createBindings();
        const output = await run(
            'operator',
            `function operator(input) {
                return input.map((proxy) => proxy.name);
            }`,
            bindings,
            [[{ name: 'alpha' }, { name: 'beta' }]],
        );
        expect(output).to.deep.equal(['alpha', 'beta']);
    });

    it('exposes nested host objects and keeps `this` for their methods', async function () {
        const { bindings } = createBindings();
        const output = await run(
            'operator',
            `function operator() {
                return {
                    nested: ProxyUtils.yaml.safeDump({ a: 1 }),
                    top: yaml.safeDump({ b: 2 }),
                    base64: ProxyUtils.Base64.decode('payload'),
                    age: ProxyUtils.age.format(),
                    lodash: lodash.chunk([1, 2]),
                    flow: flowUtils.getFlowField(),
                    env: $substore.env.isNode,
                };
            }`,
            bindings,
        );
        expect(output).to.deep.equal({
            nested: 'yaml:{"a":1}',
            top: 'top-yaml:{"b":2}',
            base64: 'b64d:payload',
            age: 'aged:formatted',
            lodash: 'chunked:[1,2]',
            flow: 'flow-field',
            env: false,
        });
    });

    it('keeps `this` for picked members of the app object', async function () {
        const { bindings, substore, scriptCache } = createBindings();
        const output = await run(
            'operator',
            `function operator() {
                $substore.write('hello', 'greeting');
                scriptResourceCache.set('cache-key', 'cache-value');
                return {
                    stored: $substore.read('greeting'),
                    cached: scriptResourceCache.get('cache-key'),
                    ttl: scriptResourceCache.gettime(),
                    hasRoot: typeof $substore.root,
                };
            }`,
            bindings,
        );
        expect(output).to.deep.equal({
            stored: 'hello',
            cached: 'cache-value',
            ttl: 123,
            hasRoot: 'undefined',
        });
        expect(substore.state.greeting).to.equal('hello');
        expect(scriptCache.entries['cache-key']).to.equal('cache-value');
    });

    it('passes guest callbacks to synchronous host APIs', async function () {
        const { bindings } = createBindings({
            lodash: {
                map: (values, iteratee) => values.map(iteratee),
                filter: (values, predicate) => values.filter(predicate),
            },
        });
        const output = await run(
            'operator',
            `function operator() {
                const values = [{ n: 1 }, { n: 2 }, { n: 3 }];
                return lodash.map(
                    lodash.filter(values, (item) => item.n > 1),
                    (item) => item.n * 10,
                );
            }`,
            bindings,
        );
        expect(output).to.deep.equal([20, 30]);
    });

    it('hands arrays to the script as arrays', async function () {
        const { bindings } = createBindings({
            $arguments: { list: ['a', 'b'], nested: { inner: [1, 2] } },
        });
        const output = await run(
            'operator',
            `function operator() {
                return {
                    list: Array.isArray($arguments.list),
                    mapped: $arguments.list.map((x) => x.toUpperCase()),
                    spread: [...$arguments.list].join('|'),
                    nested: Array.isArray($arguments.nested.inner),
                };
            }`,
            bindings,
        );
        expect(output).to.deep.equal({
            list: true,
            mapped: ['A', 'B'],
            spread: 'a|b',
            nested: true,
        });
    });

    it('exposes Buffer, atob, and btoa', async function () {
        const { bindings } = createBindings();
        const output = await run(
            'operator',
            `function operator() {
                return {
                    encoded: btoa('hello'),
                    decoded: atob('aGVsbG8='),
                    buffer: Buffer.from('aGVsbG8=', 'base64').toString('utf8'),
                    isBuffer: Buffer.isBuffer(Buffer.from('hello')),
                    length: Buffer.from('hello').length,
                    firstByte: Buffer.from('hello')[0],
                    sliced: Buffer.from('hello').slice(1, 4).toString(),
                    copied: Buffer.from(Buffer.from('hello')).toString(),
                    bytes: Buffer.from([65, 66, 67]).toString(),
                    byteLength: Buffer.byteLength('你好'),
                    viaProxyUtils: ProxyUtils.Buffer.from('hello').toString('base64'),
                };
            }`,
            bindings,
        );
        expect(output).to.deep.equal({
            encoded: 'aGVsbG8=',
            decoded: 'hello',
            buffer: 'hello',
            isBuffer: true,
            length: 5,
            firstByte: 104,
            sliced: 'ell',
            copied: 'hello',
            bytes: 'ABC',
            byteLength: 6,
            viaProxyUtils: 'aGVsbG8=',
        });
    });

    it('reports globals the Worker runtime does not provide', async function () {
        const { bindings } = createBindings();
        await expectRejection(
            run(
                'operator',
                `function operator() {
                    return $httpClient.get({ url: 'https://example.com' });
                }`,
                bindings,
            ),
            /'\$httpClient' is not defined/,
        );
    });

    it('awaits a promise returned by a host function', async function () {
        const { bindings } = createBindings();
        const output = await run(
            'operator',
            `async function operator() {
                const artifact = await produceArtifact({
                    type: 'sub',
                    name: 'demo',
                });
                return artifact.name + '/' + artifact.type;
            }`,
            bindings,
        );
        expect(output).to.equal('demo/sub');
    });

    it('surfaces a rejection from a host function', async function () {
        const { bindings } = createBindings({
            produceArtifact: async () => {
                throw new Error('host exploded');
            },
        });
        await expectRejection(
            run(
                'operator',
                `async function operator() {
                    return produceArtifact({ type: 'sub', name: 'demo' });
                }`,
                bindings,
            ),
            /host exploded/,
        );
    });

    it('runs both sides of a host round-trip in one script', async function () {
        const { bindings } = createBindings();
        const output = await run(
            'operator',
            `async function operator(input = []) {
                $substore.write(input.length, 'count');
                const artifact = await produceArtifact({
                    type: 'sub',
                    name: 'demo',
                });
                return $substore.read('count') + '-' + artifact.name;
            }`,
            bindings,
            [[{ name: 'alpha' }, { name: 'beta' }]],
        );
        expect(output).to.equal('2-demo');
    });

    it('isolates a nested dynamic script in its own runtime', async function () {
        const inner = createBindings();
        const outer = createBindings({
            produceArtifact: async () =>
                run(
                    'operator',
                    `async function operator() {
                        await Promise.resolve();
                        return 'inner';
                    }`,
                    inner.bindings,
                ),
        });
        const output = await run(
            'operator',
            `async function operator() {
                const nested = await produceArtifact({
                    type: 'sub',
                    name: 'demo',
                });
                await Promise.resolve();
                return 'outer/' + nested;
            }`,
            outer.bindings,
        );
        expect(output).to.equal('outer/inner');
    });

    it('reports script errors with their original message', async function () {
        const { bindings } = createBindings();
        await expectRejection(
            run(
                'operator',
                `function operator() { throw new Error('boom'); }`,
                bindings,
            ),
            /boom/,
        );
    });

    it('rejects host objects whose type would otherwise be lost', async function () {
        const { bindings } = createBindings({
            produceArtifact: async () => new Map([['answer', 42]]),
        });
        await expectRejection(
            run(
                'operator',
                `async function operator() {
                    return produceArtifact({ type: 'sub', name: 'demo' });
                }`,
                bindings,
            ),
            /Cannot copy host Map value/,
        );
    });

    it('reports a host value QuickJS cannot represent', async function () {
        const cyclic = {};
        cyclic.self = cyclic;
        const { bindings } = createBindings({
            produceArtifact: async () => cyclic,
        });
        await expectRejection(
            run(
                'operator',
                `async function operator() {
                    return produceArtifact({ type: 'sub', name: 'demo' });
                }`,
                bindings,
            ),
            /circular host value/,
        );
    });

    it('requires the dynamic function to be defined', async function () {
        const { bindings } = createBindings();
        await expectRejection(
            run('operator', `function somethingElse() {}`, bindings),
            /Dynamic script must define function operator/,
        );
    });
});
