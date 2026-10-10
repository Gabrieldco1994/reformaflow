/**
 * Test-only fixtures for the import-session intake specs (B1a). No Nest testing
 * module and no jest globals here: it only seeds a disposable SQLite database
 * through a RAW PrismaClient (no soft-delete middleware) and mints internal
 * authority objects the same way the HTTP boundary does.
 */
import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  AuthenticatedImportContext,
  UiImportGrantScope,
} from '../imports/import-session/import-session.contract';
import type { ImportUiGrantIssuer } from '../imports/import-session/import-session-ui-grant';
import type { ImportSessionClock } from '../imports/import-session/import-session.capability';
import { mintImportAuthContext } from '../imports/import-session/import-session.auth';

export const FIXED_NOW = new Date('2026-09-28T15:00:00.000Z');
export const SEVEN_DAYS_MS = 604_800_000;
/** Literal on purpose: the cleanup/empty draft shape is pinned independently of production code. */
export const EMPTY_DRAFT_JSON =
  '{"version":1,"lines":[],"selectedLineIds":[],"questions":[],"scope":{"observationIds":[],"pendingAttachmentIds":[]}}';

export class MutableClock implements ImportSessionClock {
  constructor(public current: Date = FIXED_NOW) {}
  now(): Date {
    return new Date(this.current);
  }
}

export interface WorldUser {
  id: string;
  tenantId: string;
  sessionVersion: number;
}

export interface ImportWorld {
  prefix: string;
  tenantId: string;
  otherTenantId: string;
  users: {
    /** role OWNER: unrestricted inside the tenant. */
    owner: WorldUser;
    /** role USER, only PESSOAL project, creditCards+expenses. */
    restricted: WorldUser;
    /** role USER with the same grants as `restricted` (second actor). */
    peer: WorldUser;
    foreign: WorldUser;
  };
  projects: { pessoal: string; casa: string; foreign: string };
  cards: { pessoal: string; casa: string; foreign: string };
}

const tenantIds = (prefix: string) => [`${prefix}-t1`, `${prefix}-t2`];

export async function cleanupImportWorld(
  setup: PrismaClient,
  prefix: string,
): Promise<void> {
  const tenants = tenantIds(prefix);
  const scope = { tenantId: { in: tenants } };
  await setup.importObservation.deleteMany({ where: scope });
  await setup.importSessionArtifact.deleteMany({ where: scope });
  await setup.importArtifact.deleteMany({ where: scope });
  await setup.importSession.deleteMany({ where: scope });
  await setup.expense.deleteMany({ where: scope });
  await setup.creditCard.deleteMany({ where: scope });
  await setup.project.deleteMany({ where: scope });
  await setup.userActivityLog.deleteMany({ where: scope });
  await setup.user.deleteMany({ where: scope });
  await setup.tenant.deleteMany({ where: { id: { in: tenants } } });
}

export async function seedImportWorld(
  setup: PrismaClient,
  prefix: string,
): Promise<ImportWorld> {
  await cleanupImportWorld(setup, prefix);
  const [tenantId, otherTenantId] = tenantIds(prefix);
  await setup.tenant.createMany({
    data: [
      { id: tenantId, name: `${prefix} tenant` },
      { id: otherTenantId, name: `${prefix} other tenant` },
    ],
  });
  const restrictedGrants = {
    allowedModules: JSON.stringify(['creditCards', 'expenses']),
    // Empty types = legacy wildcard: reconcileUserModules then leaves the owned modules alone,
    // so module revocation in the specs is meaningful.
    allowedProjectTypes: '[]',
  };
  const user = async (
    id: string,
    tenant: string,
    role: string,
    extra: Partial<Prisma.UserUncheckedCreateInput> = {},
  ): Promise<WorldUser> => {
    const row = await setup.user.create({
      data: {
        id,
        tenantId: tenant,
        username: id,
        name: id,
        role,
        ...extra,
      },
    });
    return {
      id: row.id,
      tenantId: row.tenantId,
      sessionVersion: row.sessionVersion,
    };
  };
  const projects = {
    pessoal: `${prefix}-p-pessoal`,
    casa: `${prefix}-p-casa`,
    foreign: `${prefix}-p-foreign`,
  };
  await setup.project.createMany({
    data: [
      {
        id: projects.pessoal,
        tenantId,
        type: 'PESSOAL',
        name: 'Pessoal',
      },
      { id: projects.casa, tenantId, type: 'CASA', name: 'Casa' },
      {
        id: projects.foreign,
        tenantId: otherTenantId,
        type: 'PESSOAL',
        name: 'Foreign',
      },
    ],
  });
  const cards = {
    pessoal: `${prefix}-c-pessoal`,
    casa: `${prefix}-c-casa`,
    foreign: `${prefix}-c-foreign`,
  };
  const card = (id: string, tenant: string, projectId: string) => ({
    id,
    tenantId: tenant,
    projectId,
    institution: 'ITAU',
    nickname: id,
    last4: '1234',
  });
  await setup.creditCard.createMany({
    data: [
      card(cards.pessoal, tenantId, projects.pessoal),
      card(cards.casa, tenantId, projects.casa),
      card(cards.foreign, otherTenantId, projects.foreign),
    ],
  });
  const users = {
    owner: await user(`${prefix}-u-owner`, tenantId, 'OWNER'),
    restricted: await user(`${prefix}-u-restricted`, tenantId, 'USER', {
      ...restrictedGrants,
      allowedProjects: JSON.stringify([projects.pessoal]),
    }),
    peer: await user(`${prefix}-u-peer`, tenantId, 'USER', {
      ...restrictedGrants,
      allowedProjects: JSON.stringify([projects.pessoal]),
    }),
    foreign: await user(`${prefix}-u-foreign`, otherTenantId, 'OWNER'),
  };
  return { prefix, tenantId, otherTenantId, users, projects, cards };
}

