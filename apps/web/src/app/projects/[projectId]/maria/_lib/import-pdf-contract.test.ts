import { describe, expect, it } from "vitest";
import { ApiResponseError } from "@/lib/api";
import { readImportEntryAction } from "./import-entry-action";
import { readImportEntry } from "./import-session-read";
import {
  classifyImportFailure,
  describeImportFailure,
  isImportSessionErrorBody,
} from "./import-session-errors";

describe("textual PDF capability contract", () => {
  it.each([["CSV"], ["CSV", "PDF"]])(
    "accepts qualified formats %j",
    (...formats) => {
      const action = {
        version: 1,
        kind: "START_CARD_INVOICE_IMPORT",
        formats,
        suggestedCardId: null,
      };
      expect(readImportEntryAction(action)).toEqual(action);
      expect(
        readImportEntry({ entry: { kind: "CARD_INVOICE", formats } }),
      ).toEqual({
        kind: "VALID",
        value: { kind: "CARD_INVOICE", formats },
      });
    },
  );

  it.each([
    [],
    ["CSV", "CSV"],
    ["CSV", "PDF", "PDF"],
    ["OFX"],
    ["XLS"],
    ["XLSX"],
    ["PNG"],
    ["CSV", "JPEG"],
  ])("rejects unqualified or ambiguous formats %j", (...formats) => {
    expect(
      readImportEntryAction({
        version: 1,
        kind: "START_CARD_INVOICE_IMPORT",
        formats,
        suggestedCardId: null,
      }),
    ).toBeNull();
    expect(
      readImportEntry({ entry: { kind: "CARD_INVOICE", formats } }),
    ).toEqual({
      kind: "ERROR",
      code: "INVALID_ENTRY",
    });
  });

  it.each(["OCR_REQUIRED", "DOCUMENT_UNREADABLE", "PDF_PASSWORD_REQUIRED"])(
    "recognizes %s as a documentary blocker, never a retry",
    (code) => {
      const body = {
        code,
        retryable: false,
        sessionId: null,
        currentRevision: null,
        reason: null,
      };
      const failure = classifyImportFailure(
        new ApiResponseError("document", 422, body),
      );
      expect(failure.kind).toBe("api");
      const info = describeImportFailure(failure, "document");
      expect(info.code).toBe(code);
      expect(info.retryable).toBe(false);
      expect(info.outcomeUnknown).toBe(false);
      expect(info.message).not.toMatch(/tentar a análise novamente/);
    },
  );

  it("rejects extra-key and invalid future PDF error bodies", () => {
    const body = {
      code: "OCR_REQUIRED",
      retryable: false,
      sessionId: null,
      currentRevision: null,
      reason: null,
    };
    expect(isImportSessionErrorBody({ ...body, message: "untrusted" })).toBe(
      false,
    );
    expect(isImportSessionErrorBody({ ...body, retryable: "false" })).toBe(
      false,
    );
    expect(isImportSessionErrorBody({ ...body, code: "OCR_RETRY" })).toBe(
      false,
    );
  });
});
