import { rawTestDependencies } from "../../test-utils/import-session-raw-harness";
require("../../../../../scripts/test-db-env.cjs");
import { ImportVaultGate } from "./vault/vault-state";

import { existsSync } from "node:fs";
import { join } from "node:path";
import { ExecutionContextHost } from "@nestjs/core/helpers/execution-context-host";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  FIXED_NOW,
  MutableClock,
} from "../../test-utils/import-session-harness";
import * as authModule from "./import-session.auth";
import {
  assertMintedImportContext,
  ImportAuthGuard,
} from "./import-session.auth";
import {
  DefaultImportSessionCapability,
  type ImportSessionClock,
} from "./import-session.capability";
import type {
  AuthenticatedImportContext,
  UiImportGrantScope,
} from "./import-session.contract";
import { ImportSessionError } from "./import-session.errors";
import { ImportSessionService } from "./import-session.service";
import {
  ImportUiGrantIssuer,
  RuntimeUiGrantVerifier,
  UI_GRANT_TTL_MS,
} from "./import-session-ui-grant";
import { ImportUiGuard, IMPORT_UI_HEADER } from "./import-session-ui.guard";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const HASH = "a".repeat(64);
const unauthenticated = expect.objectContaining({
  code: "UNAUTHENTICATED",
  status: 401,
});
const uiRequired = expect.objectContaining({
  code: "UI_ACTION_REQUIRED",
  status: 403,
});

function requestFor(expiryMs = FIXED_NOW.getTime() + 90_000) {
  return {
    headers: {
      origin: "http://localhost:3000",
      [IMPORT_UI_HEADER]: "1",
    },
    user: {
      id: "independent-user",
      tenantId: "independent-tenant",
      authClaims: {
        sessionVersion: 3,
        expiresAtEpochSeconds: expiryMs / 1000,
      },
    },
  };
}

function authKey(request: object): symbol {
  const key = Object.getOwnPropertySymbols(request).find(
    (candidate) => candidate.description === "IMPORT_AUTH_CONTEXT",
  );
  expect(key).toBeDefined();
  if (!key) throw new Error("ImportAuthGuard did not attach its context");
  return key;
}

function guardedAuth(request: object): AuthenticatedImportContext {
  expect(
    new ImportAuthGuard().canActivate(new ExecutionContextHost([request])),
  ).toBe(true);
  const auth: unknown = Reflect.get(request, authKey(request));
  assertMintedImportContext(auth);
  return auth;
}

function attest(request: object, issuer: ImportUiGrantIssuer): void {
  const guard = new ImportUiGuard(
    { allowed: () => ["http://localhost:3000"] },
    issuer,
  );
  expect(guard.canActivate(new ExecutionContextHost([request]))).toBe(true);
}

// Look up the real future API before any denial assertion; absence is not a valid denial.
function requiredMethod(target: object, name: string) {
  const method: unknown = Reflect.get(target, name);
  expect({ [name]: typeof method }).toEqual({ [name]: "function" });
  if (typeof method !== "function") throw new Error(`Missing ${name}`);
  return (...args: unknown[]): unknown => Reflect.apply(method, target, args);
}

function financialMethods(
  issuer: ImportUiGrantIssuer,
  verifier: RuntimeUiGrantVerifier,
) {
  return {
    issue: requiredMethod(issuer, "issueFinancialAction"),
    verify: requiredMethod(verifier, "verifyFinancialAction"),
  };
}

function opaqueGrant(value: unknown): object {
  expect(typeof value).toBe("object");
  expect(value).not.toBeNull();
  if (value === null || typeof value !== "object") {
    throw new Error("Financial issuance did not return an opaque object");
  }
  expect(Object.isFrozen(value)).toBe(true);
  return value;
}

