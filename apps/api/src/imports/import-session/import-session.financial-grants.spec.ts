require("../../../../../scripts/test-db-env.cjs");

import type { ExecutionContext } from "@nestjs/common";
import { IMPORT_SESSION_PRIMITIVES } from "@reformaflow/domain";
import { ImportAuthGuard, mintImportAuthContext } from "./import-session.auth";
import type { AuthenticatedImportContext } from "./import-session.contract";
import {
  ImportUiGrantIssuer,
  RuntimeUiGrantVerifier,
  UI_GRANT_TTL_MS,
} from "./import-session-ui-grant";

const NOW = Date.parse("2026-10-07T03:00:00.000Z");
const challenge = {
  operation: "CHALLENGE",
  sessionId: "session",
  expectedRevision: 8,
  proposalHash: "a".repeat(64),
};
const confirm = {
  ...challenge,
  operation: "CONFIRM",
  financialRequestId: "123e4567-e89b-42d3-a456-426614174000",
};
const execute = {
  operation: "EXECUTE",
  sessionId: "session",
  financialRequestId: confirm.financialRequestId,
};
const uiRequired = expect.objectContaining({ code: "UI_ACTION_REQUIRED" });
const unauthenticated = expect.objectContaining({ code: "UNAUTHENTICATED" });

function invoke(target: object, name: string, ...args: unknown[]): unknown {
  const method: unknown = Reflect.get(target, name);
  expect(typeof method).toBe("function");
  if (typeof method !== "function") throw new Error(`Missing method: ${name}`);
  return Reflect.apply(method, target, args);
}

function contextFor(request: object): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function fixture(expiryMs = NOW + 60_000) {
  let nowMs = NOW;
  const issuer = new ImportUiGrantIssuer({ now: () => new Date(nowMs) });
  const verifier = new RuntimeUiGrantVerifier();
  const request = {
    user: {
      id: "owner",
      tenantId: "tenant",
      authClaims: {
        sessionVersion: 7,
        expiresAtEpochSeconds: expiryMs / 1000,
      },
    },
  };
  const guard = new ImportAuthGuard();
  const context = contextFor(request);
  guard.canActivate(context);
  const [symbol] = Object.getOwnPropertySymbols(request);
  const auth: AuthenticatedImportContext = Reflect.get(request, symbol);
  issuer.attestRequest(request);
  return {
    issuer,
    verifier,
    request,
    guard,
    context,
    auth,
    symbol,
    time: (value: number) => {
      nowMs = value;
    },
    issue: (
      scope: unknown = challenge,
      suppliedAuth = auth,
      req: object = request,
    ) => invoke(issuer, "issueFinancialAction", req, suppliedAuth, scope),
    verify: (
      grant: unknown,
      scope: unknown = challenge,
      suppliedAuth = auth,
      at = nowMs,
    ) =>
      invoke(
        verifier,
        "verifyFinancialAction",
        grant,
        suppliedAuth,
        scope,
        new Date(at),
      ),
  };
}

