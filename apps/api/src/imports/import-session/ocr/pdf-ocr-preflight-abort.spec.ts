import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { ImportAttachmentController } from "../vault/import-attachment.controller";

describe("OCR analyze disconnect before async preflight", () => {
  it("installs abort listeners before consent/grant preflight and never analyzes", async () => {
    let resolvePreflight!: (scope: {
      operation: "ANALYZE_ATTACHMENT_V2";
      sessionId: string;
      attachmentId: string;
      expectedRevision: number;
      actorId: string;
      artifactSha256: string;
      consentPolicyVersion: 1;
      requestId: string;
      requestPayloadHash: string;
      decision: "ALLOW_EXTERNAL_PROCESSING";
    }) => void;
    const held = new Promise<Parameters<typeof resolvePreflight>[0]>(
      (resolve) => {
        resolvePreflight = resolve;
      },
    );
    const extraction = {
      assertAvailable: jest.fn(),
      analyzeGrantScope: jest.fn().mockReturnValue(held),
      analyzeAttached: jest.fn(),
    };
    const issuer = { issue: jest.fn() };
    const controller = new ImportAttachmentController(
      {} as never,
      {} as never,
      issuer as never,
      extraction as never,
    );
    const request = new EventEmitter();
    const response = Object.assign(new EventEmitter(), {
      writableFinished: false,
    });
    const sessionId = randomUUID();
    const attachmentId = randomUUID();
    const actorId = randomUUID();
    const requestId = randomUUID();
    const pending = controller.analyze(
      {
        tenantId: randomUUID(),
        userId: actorId,
        presentedSessionVersion: 1,
        tokenExpiresAt: "2026-10-13T22:00:00.000Z",
      },
      request as never,
      response as never,
      sessionId,
      attachmentId,
      {},
      {
        version: 2,
        expectedRevision: 3,
        requestId,
        consentExternalProcessing: true,
      },
    );
    await Promise.resolve();
    expect(extraction.analyzeGrantScope).toHaveBeenCalledTimes(1);
    request.emit("aborted");
    expect(extraction.analyzeGrantScope.mock.calls[0]![4]).toMatchObject({
      aborted: true,
    });
    resolvePreflight({
      operation: "ANALYZE_ATTACHMENT_V2",
      sessionId,
      attachmentId,
      expectedRevision: 3,
      actorId,
      artifactSha256: "a".repeat(64),
      consentPolicyVersion: 1,
      requestId,
      requestPayloadHash: "b".repeat(64),
      decision: "ALLOW_EXTERNAL_PROCESSING",
    });

    await expect(pending).rejects.toMatchObject({ code: "OCR_UNAVAILABLE" });
    expect(issuer.issue).not.toHaveBeenCalled();
    expect(extraction.analyzeAttached).not.toHaveBeenCalled();
  });
});
