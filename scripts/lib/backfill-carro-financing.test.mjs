// Self-check do backfill (issue #293) — roda com `node scripts/lib/backfill-carro-financing.test.mjs`.
import assert from 'node:assert/strict';
import { computeFinancingBackfillUpdates } from './backfill-carro-financing.mjs';

// 1. Usuário com CARRO explícito e sem financing → recebe o módulo.
{
  const updates = computeFinancingBackfillUpdates([
    { id: 'u1', allowedProjectTypes: '["CARRO"]', allowedModules: '["dashboard","expenses"]' },
  ]);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], { id: 'u1', allowedModules: ['dashboard', 'expenses', 'financing'] });
}

// 2. Idempotência: usuário que já tem financing não é tocado de novo.
{
  const updates = computeFinancingBackfillUpdates([
    { id: 'u2', allowedProjectTypes: '["CARRO"]', allowedModules: '["dashboard","financing"]' },
  ]);
  assert.equal(updates.length, 0);
}

// 3. Usuário sem CARRO explícito (outro tipo) não é tocado.
{
  const updates = computeFinancingBackfillUpdates([
    { id: 'u3', allowedProjectTypes: '["CASA"]', allowedModules: '["dashboard"]' },
  ]);
  assert.equal(updates.length, 0);
}

// 4. Legado — allowedProjectTypes vazio (sem restrição) NÃO é tocado, mesmo
//    que o usuário já use módulos de CARRO hoje (regra explícita da issue).
{
  const updates = computeFinancingBackfillUpdates([
    { id: 'u4', allowedProjectTypes: '[]', allowedModules: '["dashboard","carInfo"]' },
  ]);
  assert.equal(updates.length, 0);
}

console.log('backfill-carro-financing: 4/4 self-checks OK');
