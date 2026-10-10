import { rawTestDependencies } from "../../test-utils/import-session-raw-harness";
// The database guard must run before PrismaClient is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../../scripts/test-db-env.cjs');
import { ImportVaultGate } from "./vault/vault-state";

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { hasFeature, ProjectType } from '@reformaflow/domain';
import {
  EXPENSE_MODULE,
  userCanAccessProject,
  userCanAccessProjectModule,
} from '../../common/access-rules';
import { PrismaService } from '../../prisma/prisma.service';
import {
  authFor,
  forgedAuthFor,
  cleanupImportWorld,
  createBody,
  createScope,
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
import { canonicalVaultFixture } from '../../test-utils/import-session-vault-harness';
import { ImportSessionService } from './import-session.service';
import { RuntimeUiGrantVerifier, ImportUiGrantIssuer } from './import-session-ui-grant';

/**
 * B1a — autoridade não bypassável NO SERVICE (sem controller): JWT sv/exp, ACL do
 * cartão, isolamento por dono/tenant, quota, idempotência e validação estrita.
 * PrismaService real, SQLite descartável, relógio fixo.
 */
const PREFIX = 'imp-sec';
const setup = new PrismaClient();
const prisma = new PrismaService();
const clock = new MutableClock();
const capability = {
  writesEnabled: () => true,
  newImportFormats: () => ["CSV"] as const,
};
const issuer = new ImportUiGrantIssuer(clock);

let world: ImportWorld;
let service: ImportSessionService;
let vault: Awaited<ReturnType<typeof canonicalVaultFixture>>;

const sessionCount = () =>
  setup.importSession.count({
    where: { tenantId: { in: [world.tenantId, world.otherTenantId] } },
  });

function createAs(
  user: ImportWorld['users']['owner'],
  cardId: string,
  requestId: string = randomUUID(),
  authOptions: Parameters<typeof authFor>[1] = {},
) {
  const auth = authFor(user, authOptions);
  const body = createBody(cardId, requestId);
  return service.create(auth, body, mintGrant(issuer, auth, createScope(cardId, requestId)));
}

async function resetSessions() {
  await setup.importSessionArtifact.deleteMany({ where: { tenantId: world.tenantId } });
  await setup.importArtifact.deleteMany({ where: { tenantId: world.tenantId } });
  await setup.importSession.deleteMany({ where: { tenantId: world.tenantId } });
}

const wire = (error: unknown) => {
  const e = error as { code: string; retryable: boolean; sessionId: unknown; currentRevision: unknown; reason: unknown };
  return { code: e.code, retryable: e.retryable, sessionId: e.sessionId, currentRevision: e.currentRevision, reason: e.reason };
};
async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected rejection');
}

