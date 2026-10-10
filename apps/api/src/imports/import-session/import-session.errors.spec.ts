import {
  ArgumentsHost,
  ForbiddenException,
  UnauthorizedException,
} from "@nestjs/common";
import { ImportSessionErrorCode } from "@reformaflow/domain";
import {
  ImportSessionCorruptStateError,
  ImportSessionError,
  ImportSessionExceptionFilter,
  importSessionWire,
} from "./import-session.errors";

/**
 * AC18 freeze: the wire error carries a required, nullable machine `reason` next to the
 * five existing codes' shape. No new error code exists; the reason is additive.
 */
const WIRE_KEYS = [
  "code",
  "currentRevision",
  "reason",
  "retryable",
  "sessionId",
];

function capture(filter: ImportSessionExceptionFilter, exception: unknown) {
  const sent: { status?: number; body?: unknown } = {};
  const response = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    },
  };
  filter.catch(exception, {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost);
  return sent;
}

describe("ImportSessionError.reason (AC18 freeze)", () => {
  it.each([
    ["PROVIDER_UNAVAILABLE", 503, true],
    ["MODEL_OUTPUT_INVALID", 502, false],
  ] as const)(
    "maps %s to its sanitized standard wire",
    (code, status, retryable) => {
      const error = new ImportSessionError(code);
      expect(error).toMatchObject({ code, status, retryable });
      expect(importSessionWire(error)).toEqual({
        code,
        retryable,
        sessionId: null,
        currentRevision: null,
        reason: null,
      });
    },
  );

  it.each(Object.values(ImportSessionErrorCode))(
    "%s carries reason:null when no reason applies",
    (code) => {
      const error = new ImportSessionError(code);
      expect(error.reason).toBeNull();
      expect(Object.keys(importSessionWire(error)).sort()).toEqual(WIRE_KEYS);
      expect(importSessionWire(error).reason).toBeNull();
    },
  );

  it.each(["ATTACHMENT_IN_FLIGHT", "WRITE_BUDGET_EXCEEDED"] as const)(
    "keeps the closed reason %s on the wire and does not change code/status",
    (reason) => {
      const error = new ImportSessionError(
        ImportSessionErrorCode.STALE_PREVIEW,
        { sessionId: "s1", currentRevision: 3, reason },
      );
      expect(importSessionWire(error)).toEqual({
        code: "STALE_PREVIEW",
        retryable: false,
        sessionId: "s1",
        currentRevision: 3,
        reason,
      });
      expect(error.status).toBe(409);
    },
  );

  it("the filter sends reason:null for typed, guard-mapped and (401/403) authorization failures", () => {
    const filter = new ImportSessionExceptionFilter();
    const typed = capture(
      filter,
      new ImportSessionError(ImportSessionErrorCode.NOT_FOUND),
    );
    const unauthorized = capture(filter, new UnauthorizedException());
    const forbidden = capture(filter, new ForbiddenException());
    expect(typed.body).toEqual({
      code: "NOT_FOUND",
      retryable: false,
      sessionId: null,
      currentRevision: null,
      reason: null,
    });
    expect(unauthorized).toEqual({
      status: 401,
      body: {
        code: "UNAUTHENTICATED",
        retryable: false,
        sessionId: null,
        currentRevision: null,
        reason: null,
      },
    });
    expect(forbidden).toEqual({
      status: 404,
      body: {
        code: "NOT_FOUND",
        retryable: false,
        sessionId: null,
        currentRevision: null,
        reason: null,
      },
    });
  });

  it("an unknown/corrupt failure stays the generic 500 (no reason, no content)", () => {
    const filter = new ImportSessionExceptionFilter();
    const sent = capture(
      filter,
      new ImportSessionCorruptStateError("proposal"),
    );
    expect(sent).toEqual({
      status: 500,
      body: { statusCode: 500, message: "Internal server error" },
    });
  });
});
