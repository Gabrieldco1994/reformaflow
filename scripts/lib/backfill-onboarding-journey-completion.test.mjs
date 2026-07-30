// Self-check do backfill de JourneyCompletion (Fase B, item b) — roda com
// `node scripts/lib/backfill-onboarding-journey-completion.test.mjs`.
import assert from 'node:assert/strict';
import { computeJourneyCompletionBackfill } from './backfill-onboarding-journey-completion.mjs';

const ONBOARDED_AT = new Date('2026-05-01T00:00:00Z');

const journeyIdByKey = new Map([
  ['onboarding:PESSOAL', 'j-pessoal'],
  ['onboarding:REFORMA', 'j-reforma'],
]);

function project(overrides) {
  return {
    id: 'p1',
    tenantId: 't1',
    type: 'PESSOAL',
    createdByUserId: null,
    onboardedAt: ONBOARDED_AT,
    ...overrides,
  };
}

// 1. Projeto com createdByUserId presente → completionKey usa esse userId.
{
  const { creates, skipped } = computeJourneyCompletionBackfill({
    projects: [project({ id: 'p1', createdByUserId: 'u1' })],
    usersByTenantId: new Map(),
    journeyIdByKey,
    existingCompletionKeys: new Set(),
  });
  assert.equal(skipped.length, 0);
  assert.deepEqual(creates, [
    {
      journeyId: 'j-pessoal',
      tenantId: 't1',
      userId: 'u1',
      projectId: 'p1',
      completionKey: 't1:u1:p1',
      completedAt: ONBOARDED_AT,
    },
  ]);
}

// 2. Sem createdByUserId, tenant com exatamente 1 usuário → infere esse usuário.
{
  const { creates, skipped } = computeJourneyCompletionBackfill({
    projects: [project({ id: 'p2', tenantId: 't2' })],
    usersByTenantId: new Map([['t2', ['u2']]]),
    journeyIdByKey,
    existingCompletionKeys: new Set(),
  });
  assert.equal(skipped.length, 0);
  assert.equal(creates[0].userId, 'u2');
  assert.equal(creates[0].completionKey, 't2:u2:p2');
}

// 3. Sem createdByUserId, tenant com 2+ usuários → AMBÍGUO, pula (nunca adivinha).
{
  const { creates, skipped } = computeJourneyCompletionBackfill({
    projects: [project({ id: 'p3', tenantId: 't3' })],
    usersByTenantId: new Map([['t3', ['ua', 'ub']]]),
    journeyIdByKey,
    existingCompletionKeys: new Set(),
  });
  assert.equal(creates.length, 0);
  assert.deepEqual(skipped, [{ projectId: 'p3', reason: 'ambiguous-user', tenantId: 't3' }]);
}

// 4. Sem createdByUserId, tenant com 0 usuários → também ambíguo, pula.
{
  const { creates, skipped } = computeJourneyCompletionBackfill({
    projects: [project({ id: 'p4', tenantId: 't4' })],
    usersByTenantId: new Map(),
    journeyIdByKey,
    existingCompletionKeys: new Set(),
  });
  assert.equal(creates.length, 0);
  assert.equal(skipped[0].reason, 'ambiguous-user');
}

// 5. onboardedAt nulo → projeto NUNCA aparece (nem em creates, nem em skipped) —
//    esse projeto não precisa de completion nenhuma.
{
  const { creates, skipped } = computeJourneyCompletionBackfill({
    projects: [project({ id: 'p5', createdByUserId: 'u5', onboardedAt: null })],
    usersByTenantId: new Map(),
    journeyIdByKey,
    existingCompletionKeys: new Set(),
  });
  assert.equal(creates.length, 0);
  assert.equal(skipped.length, 0);
}

// 6. Journey do tipo não encontrada (catálogo incompleto/bootstrap não rodou)
//    → pula com motivo explícito, nunca lança.
{
  const { creates, skipped } = computeJourneyCompletionBackfill({
    projects: [project({ id: 'p6', createdByUserId: 'u6', type: 'PLANTAS' })],
    usersByTenantId: new Map(),
    journeyIdByKey, // não tem 'onboarding:PLANTAS'
    existingCompletionKeys: new Set(),
  });
  assert.equal(creates.length, 0);
  assert.deepEqual(skipped, [
    { projectId: 'p6', reason: 'journey-not-found', journeyKey: 'onboarding:PLANTAS' },
  ]);
}

// 7. Idempotência: completionKey já existente (rodada anterior OU conclusão
//    real via runtime) → nunca recriada, rodar duas vezes não duplica.
{
  const { creates, skipped } = computeJourneyCompletionBackfill({
    projects: [project({ id: 'p7', createdByUserId: 'u7' })],
    usersByTenantId: new Map(),
    journeyIdByKey,
    existingCompletionKeys: new Set(['j-pessoal::t1:u7:p7']),
  });
  assert.equal(creates.length, 0);
  assert.deepEqual(skipped, [{ projectId: 'p7', reason: 'already-exists', completionKey: 't1:u7:p7' }]);
}

// 8. Mistura realista: vários projetos, resultados independentes por linha.
{
  const { creates, skipped } = computeJourneyCompletionBackfill({
    projects: [
      project({ id: 'ok-1', createdByUserId: 'u1' }),
      project({ id: 'ok-2', tenantId: 't2' }), // resolve por tenant único
      project({ id: 'skip-ambiguous', tenantId: 't3' }),
      project({ id: 'skip-no-onboarding', createdByUserId: 'u9', onboardedAt: null }),
    ],
    usersByTenantId: new Map([
      ['t2', ['u2']],
      ['t3', ['ua', 'ub']],
    ]),
    journeyIdByKey,
    existingCompletionKeys: new Set(),
  });
  assert.deepEqual(
    creates.map((c) => c.projectId).sort(),
    ['ok-1', 'ok-2'],
  );
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].projectId, 'skip-ambiguous');
}

console.log('backfill-onboarding-journey-completion: 8/8 self-checks OK');
