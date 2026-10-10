import { describe, expect, it } from "vitest";
import type { ImportChatTurnV1 } from "@reformaflow/domain";
import {
  readImportChatOutcome,
  readImportChatTurn,
} from "./import-conversation-read";
import { WORKFLOW_REQUEST_ID } from "./import-workflow-fixtures";

const turn: ImportChatTurnV1 = {
  version: 1,
  turnId: WORKFLOW_REQUEST_ID,
  sessionId: "session-a",
  expectedRevision: 7,
  channel: "TEXT",
  literalAnswer: "  206,96  ",
  intent: "ANSWER",
  focus: { id: "q", field: "amountCents", lineIds: ["first"] },
  scope: { kind: "LINES", lineIds: ["first"] },
};
const outcome = {
  version: 1,
  turnId: turn.turnId,
  ref: { sessionId: "session-a", revision: 9 },
  acknowledgment: "EDITED",
  kind: "REVISED_SESSION",
};

describe("untrusted conversation wire", () => {
  it("preserves the literal and accepts a correlated non-unit revision advance", () => {
    expect(readImportChatTurn(turn)).toEqual(turn);
    expect(readImportChatOutcome(outcome, turn)).toEqual(outcome);
  });
  it.each([
    null,
    { ...turn, version: 2 },
    { ...turn, tenantId: "x" },
    { ...turn, expectedRevision: 0 },
    { ...turn, expectedRevision: 1.5 },
    { ...turn, expectedRevision: 2147483648 },
    { ...turn, turnId: "not-a-request" },
    { ...turn, literalAnswer: " " },
    { ...turn, literalAnswer: "x".repeat(4001) },
    { ...turn, focus: null },
    { ...turn, scope: { kind: "LINES", lineIds: ["first", "first"] } },
    { ...turn, scope: { kind: "LINES", lineIds: ["foreign"] } },
    { ...turn, intent: "OPEN_REVIEW" },
  ])("rejects invalid request %j", (bad) =>
    expect(() => readImportChatTurn(bad)).toThrow(),
  );
  it.each([
    null,
    {},
    { ...outcome, nonce: "private" },
    { ...outcome, turnId: "123e4567-e89b-42d3-a456-426614174001" },
    { ...outcome, ref: { sessionId: "foreign", revision: 9 } },
    { ...outcome, ref: { sessionId: "session-a", revision: 6 } },
    { ...outcome, acknowledgment: "PREPARED" },
    { ...outcome, acknowledgment: "NONE" },
    { ...outcome, kind: "OPEN_REVIEW", acknowledgment: "NONE" },
    { ...outcome, kind: "READ_RESULT", acknowledgment: "NONE" },
  ])("rejects incoherent outcome %j", (bad) =>
    expect(() => readImportChatOutcome(bad, turn)).toThrow(),
  );
  it("rejects EDITED with an unchanged revision, without assuming every operation increments by one", () => {
    expect(() =>
      readImportChatOutcome(
        { ...outcome, ref: { sessionId: "session-a", revision: 7 } },
        turn,
      ),
    ).toThrow();
  });
  describe("F1 OPEN_REVIEW revision correlation", () => {
    const reviewTurn: ImportChatTurnV1 = {
      ...turn,
      intent: "OPEN_REVIEW",
      focus: null,
      scope: null,
    };
    it("rejects NONE at r8 for a review requested at r7", () => {
      expect(() =>
        readImportChatOutcome(
          {
            ...outcome,
            kind: "OPEN_REVIEW",
            acknowledgment: "NONE",
            ref: { sessionId: "session-a", revision: 8 },
          },
          reviewTurn,
        ),
      ).toThrow();
    });
    it.each([
      { acknowledgment: "NONE", revision: 7 },
      { acknowledgment: "PREPARED", revision: 8 },
      { acknowledgment: "PREPARED", revision: 10 },
    ])(
      "accepts $acknowledgment at r$revision",
      ({ acknowledgment, revision }) => {
        const review = {
          ...outcome,
          kind: "OPEN_REVIEW",
          acknowledgment,
          ref: { sessionId: "session-a", revision },
        };
        expect(readImportChatOutcome(review, reviewTurn)).toEqual(review);
      },
    );
    it("still allows a newer consultative CONTINUE without mutation acknowledgment", () => {
      const consulted = { ...outcome, acknowledgment: "NONE" };
      expect(
        readImportChatOutcome(consulted, { ...reviewTurn, intent: "CONTINUE" }),
      ).toEqual(consulted);
    });
  });
  it("deterministic intents cannot accept unrelated contextual outcomes", () => {
    const question = {
      version: 1,
      turnId: turn.turnId,
      ref: { sessionId: turn.sessionId, revision: 7 },
      kind: "QUESTION",
      questionId: "q",
      acknowledgment: "NONE",
    };
    expect(() => readImportChatOutcome(question, turn)).toThrow();
    expect(() =>
      readImportChatOutcome(question, {
        ...turn,
        intent: "READ_RESULT",
        focus: null,
        scope: null,
      }),
    ).toThrow();
    expect(
      readImportChatOutcome(question, {
        ...turn,
        intent: "CONTINUE",
        focus: null,
        scope: null,
      }),
    ).toEqual(question);
    const clarify = {
      version: 1,
      turnId: turn.turnId,
      ref: { sessionId: turn.sessionId, revision: 7 },
      acknowledgment: "NONE",
      kind: "CLARIFY",
      reason: "AMBIGUOUS",
      scopeReview: null,
    };
    expect(readImportChatOutcome(clarify, turn)).toEqual(clarify);
    expect(() =>
      readImportChatOutcome(clarify, {
        ...turn,
        intent: "OPEN_REVIEW",
        focus: null,
        scope: null,
      }),
    ).toThrow();
  });
  it("allows newer error references but never opaque references or ERROR+EDITED", () => {
    const error = {
      ...outcome,
      kind: "ERROR",
      code: "REVISION_CONFLICT",
      reason: null,
      acknowledgment: "NONE",
      retryable: false,
      recovery: "READ_SESSION",
      ref: { sessionId: "session-a", revision: 12 },
    };
    expect(readImportChatOutcome(error, turn)).toEqual(error);
    for (const bad of [
      { ...error, acknowledgment: "EDITED" },
      { ...error, code: "UNAUTHENTICATED" },
      { ...error, code: "NOT_FOUND" },
      { ...error, code: "UI_ACTION_REQUIRED" },
      { ...error, acknowledgment: "UNKNOWN", recovery: "NONE" },
    ])
      expect(() => readImportChatOutcome(bad, turn)).toThrow();
  });
  it("scope review is exact, bounded by documentary lines rather than ten selected lines", () => {
    const attachmentTurn = {
      ...turn,
      scope: { kind: "ATTACHMENT" as const, attachmentId: "attachment-a" },
    };
    const review = {
      ...outcome,
      kind: "CLARIFY",
      acknowledgment: "NONE",
      reason: "SCOPE_REVIEW",
      scopeReview: {
        focus: turn.focus,
        attachmentId: "attachment-a",
        lineIds: Array.from({ length: 11 }, (_, i) => `line-${i}`),
      },
    };
    expect(readImportChatOutcome(review, attachmentTurn)).toEqual(review);
    for (const scopeReview of [
      null,
      { ...review.scopeReview, attachmentId: "foreign" },
      { ...review.scopeReview, lineIds: ["first", "first"] },
      { ...review.scopeReview, focus: { ...turn.focus, field: "targets" } },
    ])
      expect(() =>
        readImportChatOutcome({ ...review, scopeReview }, attachmentTurn),
      ).toThrow();
  });
});
