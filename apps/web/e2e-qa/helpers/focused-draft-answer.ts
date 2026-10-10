import { expect, type Locator, type Response } from "@playwright/test";
import { isDeepStrictEqual } from "node:util";
import {
  ExpenseType,
  type ImportSessionFocusedDraftAnswerV1,
  type ImportSessionQuestionV1,
  type ImportSessionViewV1,
} from "@reformaflow/domain";

/** Narrow pending integration contract; no duplicate waiver or allocation choice. */
type FixtureFocusedDraftAnswer =
  | ImportSessionFocusedDraftAnswerV1
  | {
      field: "decision";
      value: { kind: "CREATE"; acceptNaturalDuplicate: false };
    }
  | { field: "targets"; value: [] };

export function isFocusedDraftQuestion(question: ImportSessionQuestionV1) {
  return (
    !("subject" in question) &&
    ["firstDueDate", "tipoDespesa", "decision", "targets"].includes(
      question.field,
    )
  );
}

/** UI labels read from ImportFocusedDraftQuestion in the independently owned FE.
 * Date evidence is ISO from the fixture; enum is an explicit human test choice.
 */
export async function fillFocusedDraftPreview(
  form: Locator,
  question: ImportSessionQuestionV1,
  firstDueDate: string,
  current: ImportSessionViewV1,
) {
  expect(isFocusedDraftQuestion(question)).toBe(true);
  expect(firstDueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const answer: FixtureFocusedDraftAnswer =
    question.field === "firstDueDate"
      ? { field: "firstDueDate", value: firstDueDate }
      : question.field === "tipoDespesa"
        ? { field: "tipoDespesa", value: ExpenseType.OUTROS }
        : question.field === "decision"
          ? {
              field: "decision",
              value: { kind: "CREATE", acceptNaturalDuplicate: false },
            }
          : { field: "targets", value: [] };
  if (answer.field === "firstDueDate") {
    const date = form.getByLabel("Primeiro vencimento", { exact: true });
    await expect(date).toHaveAttribute("type", "date");
    await date.fill(firstDueDate);
    await expect(date).toHaveValue(firstDueDate);
  } else if (answer.field === "tipoDespesa") {
    const select = form.getByRole("combobox", {
      name: "Tipo de despesa",
      exact: true,
    });
    await select.selectOption(ExpenseType.OUTROS);
    await expect(select).toHaveValue(ExpenseType.OUTROS);
  } else {
    const choice = form.getByRole("radio", {
      name:
        answer.field === "decision"
          ? "Criar nova compra"
          : "Sem rateio — manter a compra no projeto proprietário",
      exact: true,
    });
    // Admission must be a deliberate human choice, not a default or affirmative text.
    await expect(choice).not.toBeChecked();
    await expect(
      form.getByRole("button", { name: "Guardar informação", exact: true }),
    ).toBeDisabled();
    await expect(
      form.getByLabel("Prévia da informação", { exact: true }),
    ).toHaveCount(0);
    await choice.check();
    await expect(choice).toBeChecked();
  }
  await form
    .getByRole("button", { name: "Conferir informação", exact: true })
    .click();
  await expect(
    form.getByLabel("Prévia da informação", { exact: true }),
  ).toBeVisible();
  if (answer.field === "decision" || answer.field === "targets") {
    const preview = form.getByLabel("Prévia da informação", { exact: true });
    await expect(preview).toContainText(
      answer.field === "decision"
        ? "Criar nova compra"
        : "Sem rateio — manter a compra no projeto proprietário",
    );
    const affected = preview.getByRole("list", {
      name: "Compras afetadas pela escolha",
      exact: true,
    });
    await expect(affected.getByRole("listitem")).toHaveCount(
      question.lineIds.length,
    );
    for (const id of question.lineIds) {
      const line = current.lines.find((line) => line.id === id);
      expect(line).toBeTruthy();
      await expect(affected).toContainText(`${line!.titulo} — Compra ${id}`);
    }
  }
  return answer;
}

/** Observe the whole preview/save capture; native choices cannot also send an LLM ANSWER. */
export async function nativeFocusedOnly<T>(
  form: Locator,
  operation: () => Promise<T>,
) {
  const conversational: unknown[] = [];
  const page = form.page();
  const onRequest = (request: import("@playwright/test").Request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/agent/chat" &&
      request.postDataJSON()?.importTurn?.intent === "ANSWER"
    )
      conversational.push(request.postDataJSON().importTurn);
  };
  page.on("request", onRequest);
  try {
    const result = await operation();
    expect(
      conversational,
      "Focused typed answers must not call agent chat",
    ).toEqual([]);
    return result;
  } finally {
    page.off("request", onRequest);
  }
}

export function focusedDraftContract(
  sessionId: string,
  question: ImportSessionQuestionV1,
  current: ImportSessionViewV1,
  answer: FixtureFocusedDraftAnswer,
) {
  expect(isFocusedDraftQuestion(question)).toBe(true);
  expect(question.field).toBe(answer.field);
  return {
    matches: (response: Response) =>
      response.request().method() === "PATCH" &&
      new URL(response.url()).pathname ===
        `/import-sessions/${sessionId}/draft` &&
      response.request().postDataJSON()?.version === 1 &&
      response.request().postDataJSON()?.answer?.field === question.field &&
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
      expect(fresh.ownerProjectId).toBe(current.ownerProjectId);
      expect(fresh.lines).toHaveLength(current.lines.length);
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
          !isDeepStrictEqual(line[answer.field], answer.value),
      );
      expect(fresh.revision).toBe(current.revision + Number(changed));
      if (changed) expect(fresh.proposal).toBeNull();
      else {
        expect(fresh.expiresAt).toBe(current.expiresAt);
        expect(fresh.proposal).toEqual(current.proposal);
      }
      expect(fresh.questions.some((q) => q.id === question.id)).toBe(false);
    },
  };
}
