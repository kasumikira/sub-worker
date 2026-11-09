import { expect } from 'chai';
import { describe, it } from 'mocha';
import { build } from 'esbuild';
import vm from 'vm';
import cloudflareStaticPeggy from '../../../cloudflare-peggy-plugin';

async function loadParser(name) {
    const result = await build({
        entryPoints: [`src/core/proxy-utils/parsers/peggy/${name}.js`],
        bundle: true,
        write: false,
        platform: 'browser',
        format: 'iife',
        globalName: 'ParserModule',
        plugins: [cloudflareStaticPeggy],
    });
    const sandbox = {};
    vm.runInNewContext(result.outputFiles[0].text, sandbox, {
        contextCodeGeneration: { strings: false, wasm: false },
    });
    return sandbox.ParserModule.default();
}

describe('Cloudflare static Peggy parsers', function () {
    this.timeout(10000);
    it('preserves QX ALPN decoding without runtime code generation', async function () {
        const parser = await loadParser('qx');
        for (const raw of [
            '02683208687474702f312e31',
            '02:68:32:08:68:74:74:70:2f:31:2e:31',
        ]) {
            const proxy = parser.parse(
                `trojan=example.com:443,password=abc,123,over-tls=true,tls-alpn=${raw},tag=Test`,
            );
            expect(Array.from(proxy.alpn)).to.deep.equal(['h2', 'http/1.1']);
            expect(proxy['tls-alpn']).to.equal(raw);
            expect(proxy.password).to.equal('abc,123');
        }
    });
    for (const name of ['loon', 'surge']) {
        it(`keeps ${name} parsing without runtime code generation`, async function () {
            const parser = await loadParser(name);
            const input =
                name === 'loon'
                    ? 'Test = Shadowsocks,example.com,443,aes-128-gcm,"secret"'
                    : 'Test = ss,example.com,443,encrypt-method=aes-128-gcm,password=secret';
            const proxy = parser.parse(input);
            expect(proxy.type).to.equal('ss');
            expect(proxy.server).to.equal('example.com');
            expect(proxy.password).to.equal('secret');
        });
    }
});
