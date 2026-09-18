#!/usr/bin/env node
// socialcrabs-service/scripts/build-socialcrabs.js
// ─────────────────────────────────────────────────────────────────────────────
// SocialCrabs ships TypeScript sources only — its package.json points `main` at
// dist/index.js, which the repository does not contain. So after installing it
// as a GitHub dependency, it has to be compiled once.
//
// Type errors in the library are not our problem (the upstream project compiles
// with strict flags and may drift); what matters is whether usable JavaScript
// came out. If dist/index.js exists afterwards we continue with a warning; if it
// does not, we fail loudly, because the engine would only discover the problem
// on the first action otherwise.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

let libDir;
try {
  libDir = path.dirname(require.resolve('socialcrabs/package.json'));
} catch (e) {
  fail(
    'The "socialcrabs" dependency is not installed. Run:\n' +
    '    npm install\n' +
    'from socialcrabs-service/ first (it is a GitHub dependency, so git must be available).'
  );
}

let tscBin;
try {
  tscBin = require.resolve('typescript/bin/tsc');
} catch (e) {
  fail('TypeScript is missing from node_modules — run "npm install" again.');
}

console.log(`› compiling SocialCrabs at ${libDir}`);
const run = spawnSync(process.execPath, [tscBin, '-p', libDir], { stdio: 'inherit' });

const built = path.join(libDir, 'dist', 'index.js');
if (!fs.existsSync(built)) {
  fail(
    `SocialCrabs did not compile (tsc exited ${run.status}).\n` +
    'The engine cannot work without it. Most often this is a TS version drift:\n' +
    'try "npm install typescript@latest" and run this script again.'
  );
}
if (run.status !== 0) {
  console.warn(
    '⚠  SocialCrabs produced type errors but dist/index.js was emitted — continuing.\n' +
    '   The compiled JavaScript is what the engine loads.'
  );
}
console.log(`✓ SocialCrabs compiled: ${path.relative(process.cwd(), built)}`);
