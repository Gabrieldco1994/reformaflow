import { describe, expect, it } from "vitest";
import { ApiResponseError, ApiTimeoutError } from "@/lib/api";
import {
  IMPORT_ERROR_COPY,
  classifyImportFailure,
  describeImportFailure,
  isImportSessionErrorBody,
} from "./import-session-errors";

// Pinned literally: the test must not read the list it protects.
const WIRE_CODES = [
  "INVALID_INPUT",
  "UNAUTHENTICATED",
  "NOT_FOUND",
  "UI_ACTION_REQUIRED",
  "REVISION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "STALE_PREVIEW",
  "REVIEW_REQUIRED",
  "SEARCH_TOO_BROAD",
  "LIMIT_EXCEEDED",
  "UNSUPPORTED_DOCUMENT",
  "LEASE_CONFLICT",
  "RETRYABLE_WRITE_CONFLICT",
  "CAPABILITY_DISABLED",
  "SESSION_EXPIRED",
  "ALREADY_APPLIED",
  "PROVIDER_UNAVAILABLE",
  "MODEL_OUTPUT_INVALID",
];

const body = (over: Record<string, unknown> = {}) => ({
  code: "REVISION_CONFLICT",
  retryable: false,
  sessionId: "s1",
  currentRevision: 4,
  reason: null,
  ...over,
});

describe("ImportSessionErrorV1 guard", () => {
  it("X3 documentary errors never authorize repeating a write or trust a server message", () => {
    const unknown = describeImportFailure(
      classifyImportFailure(
        new ApiResponseError("Unavailable", 503, {
          message: "Tudo importado!",
        }),
      ),
      "document",
    );
    expect(unknown.outcomeUnknown).toBe(true);
    expect(unknown.retryable).toBe(false);
    expect(unknown.message).toContain("Consulte o estado guardado");
    expect(unknown.message).not.toContain("Tudo importado");
    const disabled = describeImportFailure(
      {
        kind: "api",
        status: 503,
        error: {
          code: "CAPABILITY_DISABLED",
          retryable: false,
          sessionId: "s1",
          currentRevision: 4,
          reason: null,
        },
      },
      "document",
    );
    expect(disabled.outcomeUnknown).toBe(false);
    expect(disabled.retryable).toBe(false);
    expect(disabled.message).toContain("indisponível");
  });
  it("accepts exactly the wire shape for every code", () => {
    for (const code of WIRE_CODES)
      expect(isImportSessionErrorBody(body({ code }))).toBe(true);
  });

  it("accepts the refinement reasons and null ids", () => {
    expect(
      isImportSessionErrorBody(body({ reason: "ATTACHMENT_IN_FLIGHT" })),
    ).toBe(true);
    expect(
      isImportSessionErrorBody(body({ reason: "WRITE_BUDGET_EXCEEDED" })),
    ).toBe(true);
    expect(
      isImportSessionErrorBody(
        body({ sessionId: null, currentRevision: null }),
      ),
    ).toBe(true);
  });

  it("rejects an unknown code, a bad reason and wrong types", () => {
    expect(isImportSessionErrorBody(body({ code: "NOPE" }))).toBe(false);
    expect(isImportSessionErrorBody(body({ reason: "OTHER" }))).toBe(false);
    expect(isImportSessionErrorBody(body({ retryable: "yes" }))).toBe(false);
    expect(isImportSessionErrorBody(body({ currentRevision: 1.5 }))).toBe(
      false,
    );
    expect(isImportSessionErrorBody(body({ sessionId: 7 }))).toBe(false);
  });

  it("rejects a body with an extra key or a missing key, so a server message is never trusted", () => {
    expect(isImportSessionErrorBody(body({ message: "boom" }))).toBe(false);
    expect(isImportSessionErrorBody(body({ statusCode: 400 }))).toBe(false);
    const { reason: _reason, ...withoutReason } = body();
    expect(isImportSessionErrorBody(withoutReason)).toBe(false);
    expect(isImportSessionErrorBody(null)).toBe(false);
    expect(isImportSessionErrorBody([])).toBe(false);
  });
});

