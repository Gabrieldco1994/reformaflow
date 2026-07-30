// Self-check do backfill de paridade expense/import (Fase B, Jornadas) —
// roda com `node scripts/lib/backfill-onboarding-expense-import-parity.test.mjs`.
import assert from 'node:assert/strict';
import { computeExpenseImportParityUpdates } from './backfill-onboarding-expense-import-parity.mjs';

const BOOTSTRAP_TIME = new Date('2026-07-01T00:00:00Z');
const ADMIN_EDIT_TIME = new Date('2026-07-15T00:00:00Z');

function row(overrides) {
  return {
    id: 'row-1',
    journeyId: 'j1',
    stepKey: 'expense',
    enabled: true,
    createdAt: BOOTSTRAP_TIME,
    updatedAt: BOOTSTRAP_TIME,
    ...overrides,
  };
}

function unified(journeyId, overrides = {}) {
  return row({
    id: `${journeyId}-unified`,
    journeyId,
    stepKey: 'expense-import',
    ...overrides,
  });
}

// 1. Jornada COM expense-import ligado: expense/import intocados e
//    enabled:true → candidatos a virar false.
{
  const updates = computeExpenseImportParityUpdates([
    unified('jA'),
    row({ id: 'e1', journeyId: 'jA', stepKey: 'expense' }),
    row({ id: 'e2', journeyId: 'jA', stepKey: 'import' }),
  ]);
  assert.deepEqual(
    updates.map((u) => u.id).sort(),
    ['e1', 'e2'],
  );
}

// 2. Jornada SEM expense-import (REFORMA/COMPRA): `expense` sozinho NUNCA é
//    tocado, mesmo intocado e enabled:true — é o bug que o dry-run pegou.
{
  const updates = computeExpenseImportParityUpdates([
    row({ id: 'e3', journeyId: 'jB', stepKey: 'expense' }),
  ]);
  assert.equal(updates.length, 0);
}

// 3. expense-import existe mas está DESLIGADO (admin escolheu o fluxo
//    clássico) → expense/import não são tocados, mesmo intocados.
{
  const updates = computeExpenseImportParityUpdates([
    unified('jC', { enabled: false, updatedAt: ADMIN_EDIT_TIME }),
    row({ id: 'e4', journeyId: 'jC', stepKey: 'expense' }),
  ]);
  assert.equal(updates.length, 0);
}

// 4. Idempotência: linha já enabled:false não é tocada de novo (rodar duas
//    vezes não gera update na 2ª).
{
  const updates = computeExpenseImportParityUpdates([
    unified('jD'),
    row({ id: 'e5', journeyId: 'jD', stepKey: 'import', enabled: false }),
  ]);
  assert.equal(updates.length, 0);
}

// 5. Admin tocou a linha de propósito (updatedAt !== createdAt) → NUNCA
//    sobrescrever escolha deliberada, mesmo que hoje esteja enabled:true.
{
  const updates = computeExpenseImportParityUpdates([
    unified('jE'),
    row({ id: 'e6', journeyId: 'jE', stepKey: 'expense', updatedAt: ADMIN_EDIT_TIME }),
  ]);
  assert.equal(updates.length, 0);
}

// 6. stepKey fora do alvo (ex.: funding) nunca é tocado, mesmo intocado e
//    enabled:true, mesmo com expense-import ligado na jornada.
{
  const updates = computeExpenseImportParityUpdates([
    unified('jF'),
    row({ id: 'e7', journeyId: 'jF', stepKey: 'funding' }),
  ]);
  assert.equal(updates.length, 0);
}

// 7. Mistura real entre VÁRIAS jornadas (o cenário do dry-run em produção):
//    PESSOAL com expense-import ligado (2 candidatas) + REFORMA/COMPRA sem
//    expense-import (nunca tocadas) — só as 2 candidatas de PESSOAL saem.
{
  const updates = computeExpenseImportParityUpdates([
    unified('pessoal'),
    row({ id: 'p-expense', journeyId: 'pessoal', stepKey: 'expense' }),
    row({ id: 'p-import', journeyId: 'pessoal', stepKey: 'import' }),
    row({ id: 'reforma-expense', journeyId: 'reforma', stepKey: 'expense' }),
    row({ id: 'compra-expense', journeyId: 'compra', stepKey: 'expense' }),
  ]);
  assert.deepEqual(
    updates.map((u) => u.id).sort(),
    ['p-expense', 'p-import'],
  );
}

console.log('backfill-onboarding-expense-import-parity: 7/7 self-checks OK');
