import { expect, type Locator, type Response } from "@playwright/test";
import {
  ExpenseType,
  type ImportSessionFocusedDraftAnswerV1,
  type ImportSessionQuestionV1,
  type ImportSessionViewV1,
} from "@reformaflow/domain";

export function isFocusedDraftQuestion(question: ImportSessionQuestionV1) {
  return (
    !("subject" in question) &&
    (question.field === "firstDueDate" || question.field === "tipoDespesa")
  );
}

/** UI labels read from ImportFocusedDraftQuestion in the independently owned FE.
 * Date evidence is ISO from the fixture; enum is an explicit human test choice.
 */
export async function fillFocusedDraftPreview(
  form: Locator,
  question: ImportSessionQuestionV1,
  firstDueDate: string,
) {
  expect(isFocusedDraftQuestion(question)).toBe(true);
  expect(firstDueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const answer: ImportSessionFocusedDraftAnswerV1 =
    question.field === "firstDueDate"
      ? { field: "firstDueDate", value: firstDueDate }
      : { field: "tipoDespesa", value: ExpenseType.OUTROS };
  if (answer.field === "firstDueDate") {
    const date = form.getByLabel("Primeiro vencimento", { exact: true });
    await expect(date).toHaveAttribute("type", "date");
    await date.fill(firstDueDate);
    await expect(date).toHaveValue(firstDueDate);
  } else {
    const select = form.getByRole("combobox", {
      name: "Tipo de despesa",
      exact: true,
    });
    await select.selectOption(ExpenseType.OUTROS);
    await expect(select).toHaveValue(ExpenseType.OUTROS);
  }
  await form
    .getByRole("button", { name: "Conferir informação", exact: true })
    .click();
  await expect(
    form.getByLabel("Prévia da informação", { exact: true }),
  ).toBeVisible();
  return answer;
}

export function focusedDraftContract(
  sessionId: string,
  question: ImportSessionQuestionV1,
  current: ImportSessionViewV1,
  answer: ImportSessionFocusedDraftAnswerV1,
) {
  expect(isFocusedDraftQuestion(question)).toBe(true);
  expect(question.field).toBe(answer.field);
  return {
    matches: (response: Response) =>
      response.request().method() === "PATCH" &&
      new URL(response.url()).pathname ===
        `/import-sessions/${sessionId}/draft` &&
      response.request().postDataJSON()?.questionId === question.id,
    assertSaved: async (response: Response) => {
      const request = response.request().postDataJSON();
      expect(Object.keys(request).sort()).toEqual(
        [
          "version",
          "answerRequestId",
          "expectedRevision",
          "questionId",
          "answer",
        ].sort(),
      );
      expect(request).toEqual({
        version: 1,
        answerRequestId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        ),
        expectedRevision: current.revision,
        questionId: question.id,
        answer,
      });
      expect(response.ok(), `Focused draft HTTP ${response.status()}`).toBe(
        true,
      );
      const fresh: ImportSessionViewV1 = await response.json();
      expect(fresh.id).toBe(sessionId);
      expect(fresh.cardId).toBe(current.cardId);
      expect(fresh.selectedLineIds).toEqual(current.selectedLineIds);
      expect(fresh.declaredFacts).toEqual(current.declaredFacts);
      expect(fresh.confirmation).toBeNull();
      expect(fresh.receipt).toBeNull();
      expect(question.lineIds.length).toBeGreaterThan(0);
      for (const before of current.lines) {
        const after = fresh.lines.filter((line) => line.id === before.id);
        expect(after).toHaveLength(1);
        expect(after[0]).toEqual(
          question.lineIds.includes(before.id)
            ? { ...before, [answer.field]: answer.value }
            : before,
        );
      }
      const changed = current.lines.some(
        (line) =>
          question.lineIds.includes(line.id) &&
          line[answer.field] !== answer.value,
      );
      expect(fresh.revision).toBe(current.revision + Number(changed));
      expect(fresh.questions.some((q) => q.id === question.id)).toBe(false);
    },
  };
}
