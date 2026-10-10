import type { INestApplication } from "@nestjs/common";
import {
  IMPORT_SESSION_LIMITS,
  ImportSessionErrorCode,
} from "@reformaflow/domain";
import type { NextFunction, Request, Response } from "express";
import type { IncomingHttpHeaders } from "node:http";
import {
  ImportSessionError,
  importSessionWire,
} from "../import-session.errors";

export type ImportUploadFramingVerdict =
  | { ok: true }
  | {
      ok: false;
      code:
        | typeof ImportSessionErrorCode.INVALID_INPUT
        | typeof ImportSessionErrorCode.UNSUPPORTED_DOCUMENT;
    };

const OCTET_STREAM = "application/octet-stream";
const DECIMAL = /^[0-9]+$/;

const INVALID: ImportUploadFramingVerdict = Object.freeze({
  ok: false,
  code: ImportSessionErrorCode.INVALID_INPUT,
});
const UNSUPPORTED: ImportUploadFramingVerdict = Object.freeze({
  ok: false,
  code: ImportSessionErrorCode.UNSUPPORTED_DOCUMENT,
});

/**
 * The single framing rule of the upload route (design 3A.4). Pure: headers in, verdict out; no
 * database, filesystem, session or authority. The middleware and the PUT controller call THIS
 * function, so the rule cannot fork. `Content-Length == declaredBytes` is not decided here.
 */
export function validateImportUploadFraming(
  headers: IncomingHttpHeaders,
): ImportUploadFramingVerdict {
  if (headers["content-type"] !== OCTET_STREAM) return UNSUPPORTED;
  if (headers["transfer-encoding"] !== undefined) return INVALID;
  const encoding = headers["content-encoding"];
  if (encoding !== undefined && encoding !== "identity") return INVALID;
  const length = headers["content-length"];
  if (typeof length !== "string" || !DECIMAL.test(length)) return INVALID;
  const bytes = Number(length);
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    bytes > IMPORT_SESSION_LIMITS.bytesPerFile
  ) {
    return INVALID;
  }
  return { ok: true };
}

/** Express matches the segments case-insensitively and ignores a trailing slash and the query. */
const CONTENT_ROUTE = "/import-sessions/:id/attachments/:attachmentId/content";

/**
 * Refuses hostile framing on `PUT /import-sessions/:id/attachments/:attachmentId/content` BEFORE
 * Nest's body parsers can consume the body (they are registered by `init()`, after this `use`).
 * Headers only: it does not authenticate, resolve the ids or read any store, so the refusal is
 * generic. Other methods and paths pass untouched. Call once from `main.ts`, after `enableCors`
 * (so a refusal carries the allowed origin's CORS headers) and before `listen`.
 */
export function registerImportUploadFraming(app: INestApplication): void {
  app.use(CONTENT_ROUTE, (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "PUT") return next();
    // Only the exact route: a longer path never reaches the content handler.
    const rest = req.url.split("?", 1)[0]!;
    if (rest !== "" && rest !== "/") return next();
    const verdict = validateImportUploadFraming(req.headers);
    if (verdict.ok) return next();
    const error = new ImportSessionError(verdict.code);
    res.setHeader("Connection", "close");
    // The body is neither read nor drained: closing after the answer keeps a client that goes on
    // sending from holding the socket. It can never turn into an upload.
    res.once("finish", () => req.socket.destroy());
    res.status(error.status).json(importSessionWire(error));
  });
}
