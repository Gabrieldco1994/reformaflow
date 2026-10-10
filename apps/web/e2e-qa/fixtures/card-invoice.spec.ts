import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { extractCardStatementDocument } from '../../../api/src/credit-card/parsers/statement-document';
import { buildImportMaterialization } from '../../../api/src/imports/import-session/import-session.extraction';
import { ignoredImportObservation, parseStoredImportObservationEvidence } from '../../../api/src/imports/import-session/import-session.observation';
import { EMPTY_DRAFT_JSON } from '../../../api/src/imports/import-session/import-session.projection';

// Run with the API ts-jest transform and scripts/test-db-env.cjs setup guard.
describe('synthetic Maria CSV QA fixture', () => {
  it('extracts six rows and materializes exactly five selectable purchases, never the invoice payment', () => {
    const bytes = readFileSync(join(__dirname, 'card-invoice.csv'));
    const expected = JSON.parse(readFileSync(join(__dirname, 'expected.json'), 'utf8'));
    expect(readFileSync(join(__dirname, 'card-invoice-copy.csv'))).toEqual(bytes);
    const extraction = extractCardStatementDocument({
      version: 1, context: 'CARD_INVOICE', format: 'CSV', profile: expected.profile, bytes,
    });
    expect(extraction.occurrences).toHaveLength(expected.selectablePurchaseCount + 1);
    expect(extraction.occurrences.slice(0, -1).map(row => ({
      title: row.merchant, amountCents: row.amountCents, date: row.dateOnly,
    }))).toEqual(expected.purchases);
    expect(extraction.occurrences.at(-1)?.raw.description).toBe(expected.ignoredPaymentRow);
    expect(extraction.occurrences.at(-1)?.amountCents).toBe(expected.ignoredPaymentAmountCents);
    expect(extraction.occurrences.every(row => row.installmentCount === null)).toBe(true);
    const session = { id: randomUUID(), tenantId: randomUUID(), ownerProjectId: randomUUID() };
    const artifact = {
      id: randomUUID(), tenantId: session.tenantId, ownerProjectId: session.ownerProjectId,
      documentSha256: createHash('sha256').update(bytes).digest('hex'),
      state: 'EXTRACTED', parserVersion: extraction.parserVersion,
    };
    const attachment = {
      id: randomUUID(), sessionId: session.id, tenantId: session.tenantId,
      ownerProjectId: session.ownerProjectId, artifactId: artifact.id, state: 'ATTACHED',
    };
    const plan = buildImportMaterialization({
      session, attachment, artifact, extraction, observations: [],
      draft: { ...JSON.parse(EMPTY_DRAFT_JSON), scope: { observationIds: [], pendingAttachmentIds: [attachment.id] } },
      newIds: new Map(extraction.occurrences.map(row => [row.reference, {
        observationId: randomUUID(), lineId: randomUUID(),
      }])),
    } as unknown as Parameters<typeof buildImportMaterialization>[0]);
    expect(plan.draft.lines.map(line => line.titulo)).toEqual(expected.purchases.map((row: { title: string }) => row.title));
    expect(plan.draft.lines).toHaveLength(expected.selectablePurchaseCount);
    expect(plan.draft.lines.map(line => line.decision.kind)).toEqual(Array(expected.selectablePurchaseCount).fill('UNRESOLVED'));
    const evidence = plan.observations.map(row => parseStoredImportObservationEvidence(row.evidenceJson));
    const ignored = evidence.filter(row => ignoredImportObservation(row) !== null);
    expect(ignored).toHaveLength(1);
    expect(ignored[0].sourceDescription).toBe(expected.ignoredPaymentRow);
    expect(evidence.filter(row => ignoredImportObservation(row) === null).reduce((sum, row) => sum + row.amountCents!, 0))
      .toBe(expected.purchaseTotalCents);
    // Eligibility is not readiness: generic CSV intentionally requires human declarations.
    expect(plan.draft.questions.length).toBeGreaterThan(0);
  });
});
