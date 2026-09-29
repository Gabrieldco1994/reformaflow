import { MODULE_METADATA } from '@nestjs/common/constants';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { firstValueFrom, of } from 'rxjs';
import { AppModule } from '../app.module';
import { FinancialScheduleResponseInterceptor } from '../common/interceptors/financial-schedule-response.interceptor';
import {
  parseStoredExpenseSchedule,
  parseDocumentaryCycle,
  serializeFinancialScheduleResponse,
  toPublicExpenseSchedule,
} from './documented-schedule';
import {
  projectionSchedule,
  sourceSchedule,
} from './testing/documented-schedule.fixture';

describe('documented schedule privacy boundary', () => {
  const publicSource = {
    version: 1,
    occurrences: [
      {
        index: 0,
        parcela: '2/3',
        valor: 12345,
        data: '2026-08-31',
        invoiceDueMonth: '2026-11',
      },
    ],
  };

  it('registers the sanitizer globally, not only on expense detail', () => {
    expect(
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AppModule),
    ).toContainEqual({
      provide: APP_INTERCEPTOR,
      useClass: FinancialScheduleResponseInterceptor,
    });
  });

  it('serializes recursive arrays/nested responses without mutating private provenance', async () => {
    const date = new Date('2026-08-31');
    const raw = JSON.stringify(sourceSchedule());
    const response = {
      items: [
        {
          id: 'source',
          documentedSchedule: raw,
          createdAt: date,
          schedule: { unsafe: true },
        },
        { id: 'legacy', documentedSchedule: null },
        {
          target: { documentedSchedule: JSON.stringify(projectionSchedule()) },
          plannedDocumentedSchedule: raw,
        },
      ],
      plannedDocumentedSchedule: raw,
    };
    const result = await firstValueFrom(
      new FinancialScheduleResponseInterceptor().intercept(
        new ExecutionContextHost([]),
        { handle: () => of(response) },
      ),
    );
    expect(result).toEqual({
      items: [
        { id: 'source', schedule: publicSource, createdAt: date },
        { id: 'legacy', schedule: null },
        {
          target: {
            schedule: {
              version: 1,
              occurrences: [{ ...publicSource.occurrences[0], parcela: '1/1' }],
            },
          },
        },
      ],
    });
    expect(serializeFinancialScheduleResponse(date)).toBe(date);
    const bytes = Buffer.from('file response');
    expect(serializeFinancialScheduleResponse(bytes)).toBe(bytes);
    expect(response.items[0]?.documentedSchedule).toBe(raw);
    expect(response.plannedDocumentedSchedule).toBe(raw);
    const serialized = JSON.stringify(result);
    for (const privateField of [
      'documentedSchedule',
      'plannedDocumentedSchedule',
      'amountEvidence',
      'cycleEvidence',
      'sourceExpenseId',
      'sourceProjectId',
      'allocationId',
      'cardId',
      'actorUserId',
      'recordedByUserId',
      'recordedAt',
      'sourceIndex',
      'documentSha256',
      'reference',
      'kind',
    ])
      expect(serialized).not.toContain(privateField);
  });

  it('does not change a never-rateada/redacted response or manufacture schedule:null', () => {
    const neverRateada = {
      sourceExpenseId: 'asked',
      allocations: [],
      rateadoCents: 0,
    };
    expect(
      JSON.stringify(serializeFinancialScheduleResponse(neverRateada)),
    ).toBe(JSON.stringify(neverRateada));
    expect(
      serializeFinancialScheduleResponse({
        plannedDocumentedSchedule: 'not public',
      }),
    ).toEqual({});
  });

  it.each([
    '',
    'not-json-secret',
    'null',
    '[]',
    '{"version":99,"private":"secret"}',
    JSON.stringify({ ...sourceSchedule(), actorUserId: 'extra-private' }),
    JSON.stringify({ ...sourceSchedule(), recordedAt: 'not-a-date' }),
    JSON.stringify({
      ...sourceSchedule(),
      occurrences: [
        {
          ...sourceSchedule().occurrences[0],
          cycleEvidence: null,
        },
      ],
    }),
    JSON.stringify({
      ...sourceSchedule(),
      occurrences: [
        {
          ...sourceSchedule().occurrences[0],
          cycleEvidence: {
            ...sourceSchedule().occurrences[0].cycleEvidence,
            documentSha256: 'private-invalid-hash',
          },
        },
      ],
    }),
    JSON.stringify({
      ...projectionSchedule(),
      occurrences: [
        {
          ...projectionSchedule().occurrences[0],
          amountEvidence: null,
        },
      ],
    }),
    JSON.stringify({
      ...projectionSchedule(),
      via: 'mirror',
      allocationId: 'not-null',
    }),
    JSON.stringify({ ...sourceSchedule(), lastOperation: {} }),
    JSON.stringify({
      ...sourceSchedule(),
      projections: [
        {
          kind: 'rateio',
          targetExpenseId: 'target',
          allocationId: 'allocation',
          occurrenceMap: [{ sourceIndex: 1, targetIndex: 0 }],
        },
      ],
    }),
  ])(
    'fails closed on malformed private JSON with one sanitized error (%#)',
    async (raw) => {
      expect(() => parseStoredExpenseSchedule(raw)).toThrow(
        new RangeError('Invalid documented expense schedule'),
      );
      await expect(
        firstValueFrom(
          new FinancialScheduleResponseInterceptor().intercept(
            new ExecutionContextHost([]),
            { handle: () => of({ nested: [{ documentedSchedule: raw }] }) },
          ),
        ),
      ).rejects.toThrow('Invalid documented expense schedule');
    },
  );

  it('roundtrips exact source/projection schemas, receipts and derivation maps', () => {
    const source = sourceSchedule();
    source.projections = [
      {
        kind: 'mirror',
        targetExpenseId: 'mirror',
        occurrenceMap: [{ sourceIndex: 0, targetIndex: 0 }],
      },
      {
        kind: 'rateio',
        allocationId: 'allocation',
        targetExpenseId: 'target',
        occurrenceMap: [{ sourceIndex: 0, targetIndex: 0 }],
      },
    ];
    source.lastOperation = {
      requestId: 'request',
      payloadHash: 'b'.repeat(64),
      resultingStateHash: 'c'.repeat(64),
      actorUserId: 'actor',
      recordedAt: source.recordedAt,
    };
    expect(parseStoredExpenseSchedule(JSON.stringify(source))).toEqual(source);
    const projection = projectionSchedule();
    expect(parseStoredExpenseSchedule(JSON.stringify(projection))).toEqual(
      projection,
    );
    expect(toPublicExpenseSchedule(source)).toEqual(publicSource);
    expect(toPublicExpenseSchedule(null)).toBeNull();
    expect(parseStoredExpenseSchedule(undefined)).toBeNull();
  });

  it('preserves absent/document semantics and private attestation on V1 without promoting provenance', () => {
    const original = sourceSchedule();
    const raw = JSON.stringify(original);
    expect(parseStoredExpenseSchedule(raw)).toEqual(original);
    expect(JSON.stringify(parseStoredExpenseSchedule(raw))).not.toContain(
      'evidenceKind',
    );
    const oldProof = original.occurrences[0].cycleEvidence!;
    const document = { ...oldProof, evidenceKind: 'document' };
    const attestation = {
      ...oldProof,
      evidenceKind: 'user-attestation',
      attestedByUserId: 'synthetic-attester',
      attestedAt: oldProof.recordedAt,
    };
    for (const proof of [document, attestation]) {
      const value = {
        ...original,
        occurrences: [{ ...original.occurrences[0], cycleEvidence: proof }],
      };
      const stored = parseStoredExpenseSchedule(JSON.stringify(value));
      expect(stored).toEqual(value);
      expect(toPublicExpenseSchedule(stored)).toEqual(publicSource);
    }
    for (const proof of [
      { ...attestation, attestedAt: '2999-01-01T00:00:00.000Z' },
      { ...attestation, evidenceKind: 'document' },
      { ...attestation, attestedByUserId: null },
    ]) {
      expect(() =>
        parseStoredExpenseSchedule(
          JSON.stringify({
            ...original,
            occurrences: [{ ...original.occurrences[0], cycleEvidence: proof }],
          }),
        ),
      ).toThrow(/^Invalid documented expense schedule$/);
    }
    const documentaryInput = {
      invoiceDueMonth: '2026-11',
      evidence: {
        documentSha256: oldProof.documentSha256,
        reference: oldProof.reference,
        evidenceKind: 'document',
      },
    };
    expect(parseDocumentaryCycle(documentaryInput)).toEqual(documentaryInput);
    expect(() =>
      parseDocumentaryCycle({
        ...documentaryInput,
        evidence: {
          ...documentaryInput.evidence,
          evidenceKind: 'user-attestation',
          attestedByUserId: 'synthetic-attester',
          attestedAt: oldProof.recordedAt,
        },
      }),
    ).toThrow(RangeError);
  });
});
