import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  IMPORT_SESSION_PRIMITIVES,
  ImportSessionErrorCode,
  reconcileUserModules,
} from "@reformaflow/domain";
import { parseGrantJson } from "../../auth/grant-json";
import {
  CREDIT_CARD_MODULE,
  EXPENSE_MODULE,
  RECEIPT_MODULE,
  resolveAccessibleProjectScope,
} from "../../common/access-rules";
import type { AuthenticatedImportContext } from "./import-session.contract";
import { ImportSessionError } from "./import-session.errors";

type Db = Pick<Prisma.TransactionClient, "user" | "project" | "creditCard">;

const INSTANT = new RegExp(IMPORT_SESSION_PRIMITIVES.instantPattern);
const notFound = () => new ImportSessionError(ImportSessionErrorCode.NOT_FOUND);
const unauthenticated = () =>
  new ImportSessionError(ImportSessionErrorCode.UNAUTHENTICATED);

const IMPORT_AUTH_CONTEXT = Symbol("IMPORT_AUTH_CONTEXT");

/** Identity of every context ever minted at the verified-JWT boundary. Module-private. */
const MINTED_CONTEXTS = new WeakSet<object>();
const REQUEST_CONTEXTS = new WeakMap<object, AuthenticatedImportContext>();

/**
 * Mints the authenticated context. Its ONLY production caller is `ImportAuthGuard` (verified
 * JWT); the sole other importer is the test harness. An architecture spec pins that list.
 */
export function mintImportAuthContext(
  claims: AuthenticatedImportContext,
): AuthenticatedImportContext {
  const context = Object.freeze({
    tenantId: claims.tenantId,
    userId: claims.userId,
    presentedSessionVersion: claims.presentedSessionVersion,
    tokenExpiresAt: claims.tokenExpiresAt,
  });
  MINTED_CONTEXTS.add(context);
  return context;
}

/** A forged, spread, JSON-cloned or hand-built context has no entry and is UNAUTHENTICATED. */
export function assertMintedImportContext(
  auth: unknown,
): asserts auth is AuthenticatedImportContext {
  if (auth === null || typeof auth !== "object" || !MINTED_CONTEXTS.has(auth)) {
    throw unauthenticated();
  }
}

/** Financial issuance requires the original auth of this exact verified request. */
export function assertImportAuthForRequest(
  request: object,
  auth: AuthenticatedImportContext,
): void {
  assertMintedImportContext(auth);
  if (REQUEST_CONTEXTS.get(request) !== auth) throw unauthenticated();
}

/** Reads only the authority already bound by ImportAuthGuard to this exact request. */
export function readImportAuthForRequest(
  request: object,
): AuthenticatedImportContext {
  const auth = REQUEST_CONTEXTS.get(request);
  if (!auth || Reflect.get(request, IMPORT_AUTH_CONTEXT) !== auth)
    throw unauthenticated();
  assertImportAuthForRequest(request, auth);
  return auth;
}

/**
 * Builds the import authentication context from the VERIFIED JWT (`request.user.authClaims`,
 * filled by `JwtStrategy`): tenant/user from the token subject, `sv` and `exp` as presented.
 * Never from a DTO, a header or a refreshed database value. A token without `exp` is refused
 * here only; legacy routes are untouched.
 */
@Injectable()
export class ImportAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<Record<string | symbol, any>>();
    const user = request?.user;
    const claims = user?.authClaims;
    const exp = claims?.expiresAtEpochSeconds;
    const sv = claims?.sessionVersion;
    if (
      !user ||
      typeof user.id !== "string" ||
      typeof user.tenantId !== "string" ||
      !Number.isInteger(sv) ||
      typeof exp !== "number" ||
      !Number.isFinite(exp)
    ) {
      throw unauthenticated();
    }
    const expiry = new Date(exp * 1000);
    if (!Number.isFinite(expiry.getTime())) throw unauthenticated();
    const existing = REQUEST_CONTEXTS.get(request);
    if (existing) {
      if (
        request[IMPORT_AUTH_CONTEXT] !== existing ||
        existing.tenantId !== user.tenantId ||
        existing.userId !== user.id ||
        existing.presentedSessionVersion !== sv ||
        existing.tokenExpiresAt !== expiry.toISOString()
      ) {
        throw unauthenticated();
      }
      return true;
    }
    if (request[IMPORT_AUTH_CONTEXT] !== undefined) throw unauthenticated();
    const auth = mintImportAuthContext({
      tenantId: user.tenantId,
      userId: user.id,
      presentedSessionVersion: sv as number,
      tokenExpiresAt: expiry.toISOString(),
    });
    REQUEST_CONTEXTS.set(request, auth);
    request[IMPORT_AUTH_CONTEXT] = auth;
    return true;
  }
}

export const ImportAuth = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedImportContext => {
    const request = context
      .switchToHttp()
      .getRequest<Record<symbol, unknown>>();
    const auth = request[IMPORT_AUTH_CONTEXT] as
      | AuthenticatedImportContext
      | undefined;
    if (!auth) throw unauthenticated();
    return auth;
  },
);

export interface ImportActor {
  readonly tenantId: string;
  readonly userId: string;
  readonly role: string;
  readonly allowedModules: string[];
  readonly allowedProjects: string[];
  readonly allowedProjectTypes: string[];
}

/**
 * Re-checks the presented authentication against the CURRENT database, exactly like
 * `JwtStrategy.validate`, plus the token deadline: `exp > now` (now = exp-1ms passes,
 * exp <= now fails) and an EQUAL session version (never replaced by the current one).
 * Any failure is the same UNAUTHENTICATED.
 */
