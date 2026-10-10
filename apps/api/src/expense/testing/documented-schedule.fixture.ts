import {
  StoredSourceScheduleV1,
  StoredProjectionScheduleV1,
} from '../documented-schedule.types';

export function sourceSchedule(): StoredSourceScheduleV1 {
  return {
    version: 1,
    kind: 'source',
    tenantId: 'synthetic-701-tenant',
    sourceExpenseId: 'synthetic-701-source',
    sourceProjectId: 'synthetic-701-pessoal',
    cardId: 'synthetic-701-card',
    importId: 'synthetic-701-import',
    externalId: 'synthetic-701-external',
    recordedByUserId: 'synthetic-701-actor',
    recordedAt: '2026-09-23T12:00:00.000Z',
    occurrences: [
      {
        index: 0,
        parcela: '2/3',
        valor: 12345,
        data: '2026-08-31',
        invoiceDueMonth: '2026-11',
        amountEvidence: null,
        cycleEvidence: {
          documentSha256: 'a'.repeat(64),
          reference: 'Synthetic statement, line 1',
          actorUserId: 'synthetic-701-actor',
          recordedAt: '2026-09-23T12:00:00.000Z',
        },
      },
    ],
    projections: [],
    lastOperation: null,
  };
}

export function projectionSchedule(): StoredProjectionScheduleV1 {
  const source = sourceSchedule();
  return {
    version: 1,
    kind: 'projection',
    tenantId: source.tenantId,
    sourceExpenseId: source.sourceExpenseId,
    sourceProjectId: source.sourceProjectId,
    cardId: source.cardId,
    recordedByUserId: source.recordedByUserId,
    recordedAt: source.recordedAt,
    via: 'rateio',
    allocationId: 'synthetic-701-allocation',
    targetExpenseId: 'synthetic-701-target',
    targetProjectId: 'synthetic-701-obra',
    occurrences: [
      {
        index: 0,
        parcela: '1/1',
        valor: 12345,
        data: '2026-08-31',
        invoiceDueMonth: '2026-11',
        sourceIndex: 0,
      },
    ],
  };
}
