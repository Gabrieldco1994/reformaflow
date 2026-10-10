import { Inject, Injectable } from "@nestjs/common";
import {
  IMPORT_SESSION_PRIMITIVES,
  ImportSessionErrorCode,
} from "@reformaflow/domain";
import { assertImportAuthForRequest } from "./import-session.auth";
import {
  IMPORT_SESSION_CLOCK,
  type ImportSessionClock,
} from "./import-session.capability";
import type {
  AuthenticatedImportContext,
  UiImportFinancialActionScope,
  UiImportFinancialActionVerifier,
  UiImportGrantScope,
  UiImportPersistenceGrant,
  UiImportPersistenceGrantVerifier,
} from "./import-session.contract";
import { ImportSessionError } from "./import-session.errors";

/** Deliberately short: a grant is minted per user action, never stored, never renewed. */
export const UI_GRANT_TTL_MS = 30_000;

interface GrantRecord {
  readonly tenantId: string;
  readonly userId: string;
  readonly scope: Readonly<Record<string, string | number>>;
  readonly expiresAtMs: number;
  /** Single use: the first successful verification spends the grant. */
  consumed: boolean;
}

/**
 * Module-private state. A grant is an opaque frozen object whose meaning lives only here,
 * keyed by identity: a JSON copy, a structural clone, a body flag or a tool argument has
 * no entry and therefore no authority.
 */
const GRANTS = new WeakMap<object, GrantRecord>();
/** Requests the UI guard admitted (exact Origin + UI header). Only these may receive a grant. */
const ATTESTED_REQUESTS = new WeakSet<object>();
const FINANCIAL_REQUESTS = new WeakSet<object>();
const financialActionGrantBrand = Symbol("UiImportFinancialActionGrant");
interface UiImportFinancialActionGrant {
  readonly [financialActionGrantBrand]: true;
}
interface FinancialGrantRecord {
  readonly auth: AuthenticatedImportContext;
  readonly scope: UiImportFinancialActionScope;
  readonly expiresAtMs: number;
  consumed: boolean;
}
const FINANCIAL_GRANTS = new WeakMap<object, FinancialGrantRecord>();
const ID = new RegExp(IMPORT_SESSION_PRIMITIVES.idPattern);
const HASH = new RegExp(IMPORT_SESSION_PRIMITIVES.hashPattern);
const REQUEST_ID = new RegExp(IMPORT_SESSION_PRIMITIVES.requestIdPattern);

const uiActionRequired = () =>
  new ImportSessionError(ImportSessionErrorCode.UI_ACTION_REQUIRED);

function sameScope(
  recorded: Readonly<Record<string, string | number>>,
  wanted: UiImportGrantScope | UiImportFinancialActionScope,
): boolean {
  const left = recorded as Record<string, unknown>;
  const right = wanted as unknown as Record<string, unknown>;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && left[key] === right[key],
    )
  );
}

function validFinancialScope(
  value: Record<string, unknown>,
): value is Record<string, unknown> & UiImportFinancialActionScope {
  const exact = (keys: readonly string[]) =>
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
  if (typeof value.sessionId !== "string" || !ID.test(value.sessionId))
    return false;
  const financialRequestId = () =>
    typeof value.financialRequestId === "string" &&
    REQUEST_ID.test(value.financialRequestId);
  if (value.operation === "EXECUTE") {
    return (
      exact(["operation", "sessionId", "financialRequestId"]) &&
      financialRequestId()
    );
  }
  if (
    typeof value.expectedRevision !== "number" ||
    !Number.isInteger(value.expectedRevision) ||
    value.expectedRevision < IMPORT_SESSION_PRIMITIVES.minRevision ||
    value.expectedRevision > IMPORT_SESSION_PRIMITIVES.maxRevision ||
    typeof value.confirmationHash !== "string" ||
    !HASH.test(value.confirmationHash)
  )
    return false;
  const keys = [
    "operation",
    "sessionId",
    "expectedRevision",
    "confirmationHash",
  ];
  return value.operation === "CHALLENGE"
    ? exact(keys)
    : value.operation === "CONFIRM" &&
        exact([...keys, "financialRequestId"]) &&
        financialRequestId();
}

function snapshotFinancialScope(value: unknown): UiImportFinancialActionScope {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw uiActionRequired();
  const snapshot: Record<string, unknown> = { ...value };
  if (!validFinancialScope(snapshot)) throw uiActionRequired();
  return Object.freeze(snapshot);
}

