import { randomUUID } from "node:crypto";
import {
  ImportUiGrantIssuer,
  RuntimeUiGrantVerifier,
} from "../import-session-ui-grant";
import type {
  AuthenticatedImportContext,
  UiImportGrantScope,
} from "../import-session.contract";

const now = new Date("2026-10-13T20:00:00.000Z");
const auth = {
  tenantId: randomUUID(),
  userId: randomUUID(),
  presentedSessionVersion: 1,
  tokenExpiresAt: "2026-10-13T21:00:00.000Z",
} as AuthenticatedImportContext;
const scope = (): UiImportGrantScope => ({
  operation: "ANALYZE_ATTACHMENT_V2",
  sessionId: randomUUID(),
  attachmentId: randomUUID(),
  expectedRevision: 3,
  actorId: auth.userId,
  artifactSha256: "a".repeat(64),
  consentPolicyVersion: 1,
  requestId: randomUUID(),
  requestPayloadHash: "b".repeat(64),
  decision: "ALLOW_EXTERNAL_PROCESSING",
});

describe("direct OCR consent capability", () => {
  it("rejects handcrafted and every mismatched server binding", () => {
    const issuer = new ImportUiGrantIssuer({ now: () => now });
    const verifier = new RuntimeUiGrantVerifier();
    const request = {};
    issuer.attestRequest(request);
    const exact = scope();
    const grant = issuer.issue(request, auth, exact);

    expect(() => verifier.verify({}, auth, exact, now)).toThrow();
    for (const changed of [
      { ...exact, actorId: randomUUID() },
      { ...exact, expectedRevision: 4 },
      { ...exact, attachmentId: randomUUID() },
      { ...exact, artifactSha256: "c".repeat(64) },
      { ...exact, consentPolicyVersion: 2 },
      { ...exact, requestId: randomUUID() },
      { ...exact, requestPayloadHash: "d".repeat(64) },
      { ...exact, decision: "DENY" },
    ])
      expect(() =>
        verifier.verify(grant, auth, changed as UiImportGrantScope, now),
      ).toThrow();
    expect(verifier.verify(grant, auth, exact, now)).toBe(grant);
  });
});
