require("../../../../../scripts/test-db-env.cjs");
import type { ImportStoredDeclarationV1 } from "@reformaflow/domain";
import {
  validationDraft,
  validationProposal,
} from "../../test-utils/import-session-validation-fixtures";
import { buildImportPreparationPlan } from "./import-session.preparation";

function input() {
  const draft = validationDraft("project");
  const {
    proposalHash: _hash,
    deferredObservationIds: _observations,
    deferredAttachmentIds: _attachments,
    retainUntil: _retention,
    ...proposalBody
  } = validationProposal("session", "project");
  const scope = { tenantId: "tenant", ownerProjectId: "project" };
  return {
    session: {
      ...scope,
      id: "session",
      cardId: "card",
      revision: 1,
      confirmedRevision: null,
      expiresAt: new Date("2026-10-05T15:00:00.000Z"),
    },
    draft,
    proposalBody,
    observations: draft.scope.observationIds.map((id) => ({
      ...scope,
      id,
      artifactId: "artifact",
      claimVersion: 0,
    })),
    references: [
      {
        ref: {
          ...scope,
          id: "attached",
          sessionId: "session",
          artifactId: "artifact",
          position: 0,
          state: "ATTACHED",
          uploadGeneration: 1,
        },
        artifact: {
          ...scope,
          id: "artifact",
          documentSha256: "a".repeat(64),
          state: "EXTRACTED",
        },
      },
      {
        ref: {
          ...scope,
          id: "attachment-pending",
          sessionId: "session",
          artifactId: "pending",
          position: 1,
          state: "ATTACHED",
          uploadGeneration: 1,
        },
        artifact: {
          ...scope,
          id: "pending",
          documentSha256: "b".repeat(64),
          state: "RAW_READY",
        },
      },
    ],
  };
}
function declaration(
  lineId: string,
  observationId: string,
): ImportStoredDeclarationV1 {
  return {
    field: "installmentCount",
    value: 3,
    meaningContext: null,
    lineId,
    observationId,
    originalFingerprint: "c".repeat(64),
    claimVersion: 0,
    originSessionId: "session",
    recordedRevision: 1,
    questionId: "oq_original",
    turnId: "11111111-1111-4111-8111-111111111111",
    attestedByUserId: "owner",
    attestedAt: "2026-09-28T15:00:00.000Z",
    literalHash: "d".repeat(64),
  };
}
describe("B3 private support and AC18 preparation", () => {
  it("legacy continuation has no invented extension or attestation", () => {
    const plan = buildImportPreparationPlan(input());
    expect(plan.continuationDraft).not.toHaveProperty("declarations");
    expect(plan.proposal).not.toHaveProperty("declarations");
    expect(plan.proposal.retainUntil).toBe("2026-10-05T15:00:00.000Z");
  });
  it("transfers only the deferred line's declaration, preserving every origin field", () => {
    const fixture = input();
    const selected = declaration("line-create", "observation-create");
    const deferred = declaration("line-unknown", "observation-unknown");
    fixture.draft.declarations = { version: 1, items: [selected, deferred] };
    const before = JSON.stringify(fixture.draft);
    const plan = buildImportPreparationPlan(fixture);
    expect(plan.continuationDraft?.declarations).toEqual({
      version: 1,
      items: [deferred],
    });
    expect(JSON.stringify(fixture.draft)).toBe(before);
    expect(plan.proposal.retainUntil).toBe(
      fixture.session.expiresAt.toISOString(),
    );
    expect(plan.continuationDraft?.lines.map((line) => line.id)).toEqual([
      "line-unknown",
    ]);
  });
  it("preserves only pending-line field provenance in the continuation", () => {
    const fixture = input();
    fixture.draft.fieldProvenance = [
      {
        origin: "USER",
        lineId: "line-create",
        field: "decision",
        recordedRevision: 1,
      },
      {
        origin: "FILE",
        lineId: "line-unknown",
        field: "amountMeaning",
        recordedRevision: 1,
      },
    ];

    const plan = buildImportPreparationPlan(fixture);

    expect(plan.continuationDraft?.fieldProvenance).toEqual([
      {
        origin: "FILE",
        lineId: "line-unknown",
        field: "amountMeaning",
        recordedRevision: 1,
      },
    ]);
    expect(plan.proposal).not.toHaveProperty("fieldProvenance");
  });
  it("commits deferred support too, without exposing it in the proposal", () => {
    const fixture = input();
    const legacy = buildImportPreparationPlan(fixture);
    fixture.draft.declarations = {
      version: 1,
      items: [declaration("line-unknown", "observation-unknown")],
    };
    const first = buildImportPreparationPlan(fixture);
    fixture.draft.declarations.items[0].attestedAt = "2026-09-28T16:00:00.000Z";
    const second = buildImportPreparationPlan(fixture);
    expect(first.proposal.proposalHash).not.toBe(legacy.proposal.proposalHash);
    expect(second.proposal.proposalHash).not.toBe(first.proposal.proposalHash);
    expect(Object.keys(first.proposal).sort()).toEqual(
      Object.keys(legacy.proposal).sort(),
    );
    expect(first.proposal).not.toHaveProperty("declaredFacts");
  });
  it("the retained deadline does not renew after support or revision changes", () => {
    const fixture = input();
    fixture.draft.declarations = {
      version: 1,
      items: [declaration("line-unknown", "observation-unknown")],
    };
    const before = buildImportPreparationPlan(fixture);
    fixture.session.revision = 8;
    fixture.proposalBody.revision = 9;
    const after = buildImportPreparationPlan(fixture);
    expect(after.proposal.retainUntil).toBe(before.proposal.retainUntil);
    expect(after.continuationDraft?.declarations).toEqual(
      before.continuationDraft?.declarations,
    );
  });
});
