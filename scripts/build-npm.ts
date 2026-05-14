#!/usr/bin/env -S deno run -A
/**
 * dnt-based build: transpile the Deno source to a Node-compatible npm
 * package in ./npm. Publish from there with `npm publish ./npm`.
 *
 * dnt rewrites `npm:`/`jsr:` specifiers, drops `.ts`/`.tsx` extensions,
 * shims `Deno.*` APIs (we use none currently, but the shim is kept for
 * safety), and generates a package.json from the deno.json metadata plus
 * the overrides below.
 */
import { build, emptyDir } from '@deno/dnt';

const OUT_DIR = './npm';
const VERSION = Deno.args[0]?.replace(/^v/, '') ?? '0.1.3';

await emptyDir(OUT_DIR);

await build({
  entryPoints: [
    {
      kind: 'bin',
      name: 'claude-warmer',
      path: './src/index.tsx',
    },
  ],
  outDir: OUT_DIR,
  shims: {
    deno: false,
    undici: false,
  },
  test: false,
  typeCheck: 'both',
  declaration: 'separate',
  scriptModule: false,
  esModule: true,
  compilerOptions: {
    target: 'ES2022',
    lib: ['ES2022', 'DOM'],
  },
  importMap: './deno.json',
  package: {
    name: 'claude-warmer',
    version: VERSION,
    description: 'TUI tool that keeps Claude Code session caches warm by periodically resuming sessions',
    keywords: ['claude', 'claude-code', 'cache', 'warmer', 'tui', 'ink'],
    author: 'Ryan Lyn',
    license: 'ISC',
    type: 'module',
    engines: { node: '>=20' },
    repository: {
      type: 'git',
      url: 'git+https://github.com/ryanlyn/claude-warmer.git',
    },
    homepage: 'https://github.com/ryanlyn/claude-warmer',
    bugs: {
      url: 'https://github.com/ryanlyn/claude-warmer/issues',
    },
  },
  postBuild() {
    Deno.copyFileSync('LICENSE', `${OUT_DIR}/LICENSE`);
    Deno.copyFileSync('README.md', `${OUT_DIR}/README.md`);
  },
});

console.log(`npm package built into ${OUT_DIR}`);