const challengeScope = () => ({
  operation: "CHALLENGE" as const,
  sessionId: "independent-session",
  expectedRevision: 8,
  proposalHash: HASH,
});
const confirmScope = () => ({
  ...challengeScope(),
  operation: "CONFIRM" as const,
  financialRequestId: REQUEST_ID,
});
const executeScope = () => ({
  operation: "EXECUTE" as const,
  sessionId: "independent-session",
  financialRequestId: REQUEST_ID,
});
const documentaryScope: UiImportGrantScope = {
  operation: "CREATE_SESSION",
  cardId: "independent-card",
  createRequestId: REQUEST_ID,
  consentPolicyVersion: 1,
};

describe("independent financial authority: real boundary, no HTTP/provider harness", () => {
  let clock: MutableClock;
  let issuer: ImportUiGrantIssuer;
  let verifier: RuntimeUiGrantVerifier;

  beforeEach(() => {
    clock = new MutableClock(new Date(FIXED_NOW));
    issuer = new ImportUiGrantIssuer(clock);
    verifier = new RuntimeUiGrantVerifier();
  });

  it("CONTROL: the real auth guard mints the verified tuple, frozen and branded", () => {
    const auth = guardedAuth(requestFor());
    expect(auth).toEqual({
      tenantId: "independent-tenant",
      userId: "independent-user",
      presentedSessionVersion: 3,
      tokenExpiresAt: "2026-09-28T15:01:30.000Z",
    });
    expect(Object.isFrozen(auth)).toBe(true);
    expect(() => assertMintedImportContext({ ...auth })).toThrow(
      unauthenticated,
    );
  });

  it.each([
    ["missing user", undefined],
    ["missing claims", { id: "u", tenantId: "t" }],
    [
      "missing exp",
      { id: "u", tenantId: "t", authClaims: { sessionVersion: 3 } },
    ],
    [
      "missing sv",
      { id: "u", tenantId: "t", authClaims: { expiresAtEpochSeconds: 1 } },
    ],
    ...[null, "1790607690", NaN, Infinity, 1e100].map(
      (expiry): [string, unknown] => [
        `invalid exp ${String(expiry)}`,
        {
          ...requestFor().user,
          authClaims: { sessionVersion: 3, expiresAtEpochSeconds: expiry },
        },
      ],
    ),
  ])("CONTROL: %s cannot fabricate authentication", (_label, user) => {
    const request = { headers: requestFor().headers, user };
    expect(() =>
      new ImportAuthGuard().canActivate(new ExecutionContextHost([request])),
    ).toThrow(unauthenticated);
    expect(Object.getOwnPropertySymbols(request)).toHaveLength(0);
  });

  it("reentry of the same verified request preserves the exact auth identity", () => {
    const request = requestFor();
    const original = guardedAuth(request);
    expect(guardedAuth(request)).toBe(original);
  });

  it.each(["user", "tenant", "version", "expiry", "context"] as const)(
    "reentry rejects a conflicting verified %s without replacing the original context",
    (field) => {
      const request = requestFor();
      const original = guardedAuth(request);
      if (field === "user") request.user.id = "other-user";
      if (field === "tenant") request.user.tenantId = "other-tenant";
      if (field === "version") request.user.authClaims.sessionVersion += 1;
      if (field === "expiry")
        request.user.authClaims.expiresAtEpochSeconds += 1;
      if (field === "context") {
        Reflect.set(request, authKey(request), guardedAuth(requestFor()));
      }
      expect(() =>
        new ImportAuthGuard().canActivate(new ExecutionContextHost([request])),
      ).toThrow(unauthenticated);
      if (field !== "context") {
        expect(Reflect.get(request, authKey(request))).toBe(original);
      }
    },
  );

  it("exports the existing auth surface plus assertion and reader, never a public binder", () => {
    expect(Object.keys(authModule).sort()).toEqual(
      [
        "ImportAuth",
        "ImportAuthGuard",
        "assertCardAccess",
        "assertImportAuthForRequest",
        "assertMintedImportContext",
        "assertReceiptParticipantAccess",
        "listScopeParams",
        "mintImportAuthContext",
        "readImportAuthForRequest",
        "reauthorize",
      ].sort(),
    );
  });

  describe("P08 additive accessor: original request authority only", () => {
    it("returns the original frozen identity and presented sv/exp without minting", () => {
      const read = requiredMethod(authModule, "readImportAuthForRequest");
      const request = requestFor();
      const original = guardedAuth(request);
      const keys = Reflect.ownKeys(request);
      expect(read(request)).toBe(original);
      expect(read(request)).toBe(original);
      expect(original).toEqual({
        tenantId: "independent-tenant",
        userId: "independent-user",
        presentedSessionVersion: 3,
        tokenExpiresAt: "2026-09-28T15:01:30.000Z",
      });
      expect(Object.isFrozen(original)).toBe(true);
      expect(Reflect.ownKeys(request)).toEqual(keys);
    });

    it("unknown requests with copied verified claims do not acquire a binding", () => {
      const read = requiredMethod(authModule, "readImportAuthForRequest");
      const request = requestFor();
      expect(() => read(request)).toThrow(unauthenticated);
      expect(Object.getOwnPropertySymbols(request)).toEqual([]);
      const original = guardedAuth(request);
      expect(read(request)).toBe(original);
    });

    it("spread/JSON clones of a bound request are not authority", () => {
      const read = requiredMethod(authModule, "readImportAuthForRequest");
      const request = requestFor();
      const original = guardedAuth(request);
      for (const clone of [{ ...request }, JSON.parse(JSON.stringify(request))]) {
        expect(() => read(clone)).toThrow(unauthenticated);
      }
      expect(read(request)).toBe(original);
    });

    it("rejects cross-request and cloned auth substitution without rebinding", () => {
      const read = requiredMethod(authModule, "readImportAuthForRequest");
      const first = requestFor();
      const second = requestFor();
      const original = guardedAuth(first);
      const other = guardedAuth(second);
      expect(other).not.toBe(original);
      for (const replacement of [other, { ...original }]) {
        Reflect.set(first, authKey(first), replacement);
        expect(() => read(first)).toThrow(unauthenticated);
        expect(Reflect.get(first, authKey(first))).toBe(replacement);
        expect(read(second)).toBe(other);
      }
      Reflect.set(first, authKey(first), original);
      expect(read(first)).toBe(original);
    });
  });

  it.each([
    ["foreign Origin", "https://foreign.example", "1"],
    ["wrong UI marker", "http://localhost:3000", "true"],
  ])(
    "CONTROL: %s leaves documentary issuance unattested",
    (_label, origin, marker) => {
      const request = requestFor();
      request.headers.origin = origin;
      request.headers[IMPORT_UI_HEADER] = marker;
      const auth = guardedAuth(request);
      const guard = new ImportUiGuard(
        { allowed: () => ["http://localhost:3000"] },
        issuer,
      );
      expect(() =>
        guard.canActivate(new ExecutionContextHost([request])),
      ).toThrow(uiRequired);
      expect(() => issuer.issue(request, auth, documentaryScope)).toThrow(
        uiRequired,
      );
    },
  );

  it("CONTROL: documentary verification keeps actor-value binding, return identity and single use", () => {
    const request = requestFor();
    const auth = guardedAuth(request);
    const sameActor = guardedAuth(requestFor());
    attest(request, issuer);
    const grant = issuer.issue(request, auth, documentaryScope);
    expect(() =>
      verifier.verify(
        grant,
        auth,
        { ...documentaryScope, cardId: "other-card" },
        clock.now(),
      ),
    ).toThrow(uiRequired);
    expect(
      verifier.verify(grant, sameActor, documentaryScope, clock.now()),
    ).toBe(grant);
    expect(() =>
      verifier.verify(grant, auth, documentaryScope, clock.now()),
    ).toThrow(uiRequired);
    const next = issuer.issue(request, auth, documentaryScope);
    expect(verifier.verify(next, auth, documentaryScope, clock.now())).toBe(
      next,
    );
  });

  it("binds issuance to the original request/auth, not a genuine peer or structural copies", () => {
    const { issue, verify } = financialMethods(issuer, verifier);
    const request = requestFor();
    const auth = guardedAuth(request);
    const peer = guardedAuth(requestFor());
    attest(request, issuer);
    for (const candidate of [peer, { ...auth }, structuredClone(auth)]) {
      expect(() => issue(request, candidate, confirmScope())).toThrow(
        unauthenticated,
      );
    }
    const substitute = { ...request };
    attest(substitute, issuer);
    expect(() => issue(substitute, auth, confirmScope())).toThrow(
      unauthenticated,
    );
    const grant = opaqueGrant(issue(request, auth, confirmScope()));
    expect(verify(grant, auth, confirmScope(), clock.now())).toBeUndefined();
  });

  it("requires UI attestation; invalid issuance does not spend the request", () => {
    const { issue, verify } = financialMethods(issuer, verifier);
    const request = requestFor();
    const auth = guardedAuth(request);
    expect(() => issue(request, auth, confirmScope())).toThrow(uiRequired);
    attest(request, issuer);
    for (const scope of [
      { ...confirmScope(), expectedRevision: 0 },
      { ...confirmScope(), financialRequestId: "not-a-uuid" },
    ]) {
      expect(() => issue(request, auth, scope)).toThrow(ImportSessionError);
    }
    const grant = opaqueGrant(issue(request, auth, confirmScope()));
    expect(verify(grant, auth, confirmScope(), clock.now())).toBeUndefined();
  });

  it.each([challengeScope(), confirmScope(), executeScope()])(
    "$operation is OFF-independent and verifies once with void, not a new admission token",
    (scope) => {
      const { issue, verify } = financialMethods(issuer, verifier);
      expect(new DefaultImportSessionCapability().writesEnabled()).toBe(false);
      const request = requestFor();
      const auth = guardedAuth(request);
      attest(request, issuer);
      const grant = opaqueGrant(issue(request, auth, scope));
      expect(verify(grant, auth, scope, clock.now())).toBeUndefined();
      expect(() => verify(grant, auth, scope, clock.now())).toThrow(uiRequired);
    },
  );

  it("documentary grants, clones and forged values are never financial authority", () => {
    const { issue, verify } = financialMethods(issuer, verifier);
    const request = requestFor();
    const auth = guardedAuth(request);
    attest(request, issuer);
    const documentary = issuer.issue(request, auth, documentaryScope);
    const grant = opaqueGrant(issue(request, auth, confirmScope()));
    for (const candidate of [
      documentary,
      { ...grant },
      structuredClone(grant),
      {},
      true,
      null,
    ]) {
      expect(() =>
        verify(candidate, auth, confirmScope(), clock.now()),
      ).toThrow(uiRequired);
    }
    expect(() =>
      verifier.verify(grant, auth, documentaryScope, clock.now()),
    ).toThrow(uiRequired);
    expect(
      verifier.verify(documentary, auth, documentaryScope, clock.now()),
    ).toBe(documentary);
    expect(verify(grant, auth, confirmScope(), clock.now())).toBeUndefined();
  });

  it("wrong identity, actor, tenant, operation, session, revision, hash or request key does not consume", () => {
    const { issue, verify } = financialMethods(issuer, verifier);
    const request = requestFor();
    const auth = guardedAuth(request);
    attest(request, issuer);
    const grant = opaqueGrant(issue(request, auth, confirmScope()));
    const otherUser = requestFor();
    otherUser.user.id = "other-user";
    const otherTenant = requestFor();
    otherTenant.user.tenantId = "other-tenant";
    for (const wrongAuth of [
      guardedAuth(requestFor()),
      guardedAuth(otherUser),
      guardedAuth(otherTenant),
    ]) {
      expect(() =>
        verify(grant, wrongAuth, confirmScope(), clock.now()),
      ).toThrow(uiRequired);
    }
    for (const scope of [
      challengeScope(),
      { ...confirmScope(), sessionId: "other-session" },
      { ...confirmScope(), expectedRevision: 9 },
      { ...confirmScope(), proposalHash: "b".repeat(64) },
      { ...confirmScope(), financialRequestId: OTHER_REQUEST_ID },
    ]) {
      expect(() => verify(grant, auth, scope, clock.now())).toThrow(uiRequired);
    }
    expect(verify(grant, auth, confirmScope(), clock.now())).toBeUndefined();
    expect(() => verify(grant, auth, confirmScope(), clock.now())).toThrow(
      uiRequired,
    );
  });

  it("copies scope at issuance instead of retaining or freezing the caller's mutable arguments", () => {
    const { issue, verify } = financialMethods(issuer, verifier);
    const request = requestFor();
    const auth = guardedAuth(request);
    attest(request, issuer);
    const scope = confirmScope();
    const snapshot = { ...scope };
    const grant = opaqueGrant(issue(request, auth, scope));
    expect(Object.isFrozen(scope)).toBe(false);
    Object.assign(scope, {
      sessionId: "other-session",
      expectedRevision: 9,
      proposalHash: "b".repeat(64),
      financialRequestId: OTHER_REQUEST_ID,
    });
    expect(() => verify(grant, auth, scope, clock.now())).toThrow(uiRequired);
    expect(verify(grant, auth, snapshot, clock.now())).toBeUndefined();
  });

  it.each(["unconsumed", "consumed", "expired", "reattested"] as const)(
    "a second VALID financial emission on the same request fails when %s",
    (phase) => {
      const { issue, verify } = financialMethods(issuer, verifier);
      const request = requestFor();
      const auth = guardedAuth(request);
      attest(request, issuer);
      const grant = opaqueGrant(issue(request, auth, confirmScope()));
      if (phase === "consumed")
        verify(grant, auth, confirmScope(), clock.now());
      if (phase === "expired") {
        clock.current = new Date(FIXED_NOW.getTime() + 30_000);
        expect(() => verify(grant, auth, confirmScope(), clock.now())).toThrow(
          uiRequired,
        );
      }
      if (phase === "reattested") {
        verify(grant, auth, confirmScope(), clock.now());
        expect(guardedAuth(request)).toBe(auth);
        attest(request, issuer);
      }
      expect(() => issue(request, auth, executeScope())).toThrow(uiRequired);
    },
  );

  it.each([
    ["UI TTL", 90_000, 30_000],
    ["earlier JWT expiration", 5_000, 5_000],
  ])(
    "uses trusted %s: deadline minus 1ms passes, exact deadline fails",
    (_label, tokenMs, deadlineMs) => {
      const { issue, verify } = financialMethods(issuer, verifier);
      expect(UI_GRANT_TTL_MS).toBe(30_000);
      for (const offset of [-1, 0]) {
        clock.current = new Date(FIXED_NOW);
        const request = requestFor(FIXED_NOW.getTime() + tokenMs);
        const auth = guardedAuth(request);
        attest(request, issuer);
        const grant = opaqueGrant(issue(request, auth, confirmScope()));
        clock.current = new Date(FIXED_NOW.getTime() + deadlineMs + offset);
        if (offset === -1) {
          expect(
            verify(grant, auth, confirmScope(), clock.now()),
          ).toBeUndefined();
        } else {
          expect(() =>
            verify(grant, auth, confirmScope(), clock.now()),
          ).toThrow(uiRequired);
        }
      }
    },
  );

  it("guard reentry and reattestation cannot renew an already issued financial deadline", () => {
    const { issue, verify } = financialMethods(issuer, verifier);
    const request = requestFor();
    const auth = guardedAuth(request);
    attest(request, issuer);
    const grant = opaqueGrant(issue(request, auth, confirmScope()));
    clock.current = new Date(FIXED_NOW.getTime() + 29_999);
    expect(guardedAuth(request)).toBe(auth);
    attest(request, issuer);
    clock.current = new Date(FIXED_NOW.getTime() + 30_000);
    expect(() => verify(grant, auth, confirmScope(), clock.now())).toThrow(
      uiRequired,
    );
    expect(() => issue(request, auth, confirmScope())).toThrow(uiRequired);
  });
});

