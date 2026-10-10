#!/usr/bin/env node
/** Self-contained synthetic DB tests; scratch files stay under this fixture directory and are removed. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../..');
const scratch = path.join(here, '.maria-csv-assert-selftest');
assert(!fs.existsSync(scratch), 'Selftest directory already exists; do not clobber another run');
fs.mkdirSync(scratch);
const db = path.join(scratch, 'assert.db');
const vault = path.join(scratch, 'vault');
fs.mkdirSync(vault);
const expected = JSON.parse(fs.readFileSync(path.join(here, 'expected.json'), 'utf8'));
const bytes = fs.readFileSync(path.join(here, 'card-invoice.csv'));
const env = { ...process.env, TMPDIR: scratch, RUNNER_TEMP: scratch, TEST_DATABASE_URL: `file:${db}` };
process.env.TEST_DATABASE_URL = env.TEST_DATABASE_URL;
createRequire(import.meta.url)(path.join(root, 'scripts/test-db-env.cjs'));
const sqlText = value => value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
function sql(statement) {
  const result = spawnSync('sqlite3', ['-json', db], { input: statement, encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout || '[]');
}
function insert(table, values) {
  for (const column of sql(`PRAGMA table_info(${table});`)) {
    if (column.notnull && column.dflt_value === null && !(column.name in values)) {
      values[column.name] = /INT|REAL|NUMERIC/.test(column.type) ? 1 : 'synthetic';
    }
  }
  sql(`PRAGMA foreign_keys=ON; INSERT INTO ${table} (${Object.keys(values).join(',')}) VALUES (${Object.values(values).map(sqlText).join(',')});`);
}
let cases = 0;
function check(phase, shouldPass = true, extra = [], message = '') {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/qa/maria-csv-assert.mjs'), phase,
    '--db', db, ...(extra.includes('--purge-wait-ms') ? [] : ['--purge-wait-ms', '0']), ...extra], { encoding: 'utf8', env });
  assert.equal(result.status, shouldPass ? 0 : 1, `${phase}: ${result.stdout}\n${result.stderr}`);
  if (message) assert(result.stderr.includes(message), result.stderr);
  cases++;
  return shouldPass ? JSON.parse(result.stdout) : null;
}
try {
  const migrations = fs.readdirSync(path.join(root, 'prisma/migrations')).sort()
    .map(name => path.join(root, 'prisma/migrations', name, 'migration.sql')).filter(file => fs.existsSync(file));
  for (const migration of migrations) sql(`PRAGMA foreign_keys=ON; BEGIN;
${fs.readFileSync(migration, 'utf8')}
COMMIT;`);
  const start = Date.now() - 1000;
  insert('tenants', { id: 'qa-tenant', name: 'Synthetic QA', updated_at: start });
  insert('users', { id: 'qa-user', tenant_id: 'qa-tenant', name: 'Synthetic QA', email: 'maria-qa@example.invalid', updated_at: start });
  insert('projects', { id: 'qa-project', tenant_id: 'qa-tenant', name: 'Synthetic QA', type: 'PESSOAL', updated_at: start });
  insert('credit_cards', { id: 'qa-card', project_id: 'qa-project', tenant_id: 'qa-tenant', institution: 'OUTROS', nickname: 'Synthetic QA', last4: '0000', updated_at: start });
  const draft = { version: 1, lines: [], selectedLineIds: [], questions: [], scope: { observationIds: [], pendingAttachmentIds: [] } };
  insert('import_sessions', { id: 'qa-session', tenant_id: 'qa-tenant', owner_user_id: 'qa-user', owner_project_id: 'qa-project', card_id: 'qa-card',
    kind: 'CREATE_CARD_PURCHASES', state: 'DRAFT', revision: 1, create_request_id: 'qa-request', create_payload_hash: 'a'.repeat(64),
    consent_policy_version: 1, consented_at: start, created_at: start, updated_at: start, last_user_edit_at: start,
    expires_at: Date.now() + 3600000, draft_json: JSON.stringify(draft) });
  insert('import_artifacts', { id: 'qa-artifact', tenant_id: 'qa-tenant', owner_project_id: 'qa-project',
    document_sha256: createHash('sha256').update(bytes).digest('hex'), verified_bytes: bytes.length, detected_format: 'CSV',
    state: 'EXTRACTED', storage_key: 'original.csv', parser_version: 'card-local-text-v1', updated_at: start });
  insert('import_session_artifacts', { id: 'qa-original', tenant_id: 'qa-tenant', owner_project_id: 'qa-project', session_id: 'qa-session',
    artifact_id: 'qa-artifact', position: 0, file_name: 'card-invoice.csv', declared_mime: 'text/csv', declared_bytes: bytes.length,
    state: 'ATTACHED', verified_at: start, reserved_bytes: 0, updated_at: start });
  insert('import_session_artifacts', { id: 'qa-copy', tenant_id: 'qa-tenant', owner_project_id: 'qa-project', session_id: 'qa-session',
    position: 1, file_name: 'document', declared_mime: 'text/csv', declared_bytes: bytes.length,
    state: 'RELEASED', released_at: start, reserved_bytes: 0, updated_at: start });
  fs.writeFileSync(path.join(vault, 'original.csv'), bytes);
  check('pre-confirm', true, ['--vault', vault]);
  check('fk');
  fs.writeFileSync(path.join(vault, 'duplicate.csv'), bytes);
  check('pre-confirm', false, ['--vault', vault], 'duplicate raw bytes');
  fs.unlinkSync(path.join(vault, 'duplicate.csv'));
  sql(`UPDATE import_session_artifacts SET state='RESERVED' WHERE id='qa-copy';`);
  check('pre-confirm', false, [], 'RELEASED');
  sql(`UPDATE import_session_artifacts SET state='RELEASED' WHERE id='qa-copy';`);
  draft.scope.pendingAttachmentIds.push('qa-copy');
  sql(`UPDATE import_sessions SET draft_json=${sqlText(JSON.stringify(draft))};`);
  check('pre-confirm', false, [], 'pendingAttachmentIds');
  draft.scope.pendingAttachmentIds = [];
  sql(`UPDATE import_sessions SET draft_json=${sqlText(JSON.stringify(draft))};`);
  const selected = expected.purchases.slice(0, 2);
  for (const [index, purchase] of selected.entries()) {
    insert('expenses', { id: `qa-expense-${index}`, tenant_id: 'qa-tenant', project_id: 'qa-project', created_by_user_id: 'qa-user',
      tipo_despesa: 'OUTROS', titulo: purchase.title, valor: purchase.amountCents, valor_total: purchase.amountCents,
      forma_pagamento: 'A_VISTA', created_at: start + 1, updated_at: start + 1 });
    insert('cash_flow_entries', { id: `qa-cash-${index}`, tenant_id: 'qa-tenant', project_id: 'qa-project', expense_id: `qa-expense-${index}`,
      valor: purchase.amountCents, tipo: 'DESPESA', data: start + 1, categoria: 'OUTROS', status: 'PLANEJADO',
      created_at: start + 1, updated_at: start + 1 });
  }
  check('pre-confirm', false, [], 'created financial expenses');
  const receipt = { version: 1, sessionId: 'qa-session', continuationSessionId: null,
    items: selected.map((purchase, index) => ({ lineId: `qa-line-${index}`, outcome: 'CREATED', sourceExpenseId: `qa-expense-${index}`,
      targetExpenseIds: [], cashFlowEntryIds: [`qa-cash-${index}`] })),
    snapshot: { bankCashDeltaCents: 0, createdEconomicTotalCents: selected.reduce((sum, purchase) => sum + purchase.amountCents, 0),
      lines: selected.map((purchase, index) => ({ lineId: `qa-line-${index}`, titulo: purchase.title, totalCents: purchase.amountCents })) } };
  for (const [index] of selected.entries()) {
    insert('import_observations', { id: `qa-observation-${index}`, tenant_id: 'qa-tenant', owner_project_id: 'qa-project',
      artifact_id: 'qa-artifact', reference: `csv:record:${index+2}`, evidence_json: '{}', canonical_project_id: 'qa-project',
      canonical_expense_id: `qa-expense-${index}`, canonical_index: 0, claim_session_id: 'qa-session',
      claim_receipt_json: JSON.stringify(receipt), claimed_at: start+1 });
  }
  sql(`UPDATE import_sessions SET state='APPLIED',receipt_json=${sqlText(JSON.stringify(receipt))},financial_request_id='qa-confirm',confirmed_revision=1,confirmed_session_version=1,proposal_hash=${sqlText('c'.repeat(64))},confirmed_at=${start+1},closed_at=${start+1};
    UPDATE import_session_artifacts SET state='RELEASED',released_at=${start},file_name='document';`);
  check('post-confirm', true, ['--selected-count', '2']);
  check('post-confirm', false, [], 'selection count mismatch');
  check('post-confirm', true, ['--selected-ids', 'qa-line-0,qa-line-1']);
  check('post-confirm', false, ['--selected-ids', 'wrong-0,wrong-1'], 'line IDs differ');
  check('post-confirm', false, ['--selected-count', '2', '--vault', vault], 'Unreferenced raw CSV');
  const purger = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    const { spawnSync } = require('node:child_process');
    setTimeout(() => {
      fs.unlinkSync(process.argv[1]);
      const result = spawnSync('sqlite3', [process.argv[2], "UPDATE import_artifacts SET storage_key=NULL,state='PURGED';"]);
      process.exitCode = result.status ?? 1;
    }, 150);
  `, path.join(vault, 'original.csv'), db], { env, stdio: 'inherit' });
  const purged = new Promise((resolve, reject) => {
    purger.once('error', reject);
    purger.once('exit', code => code === 0 ? resolve() : reject(new Error(`Synthetic purger exited ${code}`)));
  });
  try {
    check('post-confirm', true, ['--selected-count', '2', '--vault', vault, '--purge-wait-ms', '2000']);
    await purged;
  } finally {
    if (purger.exitCode === null) purger.kill();
  }
  // A continuation's unexpired live reference is legitimate retention, not a purge failure.
  insert('import_sessions', { id: 'qa-successor', tenant_id: 'qa-tenant', owner_user_id: 'qa-user', owner_project_id: 'qa-project', card_id: 'qa-card',
    kind: 'CREATE_CARD_PURCHASES', state: 'DRAFT', revision: 1, create_request_id: 'qa-successor-request', create_payload_hash: 'b'.repeat(64),
    consented_at: start, created_at: start, updated_at: start, last_user_edit_at: start,
    expires_at: Date.now() + 3600000, draft_json: JSON.stringify(draft) });
  sql(`UPDATE import_artifacts SET storage_key='original.csv',state='RAW_READY';`);
  sql(`PRAGMA foreign_keys=ON; UPDATE import_session_artifacts SET session_id='qa-successor',state='ATTACHED' WHERE id='qa-original';`);
  receipt.continuationSessionId = 'qa-successor';
  sql(`UPDATE import_sessions SET receipt_json=${sqlText(JSON.stringify(receipt))} WHERE id='qa-session';
    UPDATE import_artifacts SET storage_key='original.csv',state='EXTRACTED';`);
  fs.writeFileSync(path.join(vault, 'original.csv'), bytes);
  const retained = check('post-confirm', true, ['--selected-count', '2', '--vault', vault]);
  assert.deepEqual(retained.vault.retainedByLiveSessionIds, ['qa-successor']);
  sql(`UPDATE import_sessions SET expires_at=0 WHERE id='qa-successor';`);
  check('post-confirm', false, ['--selected-count', '2', '--vault', vault], 'Unauthorized/expired');
  sql(`UPDATE expenses SET valor_total=valor_total+1 WHERE id='qa-expense-0';`);
  check('post-confirm', false, ['--selected-count', '2'], 'amount differs');
  sql(`UPDATE expenses SET valor_total=valor_total-1 WHERE id='qa-expense-0';`);
  insert('expenses', { id: 'qa-extra-expense', tenant_id: 'qa-tenant', project_id: 'qa-project', created_by_user_id: 'qa-user',
    tipo_despesa: 'OUTROS', titulo: selected[0].title, valor: selected[0].amountCents, valor_total: selected[0].amountCents,
    forma_pagamento: 'A_VISTA', created_at: start + 1, updated_at: start + 1 });
  check('post-confirm', false, ['--selected-count', '2'], 'expense count');
  sql(`DELETE FROM expenses WHERE id='qa-extra-expense';`);
  sql(`UPDATE expenses SET tenant_id='nonexistent' WHERE id='qa-expense-0';`);
  check('fk', false, [], 'Foreign key violations');
  const forbidden = spawnSync(process.execPath, [path.join(root, 'scripts/qa/maria-csv-assert.mjs'), 'fk', '--db', path.join(scratch, 'dev.db')],
    { encoding: 'utf8', env });
  assert.equal(forbidden.status, 1); assert(forbidden.stderr.includes('Refusing dev.db')); cases++;
  const escapeLink = path.join(scratch, 'escape.db');
  fs.symlinkSync(path.join(here, 'expected.json'), escapeLink);
  const escaped = spawnSync(process.execPath, [path.join(root, 'scripts/qa/maria-csv-assert.mjs'), 'fk', '--db', escapeLink], { encoding: 'utf8', env });
  assert.equal(escaped.status, 1); assert(escaped.stderr.includes('symlink resolution')); cases++;
  console.log(`PASS: ${cases} synthetic database/vault/safety assertion cases; ${migrations.length} real migrations applied.`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
