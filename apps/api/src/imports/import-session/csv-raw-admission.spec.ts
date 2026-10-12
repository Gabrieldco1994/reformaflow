import { ImportRawExecutions } from "./import-session.raw-executions";
import { ImportSessionError } from "./import-session.errors";
import { ImportUploadService } from "./vault/import-upload.service";
import { mintImportAuthContext } from "./import-session.auth";

describe("CSV-only raw admission", () => {
  it("does not acquire non-CSV execution authority from the broad writer switch", () => {
    const raw = new ImportRawExecutions(
      { boot: { stopped: { aborted: false }, runtime: () => ({}) } } as never,
      { now: () => new Date("2026-10-09T20:00:00.000Z") },
      { writesEnabled: () => true, newImportFormats: () => ["CSV"] },
    );
    expect(() => raw.assertAvailable()).toThrow(ImportSessionError);
    expect(() => raw.assertAvailable("CSV")).not.toThrow();
  });
  it("rejects a PDF reservation even when the broad writer switch is enabled", async () => {
    const now = new Date("2026-10-09T20:00:00.000Z");
    const runtime = {};
    const upload = new ImportUploadService(
      {} as never,
      { now: () => now },
      { writesEnabled: () => true, newImportFormats: () => ["CSV"] },
      {} as never,
      {
        boot: { stopped: { aborted: false }, runtime: () => runtime },
      } as never,
    );
    const auth = mintImportAuthContext({
      tenantId: "tenant-csv",
      userId: "user-csv",
      presentedSessionVersion: 0,
      tokenExpiresAt: "2026-10-10T20:00:00.000Z",
    });
    await expect(
      upload.reserve(
        auth,
        "session-csv",
        {
          expectedRevision: 1,
          files: [
            {
              id: "12345678-1234-4123-8123-123456789abc",
              fileName: "invoice.pdf",
              declaredBytes: 100,
              mime: "application/pdf",
            },
          ],
        },
        {},
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_DOCUMENT" });
  });
});