describe("classifyImportFailure", () => {
  it("reads a real ImportSessionErrorV1 body for 409, 410 and 503", () => {
    const conflict = classifyImportFailure(
      new ApiResponseError("HTTP 409", 409, body()),
    );
    expect(conflict).toMatchObject({
      kind: "api",
      status: 409,
      error: { code: "REVISION_CONFLICT", currentRevision: 4 },
    });
    const disabled = classifyImportFailure(
      new ApiResponseError(
        "HTTP 503",
        503,
        body({
          code: "CAPABILITY_DISABLED",
          retryable: true,
          sessionId: null,
          currentRevision: null,
        }),
      ),
    );
    expect(disabled).toMatchObject({
      kind: "api",
      status: 503,
      error: { code: "CAPABILITY_DISABLED" },
    });
  });

  it("keeps the generic Nest 404/500 and the extra-key 400 out of the typed path", () => {
    expect(
      classifyImportFailure(
        new ApiResponseError("Not Found", 404, {
          statusCode: 404,
          message: "Not Found",
        }),
      ),
    ).toEqual({ kind: "http", status: 404 });
    expect(
      classifyImportFailure(
        new ApiResponseError("Internal server error", 500, {
          statusCode: 500,
          message: "Internal server error",
        }),
      ),
    ).toEqual({ kind: "http", status: 500 });
    expect(
      classifyImportFailure(
        new ApiResponseError("property x should not exist", 400, {
          statusCode: 400,
          message: ["property x should not exist"],
          error: "Bad Request",
        }),
      ),
    ).toEqual({ kind: "http", status: 400 });
    expect(
      classifyImportFailure(
        new ApiResponseError(
          "HTTP 400",
          400,
          body({ code: "INVALID_INPUT", message: "x" }),
        ),
      ),
    ).toEqual({ kind: "http", status: 400 });
  });

  it("separates offline, timeout and unknown", () => {
    expect(classifyImportFailure(new TypeError("Failed to fetch"))).toEqual({
      kind: "offline",
    });
    expect(classifyImportFailure(new ApiTimeoutError())).toEqual({
      kind: "timeout",
    });
    expect(classifyImportFailure("weird")).toEqual({ kind: "unknown" });
    expect(classifyImportFailure(new Error("x"), false)).toEqual({
      kind: "offline",
    });
  });
});

describe("describeImportFailure", () => {
  it("has copy for exactly the wire codes and never for a server message", () => {
    expect(Object.keys(IMPORT_ERROR_COPY).sort()).toEqual(
      [...WIRE_CODES].sort(),
    );
    const interpretationFailure =
      "Não foi possível interpretar agora. Seu texto foi mantido; tente novamente ou use os controles acima.";
    expect(IMPORT_ERROR_COPY.PROVIDER_UNAVAILABLE).toBe(interpretationFailure);
    expect(IMPORT_ERROR_COPY.MODEL_OUTPUT_INVALID).toBe(interpretationFailure);
  });

  it("shows visible copy plus retry for a generic 500, timeout and offline", () => {
    for (const failure of [
      classifyImportFailure(
        new ApiResponseError("Internal server error", 500, {
          statusCode: 500,
          message: "Internal server error",
        }),
      ),
      classifyImportFailure(new ApiTimeoutError()),
      classifyImportFailure(new TypeError("Failed to fetch")),
    ]) {
      const info = describeImportFailure(failure, "list");
      expect(info.message.length).toBeGreaterThan(10);
      expect(info.message).not.toMatch(/Internal server error/);
      expect(info.retryable).toBe(true);
    }
  });

  it("answers a generic 404 without inferring hidden projects or existence", () => {
    const info = describeImportFailure({ kind: "http", status: 404 }, "result");
    expect(info.retryable).toBe(false);
    expect(info.message).not.toMatch(/projeto|permiss/i);
  });

  it("treats an unclear cancel outcome as unknown, never as success", () => {
    for (const failure of [
      { kind: "timeout" } as const,
      { kind: "offline" } as const,
      { kind: "http", status: 500 } as const,
    ]) {
      const info = describeImportFailure(failure, "cancel");
      expect(info.outcomeUnknown).toBe(true);
      expect(info.message).toMatch(/confirmar/i);
    }
    expect(
      describeImportFailure({ kind: "http", status: 404 }, "cancel")
        .outcomeUnknown,
    ).toBe(false);
  });

  it("follows the wire retryable flag for typed errors", () => {
    const retry = describeImportFailure(
      {
        kind: "api",
        status: 503,
        error: {
          code: "CAPABILITY_DISABLED",
          retryable: true,
          sessionId: null,
          currentRevision: null,
          reason: null,
        },
      },
      "list",
    );
    expect(retry.retryable).toBe(true);
    const stop = describeImportFailure(
      {
        kind: "api",
        status: 410,
        error: {
          code: "SESSION_EXPIRED",
          retryable: false,
          sessionId: "s",
          currentRevision: null,
          reason: null,
        },
      },
      "detail",
    );
    expect(stop.retryable).toBe(false);
  });
});