describe('import-session intake — authority enforced in the service (B1a)', () => {
  beforeAll(async () => {
    jest.useFakeTimers({
      doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'setInterval', 'setTimeout'],
    });
    jest.setSystemTime(FIXED_NOW);
    await setup.$connect();
    await prisma.onModuleInit();
    vault = await canonicalVaultFixture();
    const gate = vault.createGate(prisma, clock);
    if (!(gate instanceof ImportVaultGate))
      throw new Error("Expected real vault gate");
    await gate.boot.settled;
    service = new ImportSessionService(
      prisma,
      clock,
      capability,
      new RuntimeUiGrantVerifier(),
      ...rawTestDependencies(gate, clock, capability),
    );
    world = await seedImportWorld(setup, PREFIX);
  });

  beforeEach(async () => {
    clock.current = FIXED_NOW;
    await resetSessions();
    await setup.user.updateMany({
      where: { tenantId: world.tenantId },
      data: { sessionVersion: 0, deletedAt: null, isGuest: false },
    });
    await setup.user.update({
      where: { id: world.users.restricted.id },
      data: { allowedModules: JSON.stringify(['creditCards', 'expenses']), allowedProjects: JSON.stringify([world.projects.pessoal]), allowedProjectTypes: '[]' },
    });
    await setup.tenant.updateMany({ where: { id: world.tenantId }, data: { deletedAt: null, expiresAt: null } });
    await setup.creditCard.updateMany({ where: { tenantId: world.tenantId }, data: { deletedAt: null } });
    await setup.project.updateMany({ where: { tenantId: world.tenantId }, data: { deletedAt: null } });
  });

  afterAll(async () => {
    await cleanupImportWorld(setup, PREFIX);
    await vault.close();
    await prisma.onModuleDestroy();
    await setup.$disconnect();
    jest.useRealTimers();
  });

  describe('Maria CSV R1 source and target authority', () => {
    it('accepts_only_a_PESSOAL_source_card', async () => {
      const before = await sessionCount();
      const error = await rejection(createAs(world.users.owner, world.cards.casa));
      expect(wire(error)).toEqual({
        code: 'INVALID_INPUT',
        retryable: false,
        sessionId: null,
        currentRevision: null,
        reason: null,
      });
      expect(await sessionCount()).toBe(before);

      const accepted = await createAs(world.users.restricted, world.cards.pessoal);
      expect(accepted.created).toBe(true);
      expect(accepted.view.ownerProjectId).toBe(world.projects.pessoal);
    });

    it('does_not_create_projects_or_authorize_through_a_target_relation', async () => {
      const projectsBefore = await setup.project.count({ where: { tenantId: world.tenantId } });
      const created = await createAs(world.users.restricted, world.cards.pessoal);
      await setup.project.update({
        where: { id: world.projects.casa },
        data: { deletedAt: clock.now() },
      });

      await expect(
        service.getSession(authFor(world.users.restricted), created.view.id),
      ).resolves.toMatchObject({
        id: created.view.id,
        ownerProjectId: world.projects.pessoal,
      });
      expect(await setup.project.count({ where: { tenantId: world.tenantId } })).toBe(projectsBefore);
    });

    it('requires_REFORMA_type_expenses_capability_and_current_project_grant_for_a_target', async () => {
      const adapter = readFileSync(join(__dirname, 'card-purchase-batch.adapter.ts'), 'utf8');
      const actor = await setup.user.findUniqueOrThrow({
        where: { id: world.users.restricted.id },
        select: { role: true },
      });
      const targetProjectId = world.projects.casa;
      const combinations = [
        {
          label: 'navigation only',
          navigation: true,
          type: ProjectType.PLANTAS,
          projects: [],
          modules: [],
        },
        {
          label: 'product capability only',
          navigation: false,
          type: ProjectType.REFORMA,
          projects: [],
          modules: [],
        },
        {
          label: 'module without project grant',
          navigation: false,
          type: ProjectType.REFORMA,
          projects: [world.projects.pessoal],
          modules: [EXPENSE_MODULE],
        },
        {
          label: 'project grant without module',
          navigation: false,
          type: ProjectType.REFORMA,
          projects: [targetProjectId],
          modules: [],
        },
        {
          label: 'both valid',
          navigation: false,
          type: ProjectType.REFORMA,
          projects: [targetProjectId],
          modules: [EXPENSE_MODULE],
        },
      ];
      const mayPrepareOrExecute = combinations.map((combination) => ({
        label: combination.label,
        allowed:
          hasFeature(combination.type, 'expenses') &&
          combination.type === ProjectType.REFORMA &&
          userCanAccessProject(actor.role, combination.projects, targetProjectId) &&
          userCanAccessProjectModule(
            actor.role,
            [],
            combination.modules,
            combination.type,
            EXPENSE_MODULE,
          ),
      }));
      expect(mayPrepareOrExecute).toEqual([
        { label: 'navigation only', allowed: false },
        { label: 'product capability only', allowed: false },
        { label: 'module without project grant', allowed: false },
        { label: 'project grant without module', allowed: false },
        { label: 'both valid', allowed: true },
      ]);

      // Navigation is intentionally absent: it is presentation, never authority.
      expect(adapter).not.toContain('PROJECT_NAV');
      // The release gate is the conjunction of project type, product capability,
      // current project grant, and the concrete expenses module.
      expect(adapter).toContain('ProjectType.REFORMA');
      expect(adapter).toContain('hasFeature(');
      expect(adapter).toContain('EXPENSE_MODULE');
      expect(adapter).toContain('userCanAccessProject(');
      expect(adapter).toContain('userCanAccessProjectModule(');
    });
  });

  describe('SEC1 — JWT sv/exp are compared, never refreshed', () => {
    it('rejects a sessionVersion that changed after admission on every operation', async () => {
      const own = await seedSession(setup, world, { ownerUserId: world.users.restricted.id });
      const oldAuth = authFor(world.users.restricted);
      await setup.user.update({ where: { id: world.users.restricted.id }, data: { sessionVersion: { increment: 1 } } });
      const requestId = randomUUID();
      const outcomes = await Promise.all([
        rejection(service.create(oldAuth, createBody(world.cards.pessoal, requestId), mintGrant(issuer, oldAuth, createScope(world.cards.pessoal, requestId)))),
        rejection(service.getSession(oldAuth, own.id)),
        rejection(service.getResult(oldAuth, own.id)),
        rejection(service.cancel(oldAuth, own.id, { expectedRevision: 1 }, mintGrant(issuer, oldAuth, { operation: 'CANCEL_SESSION', sessionId: own.id, expectedRevision: 1 }))),
      ]);
      for (const outcome of outcomes) expect(wire(outcome)).toEqual({ code: 'UNAUTHENTICATED', retryable: false, sessionId: null, currentRevision: null, reason: null });
      expect(await sessionCount()).toBe(1);
      expect((await setup.importSession.findUniqueOrThrow({ where: { id: own.id } })).state).toBe('DRAFT');
    });

    it('does not replace the presented version by the current one (a matching version is required)', async () => {
      await setup.user.update({ where: { id: world.users.restricted.id }, data: { sessionVersion: 3 } });
      const presentedLower = authFor(world.users.restricted, { sessionVersion: 2 });
      const presentedHigher = authFor(world.users.restricted, { sessionVersion: 4 });
      for (const auth of [presentedLower, presentedHigher]) {
        const requestId = randomUUID();
        const error = await rejection(service.create(auth, createBody(world.cards.pessoal, requestId), mintGrant(issuer, auth, createScope(world.cards.pessoal, requestId))));
        expect(wire(error).code).toBe('UNAUTHENTICATED');
      }
      // Control: the exact version is admitted.
      const ok = await createAs(world.users.restricted, world.cards.pessoal, randomUUID(), { sessionVersion: 3 });
      expect(ok.created).toBe(true);
    });

    it('legacy tokens without sv are version 0 and stay valid for a version-0 user', async () => {
      const result = await createAs(world.users.restricted, world.cards.pessoal, randomUUID(), { sessionVersion: 0 });
      expect(result.view.state).toBe('DRAFT');
    });

    it('accepts now = exp - 1ms and rejects exp = now and exp < now', async () => {
      const at = (deltaMs: number) => ({ expiresAt: new Date(FIXED_NOW.getTime() + deltaMs) });
      const accepted = await createAs(world.users.restricted, world.cards.pessoal, randomUUID(), at(1));
      expect(accepted.created).toBe(true);
      for (const delta of [0, -1, -60_000]) {
        const error = await rejection(createAs(world.users.restricted, world.cards.pessoal, randomUUID(), at(delta)));
        expect(wire(error).code).toBe('UNAUTHENTICATED');
      }
      expect(await sessionCount()).toBe(1);
    });

    it.each([['empty', ''], ['garbage', 'not-a-date'], ['no milliseconds', '2027-01-01T00:00:00Z'], ['offset instead of Z', '2027-01-01T00:00:00.000+00:00']])(
      'rejects a malformed tokenExpiresAt (%s)',
      async (_label, tokenExpiresAt) => {
        const auth = { ...authFor(world.users.restricted), tokenExpiresAt };
        const requestId = randomUUID();
        const error = await rejection(service.create(auth, createBody(world.cards.pessoal, requestId), mintGrant(issuer, auth, createScope(world.cards.pessoal, requestId))));
        expect(wire(error).code).toBe('UNAUTHENTICATED');
        expect(await sessionCount()).toBe(0);
      },
    );

    it('rejects a context whose tenant is not the user tenant', async () => {
      const auth = { ...authFor(world.users.restricted), tenantId: world.otherTenantId };
      const requestId = randomUUID();
      const error = await rejection(service.create(auth, createBody(world.cards.pessoal, requestId), mintGrant(issuer, auth, createScope(world.cards.pessoal, requestId))));
      expect(wire(error).code).toBe('UNAUTHENTICATED');
    });
  });

  describe('actor validity (same checks as JwtStrategy)', () => {
    const cases: Array<[string, () => Promise<unknown>]> = [
      ['user soft-deleted', () => setup.user.update({ where: { id: world.users.restricted.id }, data: { deletedAt: FIXED_NOW } })],
      ['tenant soft-deleted', () => setup.tenant.update({ where: { id: world.tenantId }, data: { deletedAt: FIXED_NOW } })],
      ['expired guest tenant', async () => {
        await setup.user.update({ where: { id: world.users.restricted.id }, data: { isGuest: true } });
        await setup.tenant.update({ where: { id: world.tenantId }, data: { expiresAt: FIXED_NOW } });
      }],
      ['corrupted allowedModules', () => setup.user.update({ where: { id: world.users.restricted.id }, data: { allowedModules: 'not-json' } })],
      ['corrupted allowedProjects', () => setup.user.update({ where: { id: world.users.restricted.id }, data: { allowedProjects: '{"a":1}' } })],
      ['corrupted allowedProjectTypes', () => setup.user.update({ where: { id: world.users.restricted.id }, data: { allowedProjectTypes: '' } })],
    ];
    it.each(cases)('rejects create/read when %s', async (_label, mutate) => {
      const own = await seedSession(setup, world, { ownerUserId: world.users.restricted.id });
      await mutate();
      const create = await rejection(createAs(world.users.restricted, world.cards.pessoal));
      const read = await rejection(service.getSession(authFor(world.users.restricted), own.id));
      expect(wire(create).code).toBe('UNAUTHENTICATED');
      expect(wire(read).code).toBe('UNAUTHENTICATED');
      expect(await setup.importSession.count({ where: { ownerUserId: world.users.restricted.id } })).toBe(1);
    });

    it('keeps the JWT semantics for a NON-expired guest with valid ACL and quota (no new deny)', async () => {
      await setup.user.update({ where: { id: world.users.restricted.id }, data: { isGuest: true } });
      await setup.tenant.update({ where: { id: world.tenantId }, data: { expiresAt: new Date(FIXED_NOW.getTime() + 60_000) } });
      const result = await createAs(world.users.restricted, world.cards.pessoal);
      expect(result.created).toBe(true);
    });
  });

  describe('INT-3 — the authenticated context is a runtime capability, not a shape', () => {
    const forgeries = (): Array<[string, () => ReturnType<typeof authFor>]> => [
      ['a hand-built plain object', () => forgedAuthFor(world.users.owner)],
      ['a spread copy of a genuine context', () => ({ ...authFor(world.users.owner) })],
      ['a JSON clone of a genuine context', () => JSON.parse(JSON.stringify(authFor(world.users.owner)))],
      ['Object.create of a genuine context', () => Object.create(authFor(world.users.owner))],
    ];

    it.each(forgeries())('refuses %s on create, read, result and cancel with UNAUTHENTICATED and no effect', async (_label, forge) => {
      const seeded = await seedSession(setup, world, { ownerUserId: world.users.owner.id });
      const genuine = authFor(world.users.owner);
      const forged = forge();
      const requestId = randomUUID();
      // The grant is even genuine for the GENUINE context and the same scope: the forged one is still refused.
      const createGrant = mintGrant(issuer, forged, createScope(world.cards.pessoal, requestId));
      const cancelGrant = mintGrant(issuer, forged, { operation: 'CANCEL_SESSION', sessionId: seeded.id, expectedRevision: 1 });
      expect(genuine).not.toBe(forged);
      const codes = [
        wire(await rejection(service.create(forged, createBody(world.cards.pessoal, requestId), createGrant))).code,
        wire(await rejection(service.getSession(forged, seeded.id))).code,
        wire(await rejection(service.getResult(forged, seeded.id))).code,
        wire(await rejection(service.cancel(forged, seeded.id, { expectedRevision: 1 }, cancelGrant))).code,
      ];
      expect(codes).toEqual(['UNAUTHENTICATED', 'UNAUTHENTICATED', 'UNAUTHENTICATED', 'UNAUTHENTICATED']);
      expect(await setup.importSession.count({ where: { tenantId: world.tenantId } })).toBe(1);
      expect((await setup.importSession.findUniqueOrThrow({ where: { id: seeded.id } })).state).toBe('DRAFT');
    });

    it('a genuine context works, and a context of another user cannot be relabelled by editing a copy', async () => {
      const seeded = await seedSession(setup, world, { ownerUserId: world.users.owner.id });
      const genuinePeer = authFor(world.users.peer);
      const relabelled = { ...genuinePeer, userId: world.users.owner.id };
      expect(wire(await rejection(service.getSession(relabelled, seeded.id))).code).toBe('UNAUTHENTICATED');
      expect((await service.getSession(authFor(world.users.owner), seeded.id)).id).toBe(seeded.id);
    });

    it('cancel needs a verified CANCEL grant in the service itself, not only in the HTTP guard', async () => {
      const seeded = await seedSession(setup, world, { ownerUserId: world.users.owner.id });
      const auth = authFor(world.users.owner);
      for (const grant of [undefined, {}, mintGrant(issuer, auth, createScope(world.cards.pessoal, randomUUID()))]) {
        expect(wire(await rejection(service.cancel(auth, seeded.id, { expectedRevision: 1 }, grant))).code).toBe('UI_ACTION_REQUIRED');
      }
      expect((await setup.importSession.findUniqueOrThrow({ where: { id: seeded.id } })).state).toBe('DRAFT');
    });
  });

  describe('session ownership is opaque', () => {
    it('answers the same NOT_FOUND for another user, another tenant and a missing id', async () => {
      const others = await seedSession(setup, world, { ownerUserId: world.users.peer.id });
      const foreignSession = await seedSession(setup, world, { ownerUserId: world.users.owner.id });
      const actor = world.users.restricted;
      const auth = authFor(actor);
      const ids = [others.id, foreignSession.id, randomUUID()];
      const cancelGrant = (id: string) => mintGrant(issuer, auth, { operation: 'CANCEL_SESSION', sessionId: id, expectedRevision: 1 });
      const results = [];
      for (const id of ids) {
        results.push([
          wire(await rejection(service.getSession(auth, id))),
          wire(await rejection(service.getResult(auth, id))),
          wire(await rejection(service.cancel(auth, id, { expectedRevision: 1 }, cancelGrant(id)))),
        ]);
      }
      const expected = { code: 'NOT_FOUND', retryable: false, sessionId: null, currentRevision: null, reason: null };
      for (const row of results) expect(row).toEqual([expected, expected, expected]);
      // Other tenant's actor cannot see it either.
      const foreignAuth = authFor(world.users.foreign);
      expect(wire(await rejection(service.getSession(foreignAuth, others.id))).code).toBe('NOT_FOUND');
      expect((await setup.importSession.findUniqueOrThrow({ where: { id: others.id } })).state).toBe('DRAFT');
    });

    it('a full-access role (OWNER/ADMIN class) of the same tenant still cannot touch ANOTHER owner\'s session', async () => {
      const others = await seedSession(setup, world, { ownerUserId: world.users.peer.id });
      const auth = authFor(world.users.owner);
      const grant = mintGrant(issuer, auth, { operation: 'CANCEL_SESSION', sessionId: others.id, expectedRevision: 1 });
      const expected = { code: 'NOT_FOUND', retryable: false, sessionId: null, currentRevision: null, reason: null };
      expect(wire(await rejection(service.getSession(auth, others.id)))).toEqual(expected);
      expect(wire(await rejection(service.getResult(auth, others.id)))).toEqual(expected);
      expect(wire(await rejection(service.cancel(auth, others.id, { expectedRevision: 1 }, grant)))).toEqual(expected);
      expect((await setup.importSession.findUniqueOrThrow({ where: { id: others.id } })).state).toBe('DRAFT');
    });

    it('rejects a malformed session id as INVALID_INPUT before touching the database', async () => {
      const error = await rejection(service.getSession(authFor(world.users.owner), 'bad/id'));
      expect(wire(error).code).toBe('INVALID_INPUT');
    });
  });

  describe('card ACL on create', () => {
    const blocked: Array<[string, () => Promise<{ actor: ImportWorld['users']['owner']; cardId: string }>]> = [
      ['card of a project outside allowedProjects', async () => ({ actor: world.users.restricted, cardId: world.cards.casa })],
      ['creditCards module missing', async () => {
        await setup.user.update({ where: { id: world.users.restricted.id }, data: { allowedModules: JSON.stringify(['expenses']) } });
        return { actor: world.users.restricted, cardId: world.cards.pessoal };
      }],
      ['only an unrelated module of the same type (maintenance)', async () => {
        await setup.user.update({ where: { id: world.users.restricted.id }, data: { allowedModules: JSON.stringify(['maintenance']) } });
        return { actor: world.users.restricted, cardId: world.cards.pessoal };
      }],
      ['card soft-deleted', async () => {
        await setup.creditCard.update({ where: { id: world.cards.pessoal }, data: { deletedAt: FIXED_NOW } });
        return { actor: world.users.owner, cardId: world.cards.pessoal };
      }],
      ['project soft-deleted (unrestricted actor)', async () => {
        await setup.project.update({ where: { id: world.projects.pessoal }, data: { deletedAt: FIXED_NOW } });
        return { actor: world.users.owner, cardId: world.cards.pessoal };
      }],
      ['card of another tenant', async () => ({ actor: world.users.owner, cardId: world.cards.foreign })],
      ['unknown card', async () => ({ actor: world.users.owner, cardId: 'card-that-does-not-exist' })],
    ];
    it.each(blocked)('answers an identical NOT_FOUND and writes nothing: %s', async (_label, arrange) => {
      const { actor, cardId } = await arrange();
      const error = await rejection(createAs(actor, cardId));
      expect(wire(error)).toEqual({ code: 'NOT_FOUND', retryable: false, sessionId: null, currentRevision: null, reason: null });
      expect(await sessionCount()).toBe(0);
    });

    it('rejects_even_an_OWNER_card_outside_a_PESSOAL_project', async () => {
      const failure = await rejection(
        createAs(world.users.owner, world.cards.casa),
      );
      expect(wire(failure).code).toBe('INVALID_INPUT');
    });

    it('resolves the owner project on the server from the card', async () => {
      const result = await createAs(world.users.restricted, world.cards.pessoal);
      const row = await setup.importSession.findUniqueOrThrow({ where: { id: result.view.id } });
      expect(row).toMatchObject({
        tenantId: world.tenantId,
        ownerUserId: world.users.restricted.id,
        ownerProjectId: world.projects.pessoal,
        cardId: world.cards.pessoal,
      });
    });
  });

  describe('strict runtime validation (no silent ignoring of extras)', () => {
    const base = () => createBody(world.cards.pessoal);
    const without = (key: string) => {
      const body = base();
      delete body[key];
      return body;
    };
    const invalid: Array<[string, () => unknown]> = [
      ['extra ownerProjectId', () => ({ ...base(), ownerProjectId: 'some-project' })],
      ['extra projectId', () => ({ ...base(), projectId: 'some-project' })],
      ['extra unknown field', () => ({ ...base(), foo: 1 })],
      ['own __proto__ key', () => JSON.parse(`{"version":1,"createRequestId":"${randomUUID()}","cardId":"${world.cards.pessoal}","consentPolicyVersion":1,"consentAnalyze":true,"__proto__":{"x":1}}`)],
      ['missing consentAnalyze', () => without('consentAnalyze')],
      ['missing cardId', () => without('cardId')],
      ['consentAnalyze false', () => ({ ...base(), consentAnalyze: false })],
      ['consentAnalyze string', () => ({ ...base(), consentAnalyze: 'true' })],
      ['consentPolicyVersion 2', () => ({ ...base(), consentPolicyVersion: 2 })],
      ['version 2', () => ({ ...base(), version: 2 })],
      ['createRequestId not uuid v4', () => ({ ...base(), createRequestId: 'dev-tenant-1' })],
      ['cardId with slash', () => ({ ...base(), cardId: 'bad/id' })],
      ['cardId number', () => ({ ...base(), cardId: 7 })],
      ['array body', () => []],
      ['null body', () => null],
      ['string body', () => 'x'],
    ];
    it.each(invalid)('answers INVALID_INPUT and writes nothing: %s', async (_label, makeBody) => {
      const auth = authFor(world.users.restricted);
      const grant = mintGrant(issuer, auth, createScope(world.cards.pessoal, randomUUID()));
      const error = await rejection(service.create(auth, makeBody(), grant));
      expect(wire(error)).toEqual({ code: 'INVALID_INPUT', retryable: false, sessionId: null, currentRevision: null, reason: null });
      expect(await sessionCount()).toBe(0);
    });

    it('rejects an unknown extra on the cancel body as well', async () => {
      const seeded = await seedSession(setup, world, { ownerUserId: world.users.restricted.id });
      const auth = authFor(world.users.restricted);
      const grant = mintGrant(issuer, auth, { operation: 'CANCEL_SESSION', sessionId: seeded.id, expectedRevision: 1 });
      const error = await rejection(service.cancel(auth, seeded.id, { expectedRevision: 1, ownerProjectId: 'x' }, grant));
      expect(wire(error).code).toBe('INVALID_INPUT');
      expect((await setup.importSession.findUniqueOrThrow({ where: { id: seeded.id } })).state).toBe('DRAFT');
    });
  });

  describe('idempotency', () => {
    it('replays the identical create with the same session, no new row and no revision bump', async () => {
      const requestId = randomUUID();
      const first = await createAs(world.users.restricted, world.cards.pessoal, requestId);
      const second = await createAs(world.users.restricted, world.cards.pessoal, requestId);
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.view).toEqual(first.view);
      expect(await sessionCount()).toBe(1);
    });

    it('answers IDEMPOTENCY_CONFLICT for the same key with another payload', async () => {
      const requestId = randomUUID();
      await createAs(world.users.owner, world.cards.pessoal, requestId);
      const error = await rejection(createAs(world.users.owner, world.cards.casa, requestId));
      expect(wire(error).code).toBe('IDEMPOTENCY_CONFLICT');
      expect(await sessionCount()).toBe(1);
    });

    it('scopes the key per user: another user with the same key creates their own session', async () => {
      const requestId = randomUUID();
      const a = await createAs(world.users.restricted, world.cards.pessoal, requestId);
      const b = await createAs(world.users.peer, world.cards.pessoal, requestId);
      expect(a.view.id).not.toBe(b.view.id);
    });

    it('collapses a concurrent double create into one session', async () => {
      const requestId = randomUUID();
      const results = await Promise.all([
        createAs(world.users.restricted, world.cards.pessoal, requestId),
        createAs(world.users.restricted, world.cards.pessoal, requestId),
      ]);
      expect(results[0].view.id).toBe(results[1].view.id);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(await sessionCount()).toBe(1);
    });

    it('replay with the same key/payload neither writes nor renews the deadline, even with the quota full or the session terminal', async () => {
      const requestId = randomUUID();
      const first = await createAs(world.users.restricted, world.cards.pessoal, requestId);
      await createAs(world.users.restricted, world.cards.pessoal);
      await createAs(world.users.restricted, world.cards.pessoal); // quota (3) is now full
      const before = await setup.importSession.findUniqueOrThrow({ where: { id: first.view.id } });
      clock.current = new Date(FIXED_NOW.getTime() + 60_000);
      const replay = await createAs(world.users.restricted, world.cards.pessoal, requestId, { expiresAt: new Date(FIXED_NOW.getTime() + 2 * 60_000) });
      expect(replay).toMatchObject({ created: false });
      expect(replay.view.id).toBe(first.view.id);
      expect(await setup.importSession.findUniqueOrThrow({ where: { id: first.view.id } })).toEqual(before);
      expect(await sessionCount()).toBe(3);

      // Terminal: the replay returns the terminal session, creates no replacement.
      await setup.importSession.update({ where: { id: first.view.id }, data: { state: 'CANCELLED', closedAt: FIXED_NOW } });
      const afterTerminal = await setup.importSession.findUniqueOrThrow({ where: { id: first.view.id } });
      const terminalReplay = await createAs(world.users.restricted, world.cards.pessoal, requestId, { expiresAt: new Date(FIXED_NOW.getTime() + 2 * 60_000) });
      expect(terminalReplay).toMatchObject({ created: false });
      expect(terminalReplay.view).toMatchObject({ id: first.view.id, state: 'CANCELLED', expiresAt: null });
      expect(await setup.importSession.findUniqueOrThrow({ where: { id: first.view.id } })).toEqual(afterTerminal);
      expect(await sessionCount()).toBe(3);
    });

    it('does not replay after the ACL was revoked (fail closed)', async () => {
      const requestId = randomUUID();
      await createAs(world.users.restricted, world.cards.pessoal, requestId);
      await setup.user.update({ where: { id: world.users.restricted.id }, data: { allowedModules: JSON.stringify(['expenses']) } });
      const error = await rejection(createAs(world.users.restricted, world.cards.pessoal, requestId));
      expect(wire(error).code).toBe('NOT_FOUND');
    });

    it.each(['bound card', 'APPLIED participant'] as const)(
      'authorizes an existing session before identical replay or idempotency conflict after %s access loss',
      async (lostAccess) => {
        const runtime = {};
        const intakeGate = {
          boot: {
            state: () => 'ON',
            stopped: new AbortController().signal,
            runtime: () => runtime,
            recheckLock: async () => ({ ok: true, runtime }),
          },
        } as unknown as ImportVaultGate;
        const enabled = {
          writesEnabled: () => true,
          newImportFormats: () => ['CSV'] as const,
        };
        const replayService = new ImportSessionService(
          prisma,
          clock,
          enabled,
          new RuntimeUiGrantVerifier(),
          ...rawTestDependencies(intakeGate, clock, enabled),
        );
        const replayAs = (cardId: string, createRequestId: string) => {
          const auth = authFor(world.users.restricted);
          return replayService.create(
            auth,
            createBody(cardId, createRequestId),
            mintGrant(issuer, auth, createScope(cardId, createRequestId)),
          );
        };
        const requestId = randomUUID();
        const first = await replayAs(world.cards.pessoal, requestId);

        if (lostAccess === 'bound card') {
          await setup.creditCard.update({
            where: { id: world.cards.pessoal },
            data: { deletedAt: FIXED_NOW },
          });
        } else {
          const receipt = VALID_RECEIPT(
            first.view.id,
            ['historical-source-expense'],
            [world.projects.pessoal, world.projects.casa],
          );
          await setup.importSession.update({
            where: { id: first.view.id },
            data: {
              state: 'APPLIED',
              financialRequestId: receipt.financialRequestId,
              confirmedRevision: receipt.confirmedRevision,
              confirmedSessionVersion: 0,
              confirmedAt: FIXED_NOW,
              proposalHash: receipt.proposalHash,
              receiptJson: JSON.stringify(receipt),
              closedAt: FIXED_NOW,
            },
          });
        }

        const before = await setup.importSession.findUniqueOrThrow({
          where: { id: first.view.id },
        });
        const countBefore = await sessionCount();
        try {
          const outcome = async (run: Promise<unknown>) => {
            try {
              await run;
              return { code: 'RESOLVED', serialized: '' };
            } catch (error) {
              return {
                code: wire(error).code,
                serialized: JSON.stringify(error),
              };
            }
          };
          const replay = await outcome(replayAs(world.cards.pessoal, requestId));
          const conflict = await outcome(replayAs(world.cards.casa, requestId));
          expect([replay.code, conflict.code]).toEqual([
            'NOT_FOUND',
            'NOT_FOUND',
          ]);
          for (const { serialized } of [replay, conflict]) {
            expect(serialized).not.toContain('historical-source-expense');
            expect(serialized).not.toContain(world.projects.casa);
          }
          expect(await sessionCount()).toBe(countBefore);
          expect(
            await setup.importSession.findUniqueOrThrow({
              where: { id: first.view.id },
            }),
          ).toEqual(before);
        } finally {
          if (lostAccess === 'bound card') {
            await setup.creditCard.update({
              where: { id: world.cards.pessoal },
              data: { deletedAt: null },
            });
          }
        }
      },
    );
  });

  describe('quota (non-terminal and not expired)', () => {
    it('allows 3 active sessions per user and rejects the 4th; terminal or expired ones do not count', async () => {
      for (let i = 0; i < 3; i++) await createAs(world.users.restricted, world.cards.pessoal);
      const fourth = await rejection(createAs(world.users.restricted, world.cards.pessoal));
      expect(wire(fourth).code).toBe('LIMIT_EXCEEDED');
      expect(await sessionCount()).toBe(3);

      const [one, two] = await setup.importSession.findMany({ where: { ownerUserId: world.users.restricted.id }, orderBy: { id: 'asc' } });
      await setup.importSession.update({ where: { id: one.id }, data: { state: 'CANCELLED', closedAt: FIXED_NOW } });
      expect((await createAs(world.users.restricted, world.cards.pessoal)).created).toBe(true);
      expect(wire(await rejection(createAs(world.users.restricted, world.cards.pessoal))).code).toBe('LIMIT_EXCEEDED');

      clock.current = new Date(two.expiresAt);
      // `now >= expiresAt` frees that session's slot (non-terminal but expired).
      expect((await createAs(world.users.restricted, world.cards.pessoal, randomUUID(), { expiresAt: new Date(clock.current.getTime() + 60_000) })).created).toBe(true);
    });

    it('never exceeds 3 under concurrent creates from the same user', async () => {
      const outcomes = await Promise.allSettled(Array.from({ length: 6 }, () => createAs(world.users.peer, world.cards.pessoal)));
      const ok = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
      expect(ok).toHaveLength(3);
      for (const r of rejected) expect(wire(r.reason).code).toBe('LIMIT_EXCEEDED');
      expect(await setup.importSession.count({ where: { ownerUserId: world.users.peer.id } })).toBe(3);
    });

    it('never exceeds 3 across independent connections (two pools ~ two API processes)', async () => {
      // Prisma serializes interactive transactions inside ONE client on SQLite, so use a second
      // client with its own connection: the quota must hold when the writers do not share a pool.
      const other = new PrismaService();
      await other.onModuleInit();
      try {
        const gate = vault.createGate(other, clock);
        if (!(gate instanceof ImportVaultGate))
          throw new Error("Expected real vault gate");
        await gate.boot.settled;
        const otherService = new ImportSessionService(
          other,
          clock,
          capability,
          new RuntimeUiGrantVerifier(),
          ...rawTestDependencies(gate, clock, capability),
        );
        const via = (svc: ImportSessionService) => {
          const requestId = randomUUID();
          const auth = authFor(world.users.peer);
          return svc.create(auth, createBody(world.cards.pessoal, requestId), mintGrant(issuer, auth, createScope(world.cards.pessoal, requestId)));
        };
        const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => via(i % 2 === 0 ? service : otherService)));
        const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
        for (const r of rejected) expect(['LIMIT_EXCEEDED', 'RETRYABLE_WRITE_CONFLICT']).toContain(wire(r.reason).code);
        expect(await setup.importSession.count({ where: { ownerUserId: world.users.peer.id } })).toBeLessThanOrEqual(3);
        expect(outcomes.filter((o) => o.status === 'fulfilled').length).toBe(await setup.importSession.count({ where: { ownerUserId: world.users.peer.id } }));
      } finally {
        await other.onModuleDestroy();
      }
    });

    it('caps 20 active sessions per tenant', async () => {
      for (let i = 0; i < 20; i++) await seedSession(setup, world, { ownerUserId: world.users.owner.id });
      const error = await rejection(createAs(world.users.restricted, world.cards.pessoal));
      expect(wire(error).code).toBe('LIMIT_EXCEEDED');
      await setup.importSession.updateMany({ where: { tenantId: world.tenantId }, data: { expiresAt: FIXED_NOW } });
      expect((await createAs(world.users.restricted, world.cards.pessoal)).created).toBe(true);
    });
  });

  describe('what a created session stores', () => {
    it('records consent, the 7-day deadline, an empty draft with server-owned scope and a server UUIDv4', async () => {
      const requestId = randomUUID();
      const { view } = await createAs(world.users.restricted, world.cards.pessoal, requestId);
      expect(view.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(view.id).not.toBe(requestId);
      const row = await setup.importSession.findUniqueOrThrow({ where: { id: view.id } });
      expect(row).toMatchObject({
        state: 'DRAFT',
        revision: 1,
        protocolVersion: 1,
        kind: 'CREATE_CARD_PURCHASES',
        consentPolicyVersion: 1,
        createRequestId: requestId,
        draftJson: EMPTY_DRAFT_JSON,
        searchJson: null,
        proposalJson: null,
        proposalHash: null,
        preflightHash: null,
        challengeJson: null,
        prepareLeaseJson: null,
        financialRequestId: null,
        receiptJson: null,
        closedAt: null,
        prepareGeneration: 0,
      });
      expect(row.consentedAt).toEqual(FIXED_NOW);
      expect(row.lastUserEditAt).toEqual(FIXED_NOW);
      expect(row.expiresAt).toEqual(new Date(FIXED_NOW.getTime() + SEVEN_DAYS_MS));
      expect(row.createPayloadHash).toMatch(/^[0-9a-f]{64}$/);
      expect(view.expiresAt).toBe(new Date(FIXED_NOW.getTime() + SEVEN_DAYS_MS).toISOString());
    });
  });
});
