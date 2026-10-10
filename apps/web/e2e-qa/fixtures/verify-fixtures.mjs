#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../..');
const scratch = path.join(here, '.maria-csv-parser-proof');
assert(!fs.existsSync(scratch), 'Parser proof directory already exists; do not clobber another run');
fs.mkdirSync(scratch);
try {
  const config = {
    rootDir: root,
    testRegex: 'apps/web/e2e-qa/fixtures/card-invoice.spec.ts$',
    transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: path.join(root, 'apps/api/tsconfig.json') }] },
    testEnvironment: 'node',
    setupFiles: [path.join(root, 'scripts/test-db-env.cjs')],
    moduleNameMapper: { '^@reformaflow/domain(.*)$': path.join(root, 'packages/domain/src$1') },
    cacheDirectory: path.join(scratch, 'cache'),
  };
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules/jest/bin/jest.js'), '--runInBand', '--config', JSON.stringify(config)], {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, TMPDIR: scratch, TEST_DATABASE_URL: `file:${path.join(scratch, 'parser.db')}` },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