type Work = (tx: Prisma.TransactionClient, now: Date) => Promise<unknown>;

function writerModule(): object {
  const path = join(__dirname, "import-session.writer.ts");
  expect({ writerSourceExists: existsSync(path) }).toEqual({
    writerSourceExists: true,
  });
  // No fallback module: a missing future file is RED before require, not a loader error.
  if (!existsSync(path)) throw new Error("Missing import-session.writer.ts");
  const loaded: unknown = require(path);
  if (loaded === null || typeof loaded !== "object")
    throw new Error("Invalid writer exports");
  return loaded;
}

describe.each(["existing service", "extracted writer"] as const)(
  "writer extraction characterization: %s (mock call ordering, not SQLite engine proof)",
  (surface) => {
    let prisma: PrismaService;
    let clock: MutableClock;
    let write: (work: Work) => unknown;
    let transaction: jest.SpyInstance;

    beforeEach(() => {
      prisma = new PrismaService();
      clock = new MutableClock(new Date(FIXED_NOW));
      const auth = guardedAuth(requestFor());
      const service = new ImportSessionService(
        prisma,
        clock,
        new DefaultImportSessionCapability(),
        new RuntimeUiGrantVerifier(),
        ...rawTestDependencies(new ImportVaultGate(prisma, clock, {}, process.cwd()), clock, new DefaultImportSessionCapability()),
      );
      transaction = jest
        .spyOn(prisma, "$transaction")
        .mockImplementation(async (work) => {
          if (typeof work !== "function")
            throw new Error("Expected interactive transaction");
          return work(prisma);
        });
      write = (work) =>
        surface === "existing service"
          ? requiredMethod(service, "write")(auth, work)
          : requiredMethod(writerModule(), "runImportSessionWrite")(
              prisma,
              clock,
              auth,
              work,
            );
    });

    afterEach(() => jest.restoreAllMocks());

    it("keeps tenant UPDATE first, a fresh clock after lock per attempt, exact options and result", async () => {
      const lock = jest.spyOn(prisma, "$executeRaw").mockResolvedValue(1);
      const times = [1, 2, 3].map(
        (n) => new Date(FIXED_NOW.getTime() + n * 1000),
      );
      const now = jest.spyOn(clock, "now").mockImplementation(() => {
        expect(lock).toHaveBeenCalledTimes(now.mock.calls.length);
        return times[now.mock.calls.length - 1];
      });
      const result = Object.freeze({ revision: 8 });
      const work = jest.fn(async (tx: Prisma.TransactionClient, at: Date) => {
        expect(tx).toBe(prisma);
        expect(at).toBe(times[work.mock.calls.length - 1]);
        if (work.mock.calls.length < 3) throw new Error("database is locked");
        return result;
      });
      const pending = write(work);
      expect(now).not.toHaveBeenCalled();
      expect(work).not.toHaveBeenCalled();
      await expect(pending).resolves.toBe(result);
      expect(transaction).toHaveBeenCalledTimes(3);
      expect(lock).toHaveBeenCalledTimes(3);
      expect(now).toHaveBeenCalledTimes(3);
      expect(work).toHaveBeenCalledTimes(3);
      for (let index = 0; index < 3; index++) {
        expect(transaction.mock.calls[index][1]).toEqual({
          maxWait: 5000,
          timeout: 20000,
        });
        expect(lock.mock.calls[index]).toEqual([
          ["UPDATE tenants SET id = id WHERE id = ", ""],
          "independent-tenant",
        ]);
        expect(lock.mock.invocationCallOrder[index]).toBeLessThan(
          now.mock.invocationCallOrder[index],
        );
        expect(now.mock.invocationCallOrder[index]).toBeLessThan(
          work.mock.invocationCallOrder[index],
        );
      }
    });

    it("does not sample time or run work when the lock fails; stops after three attempts", async () => {
      const lock = jest.spyOn(prisma, "$executeRaw").mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("conflict", {
          code: "P2034",
          clientVersion: "5.22.0",
        }),
      );
      const now = jest.spyOn(clock, "now");
      const work = jest.fn(async () => "must not resolve");
      await expect(write(work)).rejects.toMatchObject({
        code: "RETRYABLE_WRITE_CONFLICT",
        status: 503,
        retryable: true,
        sessionId: null,
        currentRevision: null,
        reason: null,
      });
      expect(transaction).toHaveBeenCalledTimes(3);
      expect(lock).toHaveBeenCalledTimes(3);
      expect(now).not.toHaveBeenCalled();
      expect(work).not.toHaveBeenCalled();
    });

    it("propagates the exact nonretryable work error instead of success or a conflict", async () => {
      const error = new Error("independent work failure");
      const lock = jest.spyOn(prisma, "$executeRaw").mockResolvedValue(1);
      const work = jest.fn(async () => {
        throw error;
      });
      await expect(write(work)).rejects.toBe(error);
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(lock).toHaveBeenCalledTimes(1);
      expect(work).toHaveBeenCalledTimes(1);
    });
  },
);

