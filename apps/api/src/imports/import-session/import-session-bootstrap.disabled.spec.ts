import {
  assertImportSessionOperationAvailable,
  IMPORT_SESSION_WRITES_ENABLED,
  type ImportSessionOperation,
} from "./import-session.disabled";

describe("bootstrap kill-switch policy only; no operational endpoints or grants", () => {
  it("is closed for new persistence, processing, first confirmation and unapplied execution", () => {
    expect(IMPORT_SESSION_WRITES_ENABLED).toBe(false);
    const writes: ImportSessionOperation[] = [
      "CREATE",
      "RESERVE",
      "UPLOAD",
      "FINALIZE_UPLOAD",
      "EDIT",
      "PREPARE",
      "CHALLENGE",
      "FIRST_CONFIRM",
      "EXECUTE_UNAPPLIED",
    ];
    for (const operation of writes) {
      expect(() => assertImportSessionOperationAvailable(operation)).toThrow(
        expect.objectContaining({
          code: "CAPABILITY_DISABLED",
          status: 503,
          retryable: true,
          sessionId: null,
          currentRevision: null,
          reason: null,
        }),
      );
    }
  });

  it("does not let the switch suppress recovery, cancellation or retention work", () => {
    const recovery: ImportSessionOperation[] = [
      "READ_SESSION",
      "READ_RESULT",
      "READ_PRIVATE_EXISTING",
      "CANCEL",
      "REPLAY_CONFIRMATION",
      "REPLAY_APPLIED_RECEIPT",
      "REAP",
    ];
    for (const operation of recovery) {
      expect(() =>
        assertImportSessionOperationAvailable(operation),
      ).not.toThrow();
    }
    // This policy does not authorize a caller or implement a read/cancel/reaper service.
  });
});
