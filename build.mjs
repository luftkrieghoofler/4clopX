// Bundles src/ (ES modules) into a single Greasemonkey-compatible userscript.
// The ==UserScript== banner lives in src/meta.txt and is prepended verbatim;
// its @version is injected into the code as __CLOPUS_VERSION__.
import { readFileSync } from 'node:fs';
import * as esbuild from 'esbuild';

const meta = readFileSync('src/meta.txt', 'utf8').trim();
const version = meta.match(/@version\s+(\S+)/)?.[1] ?? '0.0.0';

const options = {
    entryPoints: ['src/main.js'],
    outfile: 'dist/clop.user.js',
    bundle: true,
    format: 'iife',
    target: 'es2020',
    charset: 'utf8',
    banner: { js: meta + '\n' },
    define: { __CLOPUS_VERSION__: JSON.stringify(version) },
};

if (process.argv.includes('--watch')) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('[clop-userscript] watching src/ -> dist/clop.user.js');
} else {
    await esbuild.build(options);
    console.log(`[clop-userscript] built dist/clop.user.js (v${version})`);
}