it("CONTROL: readTransaction does not issue the explicit tenant UPDATE (not a no-writer-lock claim)", async () => {
  const prisma = new PrismaService();
  const clock: ImportSessionClock = new MutableClock(new Date(FIXED_NOW));
  const service = new ImportSessionService(
    prisma,
    clock,
    new DefaultImportSessionCapability(),
    new RuntimeUiGrantVerifier(),
    ...rawTestDependencies(new ImportVaultGate(prisma, clock, {}, process.cwd()), clock, new DefaultImportSessionCapability()),
  );
  const transaction = jest
    .spyOn(prisma, "$transaction")
    .mockImplementation(async (work) => {
      if (typeof work !== "function")
        throw new Error("Expected interactive transaction");
      return work(prisma);
    });
  const lock = jest.spyOn(prisma, "$executeRaw").mockResolvedValue(1);
  try {
    const result = { read: true };
    const work = jest.fn(async (tx: Prisma.TransactionClient, at: Date) => {
      expect(tx).toBe(prisma);
      expect(at).toEqual(FIXED_NOW);
      return result;
    });
    await expect(
      requiredMethod(service, "readTransaction")(work),
    ).resolves.toBe(result);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0][1]).toEqual({
      maxWait: 5000,
      timeout: 20000,
    });
    expect(lock).not.toHaveBeenCalled();
    expect(work).toHaveBeenCalledTimes(1);
  } finally {
    jest.restoreAllMocks();
  }
});

it("the extracted classifier retains Prisma codes, SQLite messages and nonretryable negatives", () => {
  const classify = requiredMethod(writerModule(), "isRetryableWriteFailure");
  for (const code of ["P2034", "P2002", "P2025"]) {
    expect(
      classify(
        new Prisma.PrismaClientKnownRequestError("failure", {
          code,
          clientVersion: "5.22.0",
        }),
      ),
    ).toBe(code !== "P2025");
  }
  for (const message of [
    "SQLITE_BUSY",
    "database is locked",
    "DATABASE TABLE IS LOCKED",
  ]) {
    expect(classify(new Error(message))).toBe(true);
  }
  for (const error of [
    new Error("work failed"),
    { code: "P2034" },
    { message: "SQLITE_BUSY" },
    "SQLITE_BUSY",
    null,
  ]) {
    expect(classify(error)).toBe(false);
  }
});
