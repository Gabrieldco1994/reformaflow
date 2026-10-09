import { EMPTY_DRAFT_JSON, projectSession } from "./import-session.projection";

describe("ignored-only analysis outcome", () => {
  it("explains an empty eligible set and never exposes a confirmable batch", () => {
    const draft = JSON.parse(EMPTY_DRAFT_JSON);
    draft.scope.observationIds = ["observation-ignored"];
    const now = new Date("2026-10-09T20:00:00.000Z");
    const row = {
      id: "session-ignored",
      state: "NEEDS_INPUT",
      revision: 2,
      ownerProjectId: "project-ignored",
      cardId: "card-ignored",
      draftJson: JSON.stringify(draft),
      proposalJson: null,
      proposalHash: null,
      searchJson: null,
      receiptJson: null,
      challengeJson: null,
      financialRequestId: null,
      confirmedRevision: null,
      confirmedAt: null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 86400000),
    };
    const { view } = projectSession(row as never, [], now, {
      includeReceipt: false,
      documentary: {
        questions: [],
        declaredFacts: [],
        reviewBlockers: [],
        executableAttachmentIds: [],
      },
    });
    expect(view).toHaveProperty("analysisOutcome", "NO_ELIGIBLE_PURCHASES");
    expect(view.proposal).toBeNull();
    expect(view.actions).not.toContain("CONFIRM");
    expect(view.actions).not.toContain("EXECUTE");
  });
});
