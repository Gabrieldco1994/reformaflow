// Lógica pura do backfill de paridade `onboarding:PESSOAL` (Fase B, Jornadas):
// journey-bootstrap.service.ts materializou `expense`/`import`/`expense-import`
// TODOS `enabled: true` antes do fix em journey-catalog.ts (enabledByDefault).
// Este backfill corrige as linhas JÁ materializadas em produção.
//
// Escopo: só desliga `expense`/`import` numa jornada que TAMBÉM tem
// `expense-import` ligado — é essa combinação específica que produz a
// "3 pedidos seguidos pra lançar a mesma 1ª despesa". `expense` sozinho
// (REFORMA/COMPRA, que não têm `expense-import`) nunca é tocado.
//
// Critério "nasceu assim pelo bootstrap, admin nunca tocou": updatedAt ===
// createdAt na linha ESPECÍFICA de `expense`/`import` (Prisma @updatedAt só
// muda no PUT que a toca — journeys-admin.service.ts atualiza por stepKey,
// não a jornada inteira). Se um admin já ligou/desligou `expense` ou
// `import` de propósito pelo editor, a linha tem updatedAt !== createdAt e o
// backfill NUNCA a toca — sobrescrever uma escolha deliberada do admin seria
// pior que deixar o bug.
export const TARGET_STEP_KEYS = ['expense', 'import'];
const UNIFIED_STEP_KEY = 'expense-import';

/**
 * Recebe TODAS as linhas de `JourneyStep` de jornadas `onboarding:*`
 * (não só expense/import — precisa ver `expense-import` de cada jornada
 * para decidir o escopo) e devolve os ids que devem virar `enabled: false`.
 * Idempotente: uma linha já `enabled: false` nunca aparece no resultado, e
 * rodar duas vezes sobre o mesmo snapshot devolve `[]` na segunda.
 */
export function computeExpenseImportParityUpdates(steps) {
  const byJourney = new Map();
  for (const step of steps) {
    const list = byJourney.get(step.journeyId) ?? [];
    list.push(step);
    byJourney.set(step.journeyId, list);
  }

  const updates = [];
  for (const journeySteps of byJourney.values()) {
    const unified = journeySteps.find((s) => s.stepKey === UNIFIED_STEP_KEY);
    if (!unified?.enabled) continue; // sem expense-import ligado, nada a fazer

    for (const step of journeySteps) {
      if (!TARGET_STEP_KEYS.includes(step.stepKey)) continue;
      if (step.enabled !== true) continue;
      if (!sameInstant(step.updatedAt, step.createdAt)) continue;
      updates.push({ id: step.id, journeyId: step.journeyId, stepKey: step.stepKey });
    }
  }
  return updates;
}

function sameInstant(a, b) {
  const toTime = (v) => (v instanceof Date ? v.getTime() : new Date(v).getTime());
  return toTime(a) === toTime(b);
}

