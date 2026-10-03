'use strict';

/**
 * Run all test suites in child processes, stripping inherited PE_* variables
 * (except PE_EDGE) so each suite starts from its own environment.
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const SUITES = [
  ['core', 'test/core.js'],
  ['e2e', 'test/e2e.js'],
];

function main() {
  const only = process.argv.slice(2);
  let failed = 0;
  let totalChecks = 0;
  const started = Date.now();

  for (const [name, file] of SUITES) {
    if (only.length && !only.includes(name)) continue;
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('PE_') && key !== 'PE_EDGE') delete env[key];
    }
    process.stdout.write(`\n=== ${name} ===\n`);
    const res = spawnSync(process.execPath, [path.join(__dirname, '..', file)], {
      env,
      stdio: 'inherit',
      encoding: 'utf8',
    });
    if (res.status !== 0) failed += 1;
    const m = /(\d+) passed, (\d+) failed/.exec(res.stdout || '');
    if (m) totalChecks += Number(m[1]) + Number(m[2]);
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write(`\n  run-all: ${failed === 0 ? 'ALL SUITES PASSED' : failed + ' SUITE(S) FAILED'} in ${seconds}s\n`);
  process.exit(failed ? 1 : 0);
}

main();