describe("inactive financial UI grant admission", () => {
  it("provides the two financial methods (missing exports must reach a test assertion)", () => {
    expect(
      typeof Reflect.get(ImportUiGrantIssuer.prototype, "issueFinancialAction"),
    ).toBe("function");
    expect(
      typeof Reflect.get(
        RuntimeUiGrantVerifier.prototype,
        "verifyFinancialAction",
      ),
    ).toBe("function");
  });

  it.each([challenge, confirm, execute])(
    "consumes %j once and returns void",
    (scope) => {
      const f = fixture();
      const grant = f.issue(scope);
      expect(Object.isFrozen(grant)).toBe(true);
      expect(f.verify(grant, scope)).toBeUndefined();
      expect(() => f.verify(grant, scope)).toThrow(uiRequired);
    },
  );

  it("binds the request to its original genuine auth, not an equivalent mint or another request", () => {
    const f = fixture();
    const foreign = fixture();
    expect(() => f.issue(challenge, foreign.auth)).toThrow(unauthenticated);
    expect(() => f.issue(challenge, mintImportAuthContext(f.auth))).toThrow(
      unauthenticated,
    );
    expect(() => f.issue(challenge, { ...f.auth })).toThrow(unauthenticated);
    const clone = { ...f.request };
    f.issuer.attestRequest(clone);
    expect(() => f.issue(challenge, f.auth, clone)).toThrow(unauthenticated);
    expect(f.verify(f.issue())).toBeUndefined();
  });

  it("requires actual UI attestation as well as the request binding", () => {
    const f = fixture();
    const request = { user: f.request.user };
    f.guard.canActivate(contextFor(request));
    const auth = Reflect.get(request, Object.getOwnPropertySymbols(request)[0]);
    expect(() =>
      invoke(f.issuer, "issueFinancialAction", request, auth, challenge),
    ).toThrow(uiRequired);
    f.issuer.attestRequest(request);
    const grant = invoke(
      f.issuer,
      "issueFinancialAction",
      request,
      auth,
      challenge,
    );
    expect(f.verify(grant, challenge, auth)).toBeUndefined();
  });

  it("reuses guard identity without renewing authority, including after reattestation and expiry", () => {
    const f = fixture();
    const grant = f.issue();
    f.time(NOW + UI_GRANT_TTL_MS);
    expect(f.guard.canActivate(f.context)).toBe(true);
    expect(Reflect.get(f.request, f.symbol)).toBe(f.auth);
    f.issuer.attestRequest(f.request);
    expect(() => f.verify(grant)).toThrow(uiRequired);
    expect(() => f.issue()).toThrow(uiRequired);
    expect(() =>
      invoke(
        new ImportUiGrantIssuer({ now: () => new Date(NOW) }),
        "issueFinancialAction",
        f.request,
        f.auth,
        execute,
      ),
    ).toThrow(uiRequired);
  });

  it.each([
    "user",
    "tenant",
    "sessionVersion",
    "expiry",
    "context",
    "missingContext",
  ])("rejects guard reentry after %s divergence", (field) => {
    const f = fixture();
    if (field === "user") f.request.user.id = "other";
    if (field === "tenant") f.request.user.tenantId = "other";
    if (field === "sessionVersion") f.request.user.authClaims.sessionVersion++;
    if (field === "expiry") f.request.user.authClaims.expiresAtEpochSeconds++;
    if (field === "context")
      Reflect.set(f.request, f.symbol, mintImportAuthContext(f.auth));
    if (field === "missingContext") Reflect.deleteProperty(f.request, f.symbol);
    expect(() => f.guard.canActivate(f.context)).toThrow(unauthenticated);
  });

  it("rejects wrong auth/scope/operation and opaque clones without consuming the original", () => {
    const f = fixture();
    const grant = f.issue();
    for (const candidate of [
      null,
      {},
      true,
      { ...Object(grant) },
      JSON.parse(JSON.stringify(grant)),
      { nonce: "x" },
    ]) {
      expect(() => f.verify(candidate)).toThrow(uiRequired);
    }
    for (const scope of [
      { ...challenge, sessionId: "other" },
      { ...challenge, expectedRevision: 9 },
      { ...challenge, proposalHash: "b".repeat(64) },
      confirm,
      execute,
    ])
      expect(() => f.verify(grant, scope)).toThrow(uiRequired);
    expect(() => f.verify(grant, challenge, fixture().auth)).toThrow(
      uiRequired,
    );
    expect(() => f.verify(grant, challenge, { ...f.auth })).toThrow(uiRequired);
    expect(f.verify(grant)).toBeUndefined();
    expect(() => f.issue()).toThrow(uiRequired);
  });

  it.each([
    null,
    [],
    {},
    { ...challenge, extra: true },
    { ...challenge, sessionId: "" },
    { ...challenge, sessionId: "../session" },
    { ...challenge, expectedRevision: 0 },
    { ...challenge, expectedRevision: 1.5 },
    {
      ...challenge,
      expectedRevision: IMPORT_SESSION_PRIMITIVES.maxRevision + 1,
    },
    { ...challenge, proposalHash: "A".repeat(64) },
    { ...confirm, financialRequestId: "not-a-uuid" },
    { ...execute, expectedRevision: 8 },
    { ...confirm, nonce: null },
    { ...execute, operation: "CREATE_SESSION" },
  ])("rejects invalid scope %j without burning the request", (scope) => {
    const f = fixture();
    expect(() => f.issue(scope)).toThrow(uiRequired);
    expect(f.verify(f.issue())).toBeUndefined();
  });

  it("copies scope before registration; later mutation cannot change its authority", () => {
    const f = fixture();
    const input = { ...confirm };
    const grant = f.issue(input);
    input.sessionId = "changed";
    input.financialRequestId = "223e4567-e89b-42d3-a456-426614174000";
    expect(() => f.verify(grant, input)).toThrow(uiRequired);
    expect(f.verify(grant, confirm)).toBeUndefined();
  });

  it.each([UI_GRANT_TTL_MS, 10_000])(
    "uses an exclusive deadline of min(TTL, JWT expiry): %i",
    (deadline) => {
      const before = fixture(NOW + deadline);
      expect(
        before.verify(
          before.issue(),
          challenge,
          before.auth,
          NOW + deadline - 1,
        ),
      ).toBeUndefined();
      const at = fixture(NOW + deadline);
      expect(() =>
        at.verify(at.issue(), challenge, at.auth, NOW + deadline),
      ).toThrow(uiRequired);
    },
  );

  it("rejects invalid clocks and an expired JWT without burning an otherwise valid request", () => {
    const f = fixture();
    f.time(NaN);
    expect(() => f.issue()).toThrow(uiRequired);
    f.time(NOW);
    const grant = f.issue();
    expect(() => f.verify(grant, challenge, f.auth, NaN)).toThrow(uiRequired);
    expect(f.verify(grant)).toBeUndefined();
    expect(() => fixture(NOW).issue()).toThrow(uiRequired);
  });

  it("keeps documentary issuance/verification separate and unchanged", () => {
    const f = fixture();
    const scope = {
      operation: "CANCEL_SESSION" as const,
      sessionId: "session",
      expectedRevision: 8,
    };
    const documentGrant = f.issuer.issue(f.request, f.auth, scope);
    expect(() => f.verify(documentGrant)).toThrow(uiRequired);
    const financialGrant = f.issue();
    expect(() =>
      f.verifier.verify(financialGrant, f.auth, scope, new Date(NOW)),
    ).toThrow(uiRequired);
    expect(
      f.verifier.verify(documentGrant, { ...f.auth }, scope, new Date(NOW)),
    ).toBe(documentGrant);
    expect(f.verify(financialGrant)).toBeUndefined();
  });
});
