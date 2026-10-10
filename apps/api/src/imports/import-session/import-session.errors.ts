import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Response } from "express";
import {
  ImportSessionErrorCode,
  type ImportSessionErrorV1,
  type ImportSessionId,
  type ImportSessionRevision,
} from "@reformaflow/domain";

const STATUS_BY_CODE: Record<ImportSessionErrorCode, number> = {
  INVALID_INPUT: HttpStatus.BAD_REQUEST,
  UNAUTHENTICATED: HttpStatus.UNAUTHORIZED,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  UI_ACTION_REQUIRED: HttpStatus.FORBIDDEN,
  REVISION_CONFLICT: HttpStatus.CONFLICT,
  IDEMPOTENCY_CONFLICT: HttpStatus.CONFLICT,
  STALE_PREVIEW: HttpStatus.CONFLICT,
  REVIEW_REQUIRED: HttpStatus.CONFLICT,
  SEARCH_TOO_BROAD: HttpStatus.UNPROCESSABLE_ENTITY,
  LIMIT_EXCEEDED: HttpStatus.UNPROCESSABLE_ENTITY,
  UNSUPPORTED_DOCUMENT: HttpStatus.UNPROCESSABLE_ENTITY,
  OCR_REQUIRED: HttpStatus.UNPROCESSABLE_ENTITY,
  DOCUMENT_UNREADABLE: HttpStatus.UNPROCESSABLE_ENTITY,
  PDF_PASSWORD_REQUIRED: HttpStatus.UNPROCESSABLE_ENTITY,
  LEASE_CONFLICT: HttpStatus.CONFLICT,
  RETRYABLE_WRITE_CONFLICT: HttpStatus.SERVICE_UNAVAILABLE,
  CAPABILITY_DISABLED: HttpStatus.SERVICE_UNAVAILABLE,
  SESSION_EXPIRED: HttpStatus.GONE,
  ALREADY_APPLIED: HttpStatus.CONFLICT,
};
const RETRYABLE_CODES: ReadonlySet<ImportSessionErrorCode> = new Set([
  ImportSessionErrorCode.RETRYABLE_WRITE_CONFLICT,
  ImportSessionErrorCode.CAPABILITY_DISABLED,
]);

export interface ImportSessionErrorContext {
  sessionId?: ImportSessionId;
  currentRevision?: ImportSessionRevision;
  reason?: ImportSessionErrorV1["reason"];
}

/**
 * The only failure shape that crosses the intake boundary. The wire body is exactly
 * `ImportSessionErrorV1`: never a message, a stack, a column or a foreign id.
 */
export class ImportSessionError extends Error implements ImportSessionErrorV1 {
  readonly code: ImportSessionErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly sessionId: ImportSessionId | null;
  readonly currentRevision: ImportSessionRevision | null;
  readonly reason: ImportSessionErrorV1["reason"];

  constructor(
    code: ImportSessionErrorCode,
    context: ImportSessionErrorContext = {},
  ) {
    super(code);
    this.name = "ImportSessionError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.retryable = RETRYABLE_CODES.has(code);
    this.sessionId = context.sessionId ?? null;
    this.currentRevision = context.currentRevision ?? null;
    this.reason = context.reason ?? null;
  }
}

export function importSessionWire(
  error: ImportSessionError,
): ImportSessionErrorV1 {
  return {
    code: error.code,
    retryable: error.retryable,
    sessionId: error.sessionId,
    currentRevision: error.currentRevision,
    reason: error.reason,
  };
}

/** Stored state that violates its own contract. Deliberately has NO `code`, message content or fallback. */
export class ImportSessionCorruptStateError extends Error {
  /** Set by the caller that knows the row; only an id, never stored content. */
  sessionId: ImportSessionId | null = null;

  constructor(readonly field: string) {
    // The message never embeds stored text; the filter does not log it either (INT-5).
    super("import session state is corrupted");
    this.name = "ImportSessionCorruptStateError";
  }
}

/**
 * Route-level filter: guard failures (401/403) and every service error leave through the
 * closed `ImportSessionErrorV1` shape; anything unknown is a generic 500 that logs only
 * the error class through the standard logger.
 */
@Catch()
export class ImportSessionExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("ImportSession");

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (exception instanceof ImportSessionError) {
      response.status(exception.status).json(importSessionWire(exception));
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status === HttpStatus.UNAUTHORIZED) {
        this.send(
          response,
          new ImportSessionError(ImportSessionErrorCode.UNAUTHENTICATED),
        );
        return;
      }
      if (status === HttpStatus.FORBIDDEN) {
        // An authorization guard refusing must not become an existence oracle.
        this.send(
          response,
          new ImportSessionError(ImportSessionErrorCode.NOT_FOUND),
        );
        return;
      }
      response.status(status).json(exception.getResponse());
      return;
    }
    // INT-5: class, session id and column only. Never `message`, `stack` or the error object:
    // V8's JSON.parse message quotes a fragment of the (possibly OCR) text it choked on.
    const name = exception instanceof Error ? exception.name : typeof exception;
    const detail =
      exception instanceof ImportSessionCorruptStateError
        ? ` sessionId=${exception.sessionId ?? "unknown"} column=${exception.field}`
        : "";
    this.logger.error(`import-sessions request failed: ${name}${detail}`);
    response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ statusCode: 500, message: "Internal server error" });
  }

  private send(response: Response, error: ImportSessionError): void {
    response.status(error.status).json(importSessionWire(error));
  }
}