function authClaimsFor(
  user: WorldUser,
  options: { expiresAt?: Date; sessionVersion?: number } = {},
): AuthenticatedImportContext {
  return {
    tenantId: user.tenantId,
    userId: user.id,
    presentedSessionVersion: options.sessionVersion ?? user.sessionVersion,
    tokenExpiresAt: (
      options.expiresAt ?? new Date(FIXED_NOW.getTime() + SEVEN_DAYS_MS)
    ).toISOString(),
  };
}

/** A context minted exactly like the verified-JWT boundary (runtime-branded). */
export function authFor(
  user: WorldUser,
  options: { expiresAt?: Date; sessionVersion?: number } = {},
): AuthenticatedImportContext {
  return mintImportAuthContext(authClaimsFor(user, options));
}

/** A structurally identical context that never went through the boundary: must be refused. */
export function forgedAuthFor(
  user: WorldUser,
  options: { expiresAt?: Date; sessionVersion?: number } = {},
): AuthenticatedImportContext {
  return authClaimsFor(user, options);
}

/** Mints a grant exactly like the HTTP boundary: a UI-attested request first, then issue. */
export function mintGrant(
  issuer: ImportUiGrantIssuer,
  auth: AuthenticatedImportContext,
  scope: UiImportGrantScope,
): unknown {
  const request = {};
  issuer.attestRequest(request);
  return issuer.issue(request, auth, scope);
}

export function createScope(
  cardId: string,
  createRequestId: string,
): UiImportGrantScope {
  return { operation: 'CREATE_SESSION', cardId, createRequestId, consentPolicyVersion: 1 };
}

export function createBody(
  cardId: string,
  createRequestId: string = randomUUID(),
): Record<string, unknown> {
  return {
    version: 1,
    createRequestId,
    cardId,
    consentPolicyVersion: 1,
    consentAnalyze: true,
  };
}

export type SessionSeed = Partial<Prisma.ImportSessionUncheckedCreateInput>;

export async function seedSession(
  setup: PrismaClient,
  world: ImportWorld,
  overrides: SessionSeed = {},
) {
  const ownerUserId = overrides.ownerUserId ?? world.users.owner.id;
  const cardId = overrides.cardId ?? world.cards.pessoal;
  return setup.importSession.create({
    data: {
      id: randomUUID(),
      tenantId: world.tenantId,
      ownerUserId,
      ownerProjectId: world.projects.pessoal,
      cardId,
      kind: 'CREATE_CARD_PURCHASES',
      state: 'DRAFT',
      revision: 1,
      createRequestId: randomUUID(),
      createPayloadHash: 'a'.repeat(64),
      consentPolicyVersion: 1,
      consentedAt: FIXED_NOW,
      lastUserEditAt: FIXED_NOW,
      expiresAt: new Date(FIXED_NOW.getTime() + SEVEN_DAYS_MS),
      draftJson: EMPTY_DRAFT_JSON,
      // The SQL applied-check demands a receipt at insert time; specs overwrite it afterwards.
      ...(overrides.state === 'APPLIED' && overrides.receiptJson === undefined
        ? { receiptJson: '{}' }
        : {}),
      ...overrides,
    },
  });
}

/**
 * Receipt v1 (snapshot mandatory). `projectIds[0]` is the source project of the single CREATED
 * line, the rest are its targets; the session anchor (pessoal) must be among them.
 */
export const VALID_RECEIPT = (
  sessionId: string,
  expenseIds: string[],
  projectIds: string[],
) => ({
  version: 1,
  sessionId,
  financialRequestId: '123e4567-e89b-42d3-a456-426614174000',
  confirmedRevision: 1,
  proposalHash: 'b'.repeat(64),
  appliedAt: FIXED_NOW.toISOString(),
  continuationSessionId: null,
  items: [
    {
      lineId: 'line-1',
      outcome: 'CREATED',
      sourceExpenseId: expenseIds[0],
      targetExpenseIds: expenseIds.slice(1),
      allocationIds: [],
      cashFlowEntryIds: [],
    },
  ],
  auditItems: [],
  snapshot: {
    lines: [
      {
        lineId: 'line-1',
        titulo: 'Compra',
        dataCompra: '2026-09-10',
        totalCents: 10000,
        schedule: {
          version: 1,
          occurrences: [
            {
              index: 0,
              parcela: null,
              valor: 10000,
              data: '2026-09-10',
              invoiceDueMonth: '2026-10',
            },
          ],
        },
        sourceProjectId: projectIds[0],
        targets: projectIds
          .slice(1)
          .map((projectId) => ({ projectId, amountCents: 100 })),
      },
    ],
    participantProjectIds: [...new Set(projectIds)].sort(),
    createdEconomicTotalCents: 10000,
    bankCashDeltaCents: 0,
    invoiceDeltas: [{ invoiceDueMonth: '2026-10', amountCents: 10000 }],
  },
});