/** Boundary-only (controller + UI guard). Nothing else in the application imports this. */
@Injectable()
export class ImportUiGrantIssuer {
  constructor(
    @Inject(IMPORT_SESSION_CLOCK) private readonly clock: ImportSessionClock,
  ) {}

  /** Called by the UI guard only after the exact Origin and the UI header were verified. */
  attestRequest(request: object): void {
    if (request !== null && typeof request === "object")
      ATTESTED_REQUESTS.add(request);
  }

  issue(
    request: object,
    auth: AuthenticatedImportContext,
    scope: UiImportGrantScope,
  ): UiImportPersistenceGrant {
    if (
      request === null ||
      typeof request !== "object" ||
      !ATTESTED_REQUESTS.has(request)
    ) {
      throw uiActionRequired();
    }
    const nowMs = this.clock.now().getTime();
    const tokenExpiryMs = Date.parse(auth.tokenExpiresAt);
    // A malformed token expiry yields an already-dead grant (fail closed, no throw here:
    // the service reports the authentication failure first).
    const expiresAtMs = Number.isFinite(tokenExpiryMs)
      ? Math.min(nowMs + UI_GRANT_TTL_MS, tokenExpiryMs)
      : nowMs;
    const grant = Object.freeze({}) as UiImportPersistenceGrant;
    GRANTS.set(grant, {
      tenantId: auth.tenantId,
      userId: auth.userId,
      scope: Object.freeze({
        ...(scope as unknown as Record<string, string | number>),
      }),
      expiresAtMs,
      consumed: false,
    });
    return grant;
  }

  issueFinancialAction(
    request: object,
    auth: AuthenticatedImportContext,
    scope: UiImportFinancialActionScope,
  ): UiImportFinancialActionGrant {
    if (!ATTESTED_REQUESTS.has(request) || FINANCIAL_REQUESTS.has(request))
      throw uiActionRequired();
    assertImportAuthForRequest(request, auth);
    const snapshot = snapshotFinancialScope(scope);
    const nowMs = this.clock.now().getTime();
    const expiresAtMs = Math.min(
      nowMs + UI_GRANT_TTL_MS,
      Date.parse(auth.tokenExpiresAt),
    );
    if (!Number.isFinite(nowMs) || !(nowMs < expiresAtMs))
      throw uiActionRequired();
    const grant = Object.freeze<UiImportFinancialActionGrant>({
      [financialActionGrantBrand]: true,
    });
    FINANCIAL_GRANTS.set(grant, {
      auth,
      scope: snapshot,
      expiresAtMs,
      consumed: false,
    });
    FINANCIAL_REQUESTS.add(request);
    return grant;
  }
}

/**
 * Runtime verifier: identity of the grant, actor, exact scope, deadline and single use, or
 * UI_ACTION_REQUIRED. It is spent by the first success.
 */
@Injectable()
export class RuntimeUiGrantVerifier
  implements UiImportPersistenceGrantVerifier, UiImportFinancialActionVerifier
{
  verify(
    candidate: unknown,
    auth: AuthenticatedImportContext,
    scope: UiImportGrantScope,
    now: Date,
  ): UiImportPersistenceGrant {
    const record =
      candidate !== null && typeof candidate === "object"
        ? GRANTS.get(candidate)
        : undefined;
    if (
      !record ||
      record.tenantId !== auth.tenantId ||
      record.userId !== auth.userId ||
      !sameScope(record.scope, scope) ||
      record.consumed ||
      !(now.getTime() < record.expiresAtMs)
    ) {
      throw uiActionRequired();
    }
    // Spent only after every binding matched: a mismatching attempt cannot burn a grant.
    record.consumed = true;
    return candidate as UiImportPersistenceGrant;
  }

  verifyFinancialAction(
    candidate: unknown,
    auth: AuthenticatedImportContext,
    scope: UiImportFinancialActionScope,
    now: Date,
  ): void {
    const record =
      candidate !== null && typeof candidate === "object"
        ? FINANCIAL_GRANTS.get(candidate)
        : undefined;
    if (
      !record ||
      record.auth !== auth ||
      record.consumed ||
      !(now.getTime() < record.expiresAtMs) ||
      !sameScope(record.scope, snapshotFinancialScope(scope))
    )
      throw uiActionRequired();
    record.consumed = true;
  }
}
