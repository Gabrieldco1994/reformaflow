import assert from "node:assert/strict";
import { test } from "node:test";
import type { Response } from "@playwright/test";
import type {
  ImportSessionQuestionV1,
  ImportSessionViewV1,
} from "@reformaflow/domain";
import {
  focusedDraftContract,
  isFocusedDraftQuestion,
} from "./focused-draft-answer";

// Unit tests for the evidence validator only, not mocked journey/release proof.
const sessionId = "session";
const cases = [
  {
    field: "decision" as const,
    value: { kind: "CREATE" as const, acceptNaturalDuplicate: false as const },
  },
  { field: "targets" as const, value: [] as [] },
];
for (const answer of cases) {
  const question = {
    id: "question",
    field: answer.field,
    lineIds: ["selected"],
  } as ImportSessionQuestionV1;
  const before = {
    id: sessionId,
    revision: 9,
    ownerProjectId: "owner",
    cardId: "card",
    selectedLineIds: ["selected"],
    declaredFacts: [],
    confirmation: null,
    receipt: null,
    expiresAt: "2026-10-17T00:00:00.000Z",
    proposal: null,
    lines: [
      { id: "selected", decision: { kind: "UNRESOLVED" }, targets: null },
      { id: "unselected", decision: { kind: "UNRESOLVED" }, targets: null },
    ],
    questions: [question],
  } as unknown as ImportSessionViewV1;
  const fresh = {
    ...before,
    revision: 10,
    questions: [],
    lines: before.lines.map((line) =>
      line.id === "selected" ? { ...line, [answer.field]: answer.value } : line,
    ),
  };
  const request = {
    version: 1,
    answerRequestId: "7262784b-6085-4209-b1ab-9bb3ec9c0959",
    expectedRevision: 9,
    questionId: question.id,
    answer,
  };
  const response = (
    body = fresh,
    payload: unknown = request,
    method = "PATCH",
    path = `/import-sessions/${sessionId}/draft`,
  ) =>
    ({
      request: () => ({ method: () => method, postDataJSON: () => payload }),
      url: () => `http://localhost:3011${path}`,
      status: () => 200,
      ok: () => true,
      json: async () => body,
    }) as unknown as Response;
  const contract = focusedDraftContract(sessionId, question, before, answer);
  test(`${answer.field}: exact structural save, never legacy selection or chat`, async () => {
    assert.equal(contract.matches(response()), true);
    assert.equal(
      contract.matches(response(fresh, { ...request, version: 2 })),
      false,
    );
    assert.equal(
      contract.matches(response(fresh, { selectedLineIds: ["selected"] })),
      false,
    );
    assert.equal(
      contract.matches(response(fresh, request, "POST", "/agent/chat")),
      false,
    );
    await contract.assertSaved(response());
  });
  test(`${answer.field}: rejects extra payload, waived choice, wrong value and unselected edits`, async () => {
    await assert.rejects(
      contract.assertSaved(response(fresh, { ...request, extra: true })),
    );
    await assert.rejects(
      contract.assertSaved(
        response(fresh, {
          ...request,
          answer:
            answer.field === "decision"
              ? {
                  field: "decision",
                  value: { kind: "CREATE", acceptNaturalDuplicate: true },
                }
              : {
                  field: "targets",
                  value: [{ projectId: "other", amountCents: 1 }],
                },
        }),
      ),
    );
    await assert.rejects(
      contract.assertSaved(
        response({
          ...fresh,
          lines: fresh.lines.map((line) => ({ ...line, [answer.field]: null })),
        }),
      ),
    );
    await assert.rejects(
      contract.assertSaved(
        response({ ...fresh, selectedLineIds: ["unselected"] }),
      ),
    );
    await assert.rejects(
      contract.assertSaved(response({ ...fresh, receipt: {} } as typeof fresh)),
    );
  });
  test(`${answer.field}: structural equal values are revision-preserving no-ops`, async () => {
    const equalBefore = { ...fresh, revision: 9, questions: [question] };
    await focusedDraftContract(
      sessionId,
      question,
      equalBefore,
      answer,
    ).assertSaved(response({ ...fresh, revision: 9 }));
  });
}
test("unsupported and documentary choices never enter focused native branch", () => {
  assert.equal(
    isFocusedDraftQuestion({
      field: "category",
    } as unknown as ImportSessionQuestionV1),
    false,
  );
  assert.equal(
    isFocusedDraftQuestion({
      field: "decision",
      subject: {},
    } as unknown as ImportSessionQuestionV1),
    false,
  );
});
