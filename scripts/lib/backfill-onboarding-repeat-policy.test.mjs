// Self-check do backfill de repeatPolicy (Fase B, Jornadas) — roda com
// `node scripts/lib/backfill-onboarding-repeat-policy.test.mjs`.
import assert from 'node:assert/strict';
import { computeRepeatPolicyBackfill } from './backfill-onboarding-repeat-policy.mjs';

const BOOTSTRAP_TIME = new Date('2026-07-01T00:00:00Z');
const ADMIN_EDIT_TIME = new Date('2026-07-15T00:00:00Z');

function trigger(overrides) {
  return {
    id: 't1',
    journeyKey: 'onboarding:PESSOAL',
    repeatPolicy: 'ONCE_PER_USER',
    createdAt: BOOTSTRAP_TIME,
    updatedAt: BOOTSTRAP_TIME,
    ...overrides,
  };
}

// 1. Trigger de onboarding intocado, ONCE_PER_USER → candidato a virar
//    ONCE_PER_PROJECT.
{
  const updates = computeRepeatPolicyBackfill([trigger({ id: 't1' })]);
  assert.deepEqual(updates, [{ id: 't1', journeyKey: 'onboarding:PESSOAL' }]);
}

// 2. Jornada que NÃO é onboarding (ex.: um tour futuro) nunca é tocada, mesmo
//    com ONCE_PER_USER intocado.
{
  const updates = computeRepeatPolicyBackfill([
    trigger({ id: 't2', journeyKey: 'tour:feature-x' }),
  ]);
  assert.equal(updates.length, 0);
}

// 3. Já ONCE_PER_PROJECT (rodada anterior ou bootstrap novo já com o fix) →
//    idempotência, nunca reaparece.
{
  const updates = computeRepeatPolicyBackfill([
    trigger({ id: 't3', repeatPolicy: 'ONCE_PER_PROJECT' }),
  ]);
  assert.equal(updates.length, 0);
}

// 4. Admin editou o trigger de propósito (updatedAt !== createdAt) → NUNCA
//    sobrescrever, mesmo que hoje esteja ONCE_PER_USER.
{
  const updates = computeRepeatPolicyBackfill([
    trigger({ id: 't4', updatedAt: ADMIN_EDIT_TIME }),
  ]);
  assert.equal(updates.length, 0);
}

// 5. Mistura real: 6 triggers de onboarding intocados + 1 tour + 1 editado
//    pelo admin — só os 6 de onboarding saem.
{
  const updates = computeRepeatPolicyBackfill([
    trigger({ id: 'reforma', journeyKey: 'onboarding:REFORMA' }),
    trigger({ id: 'compra', journeyKey: 'onboarding:COMPRA' }),
    trigger({ id: 'casa', journeyKey: 'onboarding:CASA' }),
    trigger({ id: 'carro', journeyKey: 'onboarding:CARRO' }),
    trigger({ id: 'pessoal', journeyKey: 'onboarding:PESSOAL' }),
    trigger({ id: 'plantas', journeyKey: 'onboarding:PLANTAS' }),
    trigger({ id: 'tour', journeyKey: 'tour:feature-x' }),
    trigger({ id: 'edited', journeyKey: 'onboarding:PESSOAL', updatedAt: ADMIN_EDIT_TIME }),
  ]);
  assert.deepEqual(
    updates.map((u) => u.id).sort(),
    ['carro', 'casa', 'compra', 'pessoal', 'plantas', 'reforma'],
  );
}

console.log('backfill-onboarding-repeat-policy: 5/5 self-checks OK');
