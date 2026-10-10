import { rawTestDependencies } from "../../test-utils/import-session-raw-harness";
// The database guard must run before PrismaClient is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../../scripts/test-db-env.cjs');
import { ImportVaultGate } from "./vault/vault-state";

import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  authFor,
  cleanupImportWorld,
  EMPTY_DRAFT_JSON,
  FIXED_NOW,
  mintGrant,
  MutableClock,
  seedImportWorld,
  seedSession,
  SEVEN_DAYS_MS,
  VALID_RECEIPT,
  type ImportWorld,
} from '../../test-utils/import-session-harness';
import { ImportSessionService } from './import-session.service';
import { RuntimeUiGrantVerifier, ImportUiGrantIssuer } from './import-session-ui-grant';
import type { ImportSessionCapability } from './import-session.capability';
import {
  validationDraft,
  validationProposal,
} from "../../test-utils/import-session-validation-fixtures";
import { validateDocumentExtraction } from "../../credit-card/parsers/statement-document";
import type { ImportSessionStoredDraftV1 } from "@reformaflow/domain";

const PREFIX = 'imp-life';
const setup = new PrismaClient();
const prisma = new PrismaService();
const clock = new MutableClock();
const capability: ImportSessionCapability & { on: boolean } = {
  on: false,
  writesEnabled() {
    return this.on;
  },
  newImportFormats: () => [],
};
const issuer = new ImportUiGrantIssuer(clock);
const service = new ImportSessionService(
  prisma,
  clock,
  capability,
  new RuntimeUiGrantVerifier(),
  ...rawTestDependencies(new ImportVaultGate(prisma, clock, {}, process.cwd()), clock, capability),
);
let world: ImportWorld;

const owner = () => world.users.owner;
const cancelScope = (sessionId: string, expectedRevision: number) => ({ operation: 'CANCEL_SESSION' as const, sessionId, expectedRevision });
const cancelAs = (user: ImportWorld['users']['owner'], sessionId: string, expectedRevision = 1) => {
  const auth = authFor(user);
  return service.cancel(auth, sessionId, { expectedRevision }, mintGrant(issuer, auth, cancelScope(sessionId, expectedRevision)));
};
const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; status?: number; retryable?: boolean; sessionId?: unknown; currentRevision?: unknown };
  }
  throw new Error('expected rejection');
};
const row = (id: string) => setup.importSession.findUniqueOrThrow({ where: { id } });

async function projectionEvidence(
  sessionId: string,
  draft: ImportSessionStoredDraftV1,
): Promise<void> {
  const bytes = Buffer.from(`synthetic projection ${sessionId}`);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const fileHash = createHash("sha256").update(sha).digest("hex").slice(0, 32);
  const extraction = validateDocumentExtraction({
    version: 1,
    parserVersion: "card-local-text-v1",
    documentKind: "UNKNOWN",
    invoiceDueMonth: null,
    metrics: {
      rows: draft.scope.observationIds.length,
      pages: 0,
      expandedBytes: 0,
      archiveEntries: 0,
      imagePixels: 0,
      frames: 0,
    },
    occurrences: draft.scope.observationIds.map((_id, index) => ({
      reference: `csv:record:${index + 2}`,
      sourceOrdinal: index,
      section: "UNKNOWN",
      raw: {
        date: "2026-09-01",
        description: "Synthetic projection",
        amount: "100.00",
        installment: null,
      },
      cycle: null,
      dateOnly: "2026-09-01",
      merchant: "Synthetic projection",
      amountCents: 10000,
      amountMeaning: "TOTAL_PURCHASE",
      installmentCount: 1,
      installmentIndex: null,
      fitId: null,
      identityOrdinal: index,
    })),
    diagnostics: [],
  });
  const artifact = await setup.importArtifact.create({
    data: {
      tenantId: world.tenantId,
      ownerProjectId: world.projects.pessoal,
      documentSha256: sha,
      detectedFormat: "CSV",
      state: "EXTRACTED",
      verifiedBytes: bytes.length,
      parserVersion: extraction.parserVersion,
      extractionJson: JSON.stringify(extraction),
    },
  });
  await setup.importSessionArtifact.create({
    data: {
      tenantId: world.tenantId,
      ownerProjectId: world.projects.pessoal,
      sessionId,
      artifactId: artifact.id,
      position: 0,
      fileName: "synthetic-projection.csv",
      declaredMime: "text/csv",
      declaredBytes: bytes.length,
      reservedBytes: 0,
      state: "ATTACHED",
      verifiedAt: FIXED_NOW,
    },
  });
  for (const [index, id] of draft.scope.observationIds.entries()) {
    const original = extraction.occurrences[index]!;
    await setup.importObservation.create({
      data: {
        id,
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        artifactId: artifact.id,
        reference: original.reference,
        evidenceJson: JSON.stringify({
          version: 1,
          reference: original.reference,
          text: "Synthetic projection",
          amountMeaning: original.amountMeaning,
          amountCents: original.amountCents,
          installmentCount: original.installmentCount,
          installmentIndex: original.installmentIndex,
          dataCompra: original.dateOnly,
          identity: {
            merchant: original.merchant,
            ordinal: original.identityOrdinal,
            fitId: null,
            externalId: null,
            fileContentHash: fileHash,
          },
        }),
      },
    });
  }
}