export async function reauthorize(
  db: Pick<Db, "user">,
  auth: AuthenticatedImportContext,
  now: Date,
): Promise<ImportActor> {
  assertMintedImportContext(auth);
  if (
    !auth ||
    typeof auth.tenantId !== "string" ||
    typeof auth.userId !== "string" ||
    !Number.isInteger(auth.presentedSessionVersion) ||
    typeof auth.tokenExpiresAt !== "string" ||
    !INSTANT.test(auth.tokenExpiresAt)
  ) {
    throw unauthenticated();
  }
  const expiresAtMs = Date.parse(auth.tokenExpiresAt);
  if (!Number.isFinite(expiresAtMs) || !(expiresAtMs > now.getTime())) {
    throw unauthenticated();
  }
  const user = await db.user.findUnique({
    where: { id: auth.userId },
    include: { tenant: true },
  });
  if (
    !user ||
    user.deletedAt ||
    !user.tenant ||
    user.tenant.deletedAt ||
    user.tenantId !== auth.tenantId ||
    user.sessionVersion !== auth.presentedSessionVersion ||
    (user.isGuest &&
      user.tenant.expiresAt &&
      user.tenant.expiresAt.getTime() <= now.getTime())
  ) {
    throw unauthenticated();
  }
  const modules = parseGrantJson(user.allowedModules);
  const projects = parseGrantJson(user.allowedProjects);
  const types = parseGrantJson(user.allowedProjectTypes);
  if (!modules.valid || !projects.valid || !types.valid)
    throw unauthenticated();
  return {
    tenantId: user.tenantId,
    userId: user.id,
    role: user.role,
    allowedModules: reconcileUserModules(modules.values, types.values),
    allowedProjects: projects.values,
    allowedProjectTypes: types.values,
  };
}

async function accessibleScope(
  db: Pick<Db, "project">,
  actor: ImportActor,
  requiredModule: string,
): Promise<string[] | null> {
  return resolveAccessibleProjectScope(
    db,
    actor.tenantId,
    actor.role,
    actor.allowedProjects,
    actor.allowedProjectTypes,
    actor.allowedModules,
    requiredModule,
  );
}

/**
 * Credit-card module ACL for a card of the actor's tenant. Any failure (unknown, other tenant,
 * soft-deleted card/project, project or module outside the grant) is the SAME NOT_FOUND.
 * Returns the project the card belongs to (never taken from the request).
 */
export async function assertCardAccess(
  db: Pick<Db, "project" | "creditCard">,
  actor: ImportActor,
  cardId: string,
  expectedProjectId?: string,
): Promise<{ cardId: string; projectId: string }> {
  const card = await db.creditCard.findFirst({
    where: { id: cardId, tenantId: actor.tenantId, deletedAt: null },
    select: { id: true, projectId: true },
  });
  // A stored session whose card no longer belongs to its anchor project is not readable.
  if (
    !card ||
    (expectedProjectId !== undefined && card.projectId !== expectedProjectId)
  )
    throw notFound();
  const scope = await accessibleScope(db, actor, CREDIT_CARD_MODULE);
  if (scope === null) {
    // Full-access roles skip the grant lists but never see a deleted project.
    const project = await db.project.findFirst({
      where: { id: card.projectId, tenantId: actor.tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!project) throw notFound();
  } else if (!scope.includes(card.projectId)) {
    throw notFound();
  }
  return { cardId: card.id, projectId: card.projectId };
}

/**
 * A receipt is authorised ONLY by the CURRENT participant projects of its immutable snapshot
 * (never by re-reading Expense/CFE, which may have changed or been deleted since the apply).
 * EVERY participant must exist in the actor's tenant, be active (not soft-deleted) and be
 * authorised for the expense module, even for full-access roles. Any failure, including a
 * participant that is valid but outside the ACL or absent, is the SAME NOT_FOUND as an
 * unknown session. Uses the same definition as the list SQL CASE.
 */
export async function assertReceiptParticipantAccess(
  db: Pick<Db, "project">,
  actor: ImportActor,
  participantProjectIds: readonly string[],
): Promise<void> {
  return assertImportParticipantAccess(
    db,
    actor,
    participantProjectIds,
    EXPENSE_MODULE,
  );
}

/** Reauthorizes a live import candidate under the module that owns its resource kind. */
export async function assertImportParticipantAccess(
  db: Pick<Db, "project">,
  actor: ImportActor,
  participantProjectIds: readonly string[],
  requiredModule: typeof EXPENSE_MODULE | typeof RECEIPT_MODULE,
): Promise<void> {
  const scope = await accessibleScope(db, actor, requiredModule);
  const unique = [...new Set(participantProjectIds)];
  const found = await db.project.findMany({
    where: { id: { in: unique }, tenantId: actor.tenantId, deletedAt: null },
    select: { id: true },
  });
  const active = new Set(found.map((project) => project.id));
  for (const id of unique) {
    if (!active.has(id) || (scope !== null && !scope.includes(id))) {
      throw notFound();
    }
  }
}

/** Grants of the actor as list-SQL parameters (`null` scope = all projects of the tenant). */
export interface ListScopeParams {
  readonly cardAll: 0 | 1;
  readonly cardProjectsJson: string;
  readonly expenseAll: 0 | 1;
  readonly expenseProjectsJson: string;
}

export async function listScopeParams(
  db: Pick<Db, "project">,
  actor: ImportActor,
): Promise<ListScopeParams> {
  const card = await accessibleScope(db, actor, CREDIT_CARD_MODULE);
  const expense = await accessibleScope(db, actor, EXPENSE_MODULE);
  return {
    cardAll: card === null ? 1 : 0,
    cardProjectsJson: JSON.stringify(card ?? []),
    expenseAll: expense === null ? 1 : 0,
    expenseProjectsJson: JSON.stringify(expense ?? []),
  };
}
