// Lógica pura do backfill de JourneyTrigger.repeatPolicy (Fase B, Jornadas).
//
// O fix de código (ONCE_PER_USER -> ONCE_PER_PROJECT em journey-catalog.ts)
// só afeta jornadas materializadas por um bootstrap FUTURO —
// `journey-bootstrap.service.ts` nunca atualiza uma jornada já existente
// ("never overwrites a customized journey"). As 6 linhas de
// `JourneyTrigger` do onboarding, já materializadas em produção ANTES do
// fix de código, continuam com `repeatPolicy: 'ONCE_PER_USER'` gravado —
// o fix de código sozinho é inerte até esta migração rodar.
//
// Critério "nasceu assim pelo bootstrap, admin nunca tocou": mesmo padrão
// do backfill de expense/import — `updatedAt === createdAt` na linha
// específica do trigger. Um admin que já configurou repeatPolicy de
// propósito pelo editor nunca tem essa linha sobrescrita.
export function computeRepeatPolicyBackfill(triggers) {
  return triggers
    .filter((t) => t.journeyKey.startsWith('onboarding:'))
    .filter((t) => t.repeatPolicy === 'ONCE_PER_USER')
    .filter((t) => sameInstant(t.updatedAt, t.createdAt))
    .map((t) => ({ id: t.id, journeyKey: t.journeyKey }));
}

function sameInstant(a, b) {
  const toTime = (v) => (v instanceof Date ? v.getTime() : new Date(v).getTime());
  return toTime(a) === toTime(b);
}
