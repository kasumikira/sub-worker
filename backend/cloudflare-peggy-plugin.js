const fs = require('fs');
const babel = require('@babel/core');
const peggy = require('peggy');

function findGrammar(node) {
    if (!node || typeof node !== 'object') return undefined;
    if (
        node.type === 'VariableDeclarator' &&
        node.id?.name === 'grammars' &&
        node.init?.type === 'TaggedTemplateExpression' &&
        node.init.quasi?.expressions?.length === 0
    ) {
        return node.init.quasi.quasis[0].value.raw;
    }
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
            for (const child of value) {
                const grammar = findGrammar(child);
                if (grammar !== undefined) return grammar;
            }
        } else if (value && typeof value === 'object') {
            const grammar = findGrammar(value);
            if (grammar !== undefined) return grammar;
        }
    }
    return undefined;
}

module.exports = {
    name: 'cloudflare-static-peggy',
    setup(build) {
        build.onLoad(
            {
                filter: /[\\/]parsers[\\/]peggy[\\/](qx|loon|surge)\.js$/,
            },
            async ({ path }) => {
                const source = await fs.promises.readFile(path, 'utf8');
                const ast = babel.parseSync(source, {
                    sourceType: 'module',
                    babelrc: false,
                    configFile: false,
                });
                const grammar = findGrammar(ast);
                if (grammar === undefined) {
                    throw new Error(`Unable to find Peggy grammar in ${path}`);
                }
                const parser = peggy.generate(grammar, {
                    output: 'source',
                    format: 'bare',
                });
                return {
                    contents: `const parser = ${parser};\nexport default function getParser() { return parser; }`,
                    loader: 'js',
                };
            },
        );
    },
};
