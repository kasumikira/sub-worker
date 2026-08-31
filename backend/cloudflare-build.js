#!/usr/bin/env node
const { build } = require('esbuild');
const objectHasOwnPolyfill = require.resolve('core-js/actual/object/has-own');
const cloudflareStaticPeggy = require('./cloudflare-peggy-plugin');

build({
    entryPoints: ['src/platforms/cloudflare/index.js'],
    bundle: true,
    minify: true,
    sourcemap: true,
    platform: 'browser',
    format: 'esm',
    outfile: 'dist/sub-store.cloudflare.js',
    inject: [
        objectHasOwnPolyfill,
        'src/platforms/cloudflare/legacy-globals.js',
    ],
    external: ['node:async_hooks'],
    loader: { '.wasm': 'copy' },
    plugins: [cloudflareStaticPeggy],
    define: {
        'globalThis.__SUB_STORE_RUNTIME__': JSON.stringify('cloudflare-worker'),
    },
    logOverride: { 'direct-eval': 'silent' },
}).catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
