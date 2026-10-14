import { Logger } from "@nestjs/common";
import { ImportSessionErrorCode } from "@reformaflow/domain";
import {
  ImportSessionError,
  ImportSessionExceptionFilter,
} from "../import-session.errors";

describe("OCR error and log sanitization", () => {
  it("projects the exact typed body without provider or document content", () => {
    const status = jest.fn().mockReturnThis();
    const json = jest.fn();
    const filter = new ImportSessionExceptionFilter();
    filter.catch(
      new ImportSessionError(ImportSessionErrorCode.OCR_MALFORMED_RESPONSE),
      {
        switchToHttp: () => ({
          getResponse: () => ({ status, json }),
        }),
      } as never,
    );
    expect(json).toHaveBeenCalledWith({
      code: "OCR_MALFORMED_RESPONSE",
      retryable: false,
      sessionId: null,
      currentRevision: null,
      reason: null,
    });
  });

  it("logs only the error class and never token, PDF bytes, or upstream body", () => {
    const leaked = "sensitive-token-%PDF-upstream-body";
    const log = jest.spyOn(Logger.prototype, "error").mockImplementation();
    const status = jest.fn().mockReturnThis();
    const json = jest.fn();
    try {
      new ImportSessionExceptionFilter().catch(new Error(leaked), {
        switchToHttp: () => ({
          getResponse: () => ({ status, json }),
        }),
      } as never);
      expect(JSON.stringify(log.mock.calls)).not.toContain(leaked);
      expect(JSON.stringify(json.mock.calls)).not.toContain(leaked);
      expect(log).toHaveBeenCalledWith("import-sessions request failed: Error");
    } finally {
      log.mockRestore();
    }
  });
});