describe('B1a — lifecycle: kill switch, cancel, expiry projection, result (real Prisma)', () => {
  beforeAll(async () => {
    jest.useFakeTimers({ doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'setInterval', 'setTimeout'] });
    jest.setSystemTime(FIXED_NOW);
    await setup.$connect();
    await prisma.onModuleInit();
    world = await seedImportWorld(setup, PREFIX);
  });
  beforeEach(async () => {
    clock.current = FIXED_NOW;
    capability.on = false;
    await setup.importSessionArtifact.deleteMany({ where: { tenantId: world.tenantId } });
    await setup.importObservation.deleteMany({ where: { tenantId: world.tenantId } });
    await setup.importArtifact.deleteMany({ where: { tenantId: world.tenantId } });
    await setup.importSession.deleteMany({ where: { tenantId: world.tenantId } });
    await setup.expense.deleteMany({ where: { tenantId: world.tenantId } });
    await setup.user.updateMany({ where: { tenantId: world.tenantId }, data: { sessionVersion: 0 } });
    await setup.user.update({ where: { id: world.users.restricted.id }, data: { allowedModules: JSON.stringify(['creditCards', 'expenses']) } });
  });
  afterAll(async () => {
    await cleanupImportWorld(setup, PREFIX);
    await prisma.onModuleDestroy();
    await setup.$disconnect();
    jest.useRealTimers();
  });

  describe('disabled_keeps_result_and_cancel_available', () => {
    it('answers 503 CAPABILITY_DISABLED on create and writes nothing; GET, result and cancel keep working', async () => {
      const requestId = randomUUID();
      const auth = authFor(owner());
      const error = await rejection(
        service.create(auth, { version: 1, createRequestId: requestId, cardId: world.cards.pessoal, consentPolicyVersion: 1, consentAnalyze: true }, mintGrant(issuer, auth, { operation: 'CREATE_SESSION', cardId: world.cards.pessoal, createRequestId: requestId, consentPolicyVersion: 1 })),
      );
      expect(error).toMatchObject({ code: 'CAPABILITY_DISABLED', status: 503, retryable: true, sessionId: null, currentRevision: null, reason: null });
      expect(await setup.importSession.count({ where: { tenantId: world.tenantId } })).toBe(0);

      const seeded = await seedSession(setup, world);
      const view = await service.getSession(authFor(owner()), seeded.id);
      expect(view).toMatchObject({ id: seeded.id, state: 'DRAFT', revision: 1 });
      expect(await service.getResult(authFor(owner()), seeded.id)).toEqual({ state: 'DRAFT', receipt: null });
      const cancelled = await cancelAs(owner(), seeded.id);
      expect(cancelled.state).toBe('CANCELLED');
    });

    it('the default provider is closed even with no override', () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DefaultImportSessionCapability } = require('./import-session.capability');
      expect(new DefaultImportSessionCapability().writesEnabled()).toBe(false);
    });
  });

  describe('cancel', () => {
    it('closes the session atomically: empty draft, cleared transients, invalidated leases, released references', async () => {
      const seeded = await seedSession(setup, world, {
        state: 'READY',
        revision: 4,
        draftJson: '{"version":1,"lines":[],"selectedLineIds":[],"questions":[],"scope":{"observationIds":["o1"],"pendingAttachmentIds":["a1"]}}',
        searchJson: '{"complete":true}',
        proposalJson: '{"x":1}',
        proposalHash: 'c'.repeat(64),
        preflightHash: 'd'.repeat(64),
        challengeJson: '{"nonceHash":"e"}',
        prepareLeaseJson: '{"generation":2}',
        prepareGeneration: 2,
      });
      const artifact = await setup.importArtifact.create({
        data: {
          tenantId: world.tenantId,
          ownerProjectId: world.projects.pessoal,
          documentSha256: 'f'.repeat(64),
          verifiedBytes: 10,
          detectedFormat: 'CSV',
          state: 'ANALYZING',
          storageKey: 'private/key',
          leaseSessionId: seeded.id,
          leaseSessionVersion: 0,
          leaseTokenExpiresAt: new Date(FIXED_NOW.getTime() + 1000),
          leaseExpiresAt: new Date(FIXED_NOW.getTime() + 1000),
          parseGeneration: 5,
        },
      });
      const otherSession = await seedSession(setup, world, { ownerUserId: world.users.peer.id });
      const otherArtifact = await setup.importArtifact.create({
        data: {
          tenantId: world.tenantId,
          ownerProjectId: world.projects.pessoal,
          documentSha256: '1'.repeat(64),
          verifiedBytes: 10,
          detectedFormat: 'CSV',
          state: 'ANALYZING',
          leaseSessionId: otherSession.id,
          leaseSessionVersion: 0,
          leaseExpiresAt: new Date(FIXED_NOW.getTime() + 1000),
          parseGeneration: 1,
        },
      });
      const reference = await setup.importSessionArtifact.create({
        data: { tenantId: world.tenantId, ownerProjectId: world.projects.pessoal, sessionId: seeded.id, artifactId: artifact.id, position: 0, fileName: 'a.csv', declaredMime: 'text/csv', declaredBytes: 10, state: 'ATTACHED', verifiedAt: FIXED_NOW, reservedBytes: 10, temporaryStorageKey: 'tmp/key' },
      });

      const view = await cancelAs(owner(), seeded.id, 4);

      expect(view).toMatchObject({ state: 'CANCELLED', revision: 5, expiresAt: null, lines: [], selectedLineIds: [], questions: [], attachments: [], proposal: null, actions: [] });
      const after = await row(seeded.id);
      expect(after).toMatchObject({
        state: 'CANCELLED',
        revision: 5,
        draftJson: EMPTY_DRAFT_JSON,
        searchJson: null,
        proposalJson: null,
        proposalHash: null,
        preflightHash: null,
        challengeJson: null,
        prepareLeaseJson: null,
        prepareGeneration: 3,
      });
      expect(after.closedAt).toEqual(FIXED_NOW);
      // Deadline is historical and untouched.
      expect(after.expiresAt).toEqual(new Date(FIXED_NOW.getTime() + SEVEN_DAYS_MS));

      const leased = await setup.importArtifact.findUniqueOrThrow({ where: { id: artifact.id } });
      // Invalidate the parse attempt without destroying bytes needed by a future retry.
      expect(leased).toMatchObject({ leaseSessionId: null, leaseSessionVersion: null, leaseTokenExpiresAt: null, leaseExpiresAt: null, parseGeneration: 6, state: 'RAW_READY', storageKey: 'private/key' });
      // Only leases of THIS session are cleared.
      const untouched = await setup.importArtifact.findUniqueOrThrow({ where: { id: otherArtifact.id } });
      expect(untouched).toMatchObject({ leaseSessionId: otherSession.id, parseGeneration: 1 });
      expect((await row(otherSession.id)).state).toBe('DRAFT');

      // References are released for the reaper; no quota is given back before a physical purge.
      const released = await setup.importSessionArtifact.findUniqueOrThrow({ where: { id: reference.id } });
      expect(released).toMatchObject({ state: 'RELEASED', reservedBytes: 10, temporaryStorageKey: 'tmp/key', temporaryPurgePending: true, uploadGeneration: 1 });
      expect(released.releasedAt).toEqual(FIXED_NOW);
    });

    it('keeps the public legacy confirmation binding of a confirmed, not applied session', async () => {
      const seeded = await seedSession(setup, world, {
        state: 'CONFIRMED',
        revision: 2,
        proposalJson: '{"x":1}',
        proposalHash: 'c'.repeat(64),
        financialRequestId: '123e4567-e89b-42d3-a456-426614174000',
        confirmedRevision: 2,
        confirmedSessionVersion: 0,
        confirmedAt: FIXED_NOW,
      });
      const view = await cancelAs(owner(), seeded.id, 2);
      expect(view.confirmation).toEqual({
        financialRequestId: '123e4567-e89b-42d3-a456-426614174000',
        confirmedRevision: 2,
        bindingVersion: 0,
        confirmationHash: null,
      });
      const after = await row(seeded.id);
      expect(after).toMatchObject({ state: 'CANCELLED', proposalJson: null, proposalHash: 'c'.repeat(64), financialRequestId: '123e4567-e89b-42d3-a456-426614174000' });
    });

    it('answers REVISION_CONFLICT with the current revision for a stale expectedRevision and changes nothing', async () => {
      const seeded = await seedSession(setup, world, { revision: 3 });
      const error = await rejection(cancelAs(owner(), seeded.id, 2));
      expect(error).toMatchObject({ code: 'REVISION_CONFLICT', status: 409, retryable: false, sessionId: seeded.id, currentRevision: 3 });
      expect((await row(seeded.id)).state).toBe('DRAFT');
    });

    it('cancel is still possible at the maximum revision (no overflow)', async () => {
      const seeded = await seedSession(setup, world, { revision: 2147483647 });
      const view = await cancelAs(owner(), seeded.id, 2147483647);
      expect(view).toMatchObject({ state: 'CANCELLED', revision: 2147483647 });
    });

    it('lets exactly one of two concurrent cancels win the transition; the loser is a no-op replay', async () => {
      const seeded = await seedSession(setup, world);
      const results = await Promise.all([cancelAs(owner(), seeded.id), cancelAs(owner(), seeded.id)]);
      expect(results.map((r) => r.state)).toEqual(['CANCELLED', 'CANCELLED']);
      expect((await row(seeded.id)).revision).toBe(2);
    });

    it('a state that changed to APPLIED under the writer wins: cancel answers 409 ALREADY_APPLIED and keeps the receipt', async () => {
      const seeded = await seedSession(setup, world, { state: 'READY' });
      // The apply commits between the request admission and the cancel writer.
      const auth = authFor(owner());
      const grant = mintGrant(issuer, auth, cancelScope(seeded.id, 1));
      await setup.importSession.update({
        where: { id: seeded.id },
        data: { state: 'APPLIED', financialRequestId: '123e4567-e89b-42d3-a456-426614174000', confirmedRevision: 1, confirmedSessionVersion: 0, confirmedAt: FIXED_NOW, proposalHash: 'b'.repeat(64), receiptJson: JSON.stringify(VALID_RECEIPT(seeded.id, ['e1'], [world.projects.pessoal])), closedAt: FIXED_NOW },
      });
      const error = await rejection(service.cancel(auth, seeded.id, { expectedRevision: 1 }, grant));
      expect(error).toMatchObject({ code: 'ALREADY_APPLIED', status: 409, retryable: false, sessionId: seeded.id, currentRevision: 1 });
      const after = await row(seeded.id);
      expect(after.state).toBe('APPLIED');
      expect(after.receiptJson).not.toBeNull();
    });

    it.each([['CANCELLED'], ['EXPIRED']])('cancelling a %s session is a 200 no-op that does not renew anything', async (state) => {
      const seeded = await seedSession(setup, world, { state, closedAt: FIXED_NOW, revision: 7 });
      const before = await row(seeded.id);
      const view = await cancelAs(owner(), seeded.id, 1); // even a stale revision: nothing to conflict with
      expect(view.state).toBe(state);
      const after = await row(seeded.id);
      expect(after).toEqual(before);
    });

    it('cancelling a session whose deadline already passed is a no-op (projected EXPIRED), not a write', async () => {
      const seeded = await seedSession(setup, world, { expiresAt: new Date(FIXED_NOW.getTime() - 1) });
      const before = await row(seeded.id);
      const view = await cancelAs(owner(), seeded.id);
      expect(view.state).toBe('EXPIRED');
      expect(await row(seeded.id)).toEqual(before);
    });

    it('rolls back every write when a later step fails (no half-closed session)', async () => {
      const seeded = await seedSession(setup, world);
      const artifact = await setup.importArtifact.create({
        data: { tenantId: world.tenantId, ownerProjectId: world.projects.pessoal, documentSha256: '2'.repeat(64), verifiedBytes: 1, detectedFormat: 'CSV', state: 'ANALYZING', leaseSessionId: seeded.id, leaseSessionVersion: 0, leaseExpiresAt: FIXED_NOW, parseGeneration: 1 },
      });
      const failing = new PrismaService();
      let armed = true;
      failing.$use(async (params, next) => {
        if (armed && params.model === 'ImportSessionArtifact' && params.action === 'updateMany') throw new Error('injected failure after the session update');
        return next(params);
      });
      await failing.onModuleInit();
      await setup.importSessionArtifact.create({
        data: { tenantId: world.tenantId, ownerProjectId: world.projects.pessoal, sessionId: seeded.id, position: 0, fileName: 'a.csv', declaredMime: 'text/csv', declaredBytes: 1, state: 'RESERVED', reservedBytes: 1 },
      });
      const failingService = new ImportSessionService(
        failing,
        clock,
        capability,
        new RuntimeUiGrantVerifier(),
        ...rawTestDependencies(new ImportVaultGate(failing, clock, {}, process.cwd()), clock, capability),
      );
      const auth = authFor(owner());
      await expect(failingService.cancel(auth, seeded.id, { expectedRevision: 1 }, mintGrant(issuer, auth, cancelScope(seeded.id, 1)))).rejects.toThrow('injected failure');
      armed = false;
      expect(await row(seeded.id)).toMatchObject({ state: 'DRAFT', revision: 1, draftJson: EMPTY_DRAFT_JSON, closedAt: null });
      expect(await setup.importArtifact.findUniqueOrThrow({ where: { id: artifact.id } })).toMatchObject({ leaseSessionId: seeded.id, parseGeneration: 1 });
      await failing.onModuleDestroy();
    });

    it('a cancel by a user whose ACL was revoked is opaque NOT_FOUND and leaves the session as it was (D3: full reauth)', async () => {
      const seeded = await seedSession(setup, world, { ownerUserId: world.users.restricted.id });
      await setup.user.update({ where: { id: world.users.restricted.id }, data: { allowedModules: JSON.stringify(['expenses']) } });
      const error = await rejection(cancelAs(world.users.restricted, seeded.id));
      expect(error).toMatchObject({ code: 'NOT_FOUND', sessionId: null, currentRevision: null, reason: null });
      expect((await row(seeded.id)).state).toBe('DRAFT');
      const read = await rejection(service.getSession(authFor(world.users.restricted), seeded.id));
      expect(read).toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('terminal_expiry_is_projection_not_database_null', () => {
    it.each([['CANCELLED'], ['EXPIRED']])('%s projects expiresAt:null while the SQL deadline is intact', async (state) => {
      const seeded = await seedSession(setup, world, { state, closedAt: FIXED_NOW });
      const view = await service.getSession(authFor(owner()), seeded.id);
      expect(view.expiresAt).toBeNull();
      expect((await row(seeded.id)).expiresAt).toEqual(new Date(FIXED_NOW.getTime() + SEVEN_DAYS_MS));
    });

    it('APPLIED projects expiresAt:null and never expires by the clock', async () => {
      const seeded = await seedSession(setup, world, { state: 'APPLIED', closedAt: FIXED_NOW, financialRequestId: '123e4567-e89b-42d3-a456-426614174000', confirmedRevision: 1, confirmedSessionVersion: 0, confirmedAt: FIXED_NOW, proposalHash: 'b'.repeat(64) });
      await setup.importSession.update({ where: { id: seeded.id }, data: { receiptJson: JSON.stringify(VALID_RECEIPT(seeded.id, ['no-expense-check-for-owner'], [world.projects.pessoal])) } });
      clock.current = new Date(FIXED_NOW.getTime() + 30 * SEVEN_DAYS_MS);
      // A far-future clock also puts the original JWT past its expiry: use a fresh token.
      const fresh = authFor(owner(), { expiresAt: new Date(clock.current.getTime() + 60_000) });
      expect(await service.getSession(fresh, seeded.id)).toMatchObject({ state: 'APPLIED', expiresAt: null });
    });

    it('a live session projects its persisted deadline; the exact deadline instant projects EXPIRED without writing', async () => {
      const seeded = await seedSession(setup, world, { state: 'NEEDS_INPUT' });
      const deadline = new Date(FIXED_NOW.getTime() + SEVEN_DAYS_MS);
      const live = await service.getSession(authFor(owner()), seeded.id);
      expect(live).toMatchObject({ state: 'NEEDS_INPUT', expiresAt: deadline.toISOString() });

      const before = await row(seeded.id);
      clock.current = new Date(deadline.getTime() - 1);
      expect((await service.getSession(authFor(owner(), { expiresAt: new Date(deadline.getTime() + 60_000) }), seeded.id)).state).toBe('NEEDS_INPUT');
      clock.current = deadline;
      const auth = authFor(owner(), { expiresAt: new Date(deadline.getTime() + 60_000) });
      const expired = await service.getSession(auth, seeded.id);
      expect(expired).toMatchObject({ state: 'EXPIRED', expiresAt: null, lines: [], attachments: [], proposal: null, actions: [] });
      // Polling twice changes neither the deadline nor any column.
      await service.getSession(auth, seeded.id);
      await service.getResult(auth, seeded.id);
      expect(await row(seeded.id)).toEqual(before);
    });
  });

  describe('GET result and receipt visibility', () => {
    const appliedSeed = (extra: Record<string, unknown> = {}) => ({
      state: 'APPLIED',
      closedAt: FIXED_NOW,
      financialRequestId: '123e4567-e89b-42d3-a456-426614174000',
      confirmedRevision: 1,
      confirmedSessionVersion: 0,
      confirmedAt: FIXED_NOW,
      proposalHash: 'b'.repeat(64),
      ...extra,
    });
    const seedExpense = (id: string, projectId: string) =>
      setup.expense.create({ data: { id, tenantId: world.tenantId, projectId, tipoDespesa: 'MATERIAL_CONSTRUCAO', valor: 100, valorTotal: 100, formaPagamento: 'A_VISTA', dataPagamento: FIXED_NOW, titulo: id } });

    it('returns the receipt of an APPLIED session, with the pointer to the continuation and the confirmation tuple public', async () => {
      const expense = await seedExpense('imp-life-e1', world.projects.pessoal);
      const seeded = await seedSession(setup, world, { ownerUserId: world.users.restricted.id, ...appliedSeed(), receiptJson: JSON.stringify(VALID_RECEIPT('placeholder', [expense.id], [world.projects.pessoal])) });
      // The receipt embeds its own session id.
      await setup.importSession.update({ where: { id: seeded.id }, data: { receiptJson: JSON.stringify(VALID_RECEIPT(seeded.id, [expense.id], [world.projects.pessoal])) } });
      const auth = authFor(world.users.restricted);
      const result = await service.getResult(auth, seeded.id);
      expect(result.state).toBe('APPLIED');
      expect(result.receipt).toMatchObject({
        sessionId: seeded.id,
        continuationSessionId: null,
        financialRequestId: '123e4567-e89b-42d3-a456-426614174000',
        bindingVersion: 0,
        confirmationHash: null,
      });
      const view = await service.getSession(auth, seeded.id);
      expect(view.confirmation).toEqual({
        financialRequestId: '123e4567-e89b-42d3-a456-426614174000',
        confirmedRevision: 1,
        bindingVersion: 0,
        confirmationHash: null,
      });
      expect(view.receipt).toEqual(result.receipt);
      expect(view.actions).toEqual(['READ_RESULT']);
    });

    it('reads a stored receipt with a NEW valid token (current authentication), not the original one', async () => {
      const expense = await seedExpense('imp-life-e2', world.projects.pessoal);
      const seeded = await seedSession(setup, world, { ownerUserId: world.users.restricted.id, ...appliedSeed() });
      await setup.importSession.update({ where: { id: seeded.id }, data: { receiptJson: JSON.stringify(VALID_RECEIPT(seeded.id, [expense.id], [world.projects.pessoal])) } });
      const laterToken = authFor(world.users.restricted, { expiresAt: new Date(FIXED_NOW.getTime() + 2 * SEVEN_DAYS_MS) });
      expect((await service.getResult(laterToken, seeded.id)).receipt).not.toBeNull();
    });

    it('is opaque NOT_FOUND once access to a receipt expense project is revoked (SEC-4)', async () => {
      const visible = await seedExpense('imp-life-e3', world.projects.pessoal);
      const hidden = await seedExpense('imp-life-e4', world.projects.casa);
      const seeded = await seedSession(setup, world, { ownerUserId: world.users.restricted.id, ...appliedSeed() });
      await setup.importSession.update({ where: { id: seeded.id }, data: { receiptJson: JSON.stringify(VALID_RECEIPT(seeded.id, [visible.id, hidden.id], [world.projects.pessoal, world.projects.casa])) } });
      const auth = authFor(world.users.restricted);
      expect(await rejection(service.getResult(auth, seeded.id))).toMatchObject({ code: 'NOT_FOUND', sessionId: null, currentRevision: null, reason: null });
      expect(await rejection(service.getSession(auth, seeded.id))).toMatchObject({ code: 'NOT_FOUND' });
      // The unrestricted owner of the session still reads it.
      const ownerSession = await seedSession(setup, world, { ownerUserId: owner().id, ...appliedSeed() });
      await setup.importSession.update({ where: { id: ownerSession.id }, data: { receiptJson: JSON.stringify(VALID_RECEIPT(ownerSession.id, [visible.id, hidden.id], [world.projects.pessoal, world.projects.casa])) } });
      expect((await service.getResult(authFor(owner()), ownerSession.id)).receipt).not.toBeNull();
    });

    it('returns receipt:null for every non-applied state', async () => {
      for (const state of ['DRAFT', 'ANALYZING', 'NEEDS_INPUT', 'READY', 'CONFIRMED', 'REVIEW_REQUIRED', 'CANCELLED']) {
        const seeded = await seedSession(setup, world, { state, closedAt: state === 'CANCELLED' ? FIXED_NOW : null });
        expect(await service.getResult(authFor(owner()), seeded.id)).toEqual({ state, receipt: null });
      }
    });
  });

  describe('projection', () => {
    it('never leaks private columns and keeps the public confirmation/proposal contract fields', async () => {
      const draft = validationDraft(world.projects.pessoal);
      draft.lines = draft.lines.slice(0, 2);
      draft.questions = [];
      draft.scope = {
        observationIds: ["observation-create", "observation-keep"],
        pendingAttachmentIds: [],
      };
      const proposal = {
        ...validationProposal("x", world.projects.pessoal),
        deferredObservationIds: [],
        deferredAttachmentIds: [],
        retainUntil: null,
      };
      const seeded = await seedSession(setup, world, {
        state: "CONFIRMED",
        revision: 2,
        draftJson: JSON.stringify(draft),
        proposalJson: JSON.stringify({ ...proposal, sessionId: "placeholder" }),
        proposalHash: "c".repeat(64),
        preflightHash: "d".repeat(64),
        challengeJson: '{"nonceHash":"secret-nonce-hash"}',
        prepareLeaseJson: '{"generation":1,"token":"secret-lease"}',
        searchJson: JSON.stringify({
          version: 1,
          revision: 2,
          complete: true,
          candidates: [
            {
              lineId: draft.selectedLineIds[0],
              kind: "EXPENSE",
              id: "secret-search",
              reason: "NATURAL_MATCH",
            },
          ],
          coverage: {
            recipe: "CARD_PURCHASE_V1",
            inputHash: "e".repeat(64),
            steps: draft.selectedLineIds.flatMap((lineId) =>
              ["DOCUMENT_IDENTITY", "CROSS_ORIGIN", "CARD_IDENTITY"].map(
                (stage) => ({
                  lineId,
                  stage,
                  status: "EXHAUSTED",
                  predicateHash: "f".repeat(64),
                  visitedRows: 1,
                  endCursor: null,
                }),
              ),
            ),
          },
        }),
        createPayloadHash: "9".repeat(64),
        financialRequestId: "123e4567-e89b-42d3-a456-426614174000",
        confirmedRevision: 2,
        confirmedSessionVersion: 0,
        confirmedAt: FIXED_NOW,
      });
      await setup.importSession.update({ where: { id: seeded.id }, data: { proposalJson: JSON.stringify({ ...proposal, sessionId: seeded.id }) } });
      await projectionEvidence(seeded.id, draft);
      const view = await service.getSession(authFor(owner()), seeded.id);
      const text = JSON.stringify(view);
      for (const secret of ['secret-nonce-hash', 'secret-lease', 'secret-search', 'd'.repeat(64), '9'.repeat(64), 'createRequestId', 'createPayloadHash', 'nonceHash', 'storageKey', 'documentSha256', 'scope', 'tenantId', 'ownerUserId']) {
        expect(text).not.toContain(secret);
      }
      expect(view.proposal).toMatchObject({ deferredAttachmentIds: [], retainUntil: null });
      expect(view.confirmation).toEqual({
        financialRequestId: '123e4567-e89b-42d3-a456-426614174000',
        confirmedRevision: 2,
        bindingVersion: 0,
        confirmationHash: null,
      });
      expect(Object.keys(view).sort()).toEqual(
        [
          "actions",
          "attachments",
          "cardId",
          "confirmation",
          "declaredFacts",
          "expiresAt",
          "id",
          "lines",
          "ownerProjectId",
          "proposal",
          "questions",
          "receipt",
          "reviewBlockers",
          "revision",
          "searchComplete",
          "selectedLineIds",
          "state",
          "version",
        ].sort(),
      );
    });

    it('lists only live attachments with public fields and reports actions that exist in this slice', async () => {
      const seeded = await seedSession(setup, world);
      await setup.importSessionArtifact.createMany({
        data: [
          { tenantId: world.tenantId, ownerProjectId: world.projects.pessoal, sessionId: seeded.id, position: 0, fileName: 'a.csv', declaredMime: 'text/csv', declaredBytes: 10, state: 'RESERVED', reservedBytes: 10, temporaryStorageKey: 'tmp/secret' },
          { tenantId: world.tenantId, ownerProjectId: world.projects.pessoal, sessionId: seeded.id, position: 1, fileName: 'gone.csv', declaredMime: 'text/csv', declaredBytes: 10, state: 'RELEASED', reservedBytes: 0, releasedAt: FIXED_NOW },
        ],
      });
      const view = await service.getSession(authFor(owner()), seeded.id);
      expect(view.attachments).toEqual([
        {
          id: expect.any(String),
          fileName: "a.csv",
          declaredBytes: 10,
          state: "RESERVED",
          materializedInSession: false,
          canAnalyze: false,
        },
      ]);
      expect(JSON.stringify(view)).not.toContain('tmp/secret');
      expect(view.actions).toEqual(['CANCEL']);
      expect(view.searchComplete).toBe(false);
    });

    it.each([
      ['draft that is not an object', { draftJson: '[1]' }],
      ['draft without scope', { draftJson: '{"version":1,"lines":[],"selectedLineIds":[],"questions":[]}' }],
      ['draft with a wrong version', { draftJson: '{"version":2,"lines":[],"selectedLineIds":[],"questions":[],"scope":{"observationIds":[],"pendingAttachmentIds":[]}}' }],
    ])('fails closed with a generic error (no fallback, no content) on %s', async (_label, corrupt) => {
      const seeded = await seedSession(setup, world);
      await setup.$executeRawUnsafe(`UPDATE import_sessions SET ${Object.keys(corrupt).map((k) => (k === 'draftJson' ? 'draft_json' : 'proposal_json')).join(',')} = ? WHERE id = ?`, Object.values(corrupt)[0] as string, seeded.id);
      const error = await rejection(service.getSession(authFor(owner()), seeded.id));
      expect(error).toBeInstanceOf(Error);
      expect((error as { code?: string }).code).toBeUndefined();
      expect(String((error as unknown as Error).message)).not.toContain('[1]');
      expect((error as unknown as Error).name).toBe('ImportSessionCorruptStateError');
    });
    describe('proposal contract fields (AC18 freeze) are mandatory and typed, never repaired', () => {
      const validProposal = (sessionId: string): Record<string, unknown> => ({
        ...validationProposal(sessionId, world.projects.pessoal),
      });
      const omit = (key: string) => (p: Record<string, unknown>) => { delete p[key]; return p; };
      const set = (key: string, value: unknown) => (p: Record<string, unknown>) => ({ ...p, [key]: value });
      const table: Array<[string, (p: Record<string, unknown>) => Record<string, unknown>]> = [
        ['without deferredAttachmentIds', omit('deferredAttachmentIds')],
        ['without retainUntil', omit('retainUntil')],
        ['retainUntil is a free-form string', set('retainUntil', 'tomorrow')],
        ['retainUntil has no milliseconds', set('retainUntil', '2026-10-05T15:00:00Z')],
        ['retainUntil is a number', set('retainUntil', 1790000000000)],
        ['deferredAttachmentIds holds a non-string', set('deferredAttachmentIds', [7])],
      ];
      it.each(table)('a stored proposal %s fails closed (ImportSessionCorruptStateError)', async (_label, mutate) => {
        const seeded = await seedSession(setup, world, {
          draftJson: JSON.stringify(validationDraft(world.projects.pessoal)),
        });
        await setup.importSession.update({ where: { id: seeded.id }, data: { proposalJson: JSON.stringify(mutate(validProposal(seeded.id))) } });
        const error = await rejection(service.getSession(authFor(owner()), seeded.id));
        expect((error as unknown as Error).name).toBe('ImportSessionCorruptStateError');
        expect((error as { code?: string }).code).toBeUndefined();
      });

      it.each([[null], ['2026-10-05T15:00:00.000Z']])('accepts retainUntil=%s exactly as persisted', async (retainUntil) => {
        const draft = validationDraft(world.projects.pessoal);
        if (retainUntil === null) {
          draft.lines = draft.lines.slice(0, 2);
          draft.questions = [];
          draft.scope = {
            observationIds: ["observation-create", "observation-keep"],
            pendingAttachmentIds: [],
          };
        }
        const seeded = await seedSession(setup, world, {
          draftJson: JSON.stringify(draft),
        });
        const proposal = {
          ...validProposal(seeded.id),
          retainUntil,
          ...(retainUntil === null
            ? { deferredObservationIds: [], deferredAttachmentIds: [] }
            : {}),
        };
        await setup.importSession.update({
          where: { id: seeded.id },
          data: { proposalJson: JSON.stringify(proposal) },
        });
          await projectionEvidence(seeded.id, draft);
        const view = await service.getSession(authFor(owner()), seeded.id);
        expect(view.proposal).toMatchObject({ retainUntil });
      });
    });
  });
});
