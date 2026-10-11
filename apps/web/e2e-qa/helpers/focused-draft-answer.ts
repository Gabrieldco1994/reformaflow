import { expect, type Locator, type Response } from "@playwright/test";
import { isDeepStrictEqual } from "node:util";
import {
  ExpenseType,
  ImportSessionAmountMeaning,
  LaborCategory,
  type ImportSessionQuestionV1,
  type ImportSessionViewV1,
} from "@reformaflow/domain";

type FixtureFocusedDraftAnswer =
  | { field: "amountMeaning"; value: "TOTAL_PURCHASE" | "INSTALLMENT_CHARGE" }
  | { field: "amountCents"; value: number }
  | { field: "installmentCount"; value: number }
  | { field: "dataCompra" | "firstDueDate"; value: string }
  | { field: "tipoDespesa"; value: ExpenseType }
  | { field: "categoriaMaoDeObra"; value: LaborCategory }
  | {
      field: "decision";
      value:
        | { kind: "CREATE"; acceptNaturalDuplicate: boolean }
        | { kind: "KEEP_EXISTING"; expenseId: string };
    }
  | {
      field: "targets";
      value:
        | []
        | [
            {
              projectId: string;
              roomId: string | null;
              amountCents: number;
            },
          ];
    };

export function isFocusedDraftQuestion(question: ImportSessionQuestionV1) {
  return (
    !("subject" in question) &&
    [
      "amountMeaning",
      "amountCents",
      "installmentCount",
      "dataCompra",
      "firstDueDate",
      "tipoDespesa",
      "categoriaMaoDeObra",
      "decision",
      "targets",
    ].includes(question.field)
  );
}

function reaisLiteral(cents: number) {
  const absolute = Math.abs(cents);
  const integer = Math.floor(absolute / 100);
  return `${cents < 0 ? "-" : ""}${integer},${String(absolute % 100).padStart(2, "0")}`;
}

function strictRequestAnswer(answer: FixtureFocusedDraftAnswer) {
  switch (answer.field) {
    case "amountMeaning":
      return {
        ...answer,
        literal:
          answer.value === ImportSessionAmountMeaning.TOTAL_PURCHASE
            ? "total da compra"
            : "valor da parcela",
      };
    case "amountCents":
      return { ...answer, literal: reaisLiteral(answer.value) };
    case "installmentCount":
      return { ...answer, literal: String(answer.value) };
    case "dataCompra":
    case "firstDueDate":
      return { ...answer, literal: answer.value };
    case "targets":
      return {
        field: answer.field,
        value:
          answer.value.length === 0
            ? { kind: "NO_TARGETS" as const }
            : {
                kind: "TARGET" as const,
                ...answer.value[0],
                literal: reaisLiteral(answer.value[0].amountCents),
              },
      };
    default:
      return answer;
  }
}

/** UI labels read from ImportFocusedDraftQuestion in the independently owned FE.
 * Date evidence is ISO from the fixture; enum is an explicit human test choice.
 */
export async function fillFocusedDraftPreview(
  form: Locator,
  question: ImportSessionQuestionV1,
  firstDueDate: string,
  current: ImportSessionViewV1,
  target?: {
    projectId: string;
    projectName: string;
    roomId: string | null;
    roomName: string | null;
  },
  candidate?: { id: string; description: string },
) {
  expect(isFocusedDraftQuestion(question)).toBe(true);
  expect(firstDueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const affected = current.lines.find((line) =>
    question.lineIds.includes(line.id),
  );
  expect(affected).toBeTruthy();
  const answer = (
    question.field === "amountMeaning"
      ? {
          field: "amountMeaning",
          value: ImportSessionAmountMeaning.TOTAL_PURCHASE,
        }
      : question.field === "amountCents"
        ? { field: "amountCents", value: affected!.amountCents! }
        : question.field === "installmentCount"
          ? {
              field: "installmentCount",
              value: affected!.installmentCount ?? 1,
            }
          : question.field === "dataCompra"
            ? {
                field: "dataCompra",
                value: affected!.dataCompra ?? firstDueDate,
              }
            : question.field === "firstDueDate"
              ? { field: "firstDueDate", value: firstDueDate }
              : question.field === "tipoDespesa"
                ? { field: "tipoDespesa", value: ExpenseType.OUTROS }
                : question.field === "categoriaMaoDeObra"
                  ? {
                      field: "categoriaMaoDeObra",
                      value: LaborCategory.PINTOR,
                    }
                  : question.field === "decision"
                    ? {
                        field: "decision",
                        value: candidate
                          ? {
                              kind: "KEEP_EXISTING",
                              expenseId: candidate.id,
                            }
                          : {
                              kind: "CREATE",
                              acceptNaturalDuplicate: false,
                            },
                      }
                    : {
                        field: "targets",
                        value: target
                          ? [
                              {
                                projectId: target.projectId,
                                roomId: target.roomId,
                                amountCents: affected!.amountCents!,
                              },
                            ]
                          : [],
                      }
  ) as FixtureFocusedDraftAnswer;
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
  } else if (answer.field === "categoriaMaoDeObra") {
    const select = form.getByRole("combobox", {
      name: "Categoria de mão de obra",
      exact: true,
    });
    await select.selectOption(answer.value);
    await expect(select).toHaveValue(answer.value);
  } else if (answer.field === "decision" || answer.field === "targets") {
    const choice = form.getByRole("radio", {
      name:
        answer.field === "decision"
          ? answer.value.kind === "KEEP_EXISTING"
            ? new RegExp(candidate!.description)
            : "Criar nova compra"
          : answer.value.length === 0
            ? "Sem rateio — manter a compra no projeto proprietário"
            : new RegExp(target!.projectName),
      exact:
        (answer.field === "decision" &&
          answer.value.kind !== "KEEP_EXISTING") ||
        (answer.field === "targets" && answer.value.length === 0),
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
    if (
      answer.field === "targets" &&
      answer.value.length === 1 &&
      target?.roomId
    ) {
      const room = form.getByRole("combobox");
      await room.selectOption(target.roomId);
      await expect(room).toHaveValue(target.roomId);
    }
  } else if (answer.field === "amountMeaning") {
    await form
      .getByRole("radio", { name: "Total da compra", exact: true })
      .check();
  } else {
    const control = form.locator("input:not([type=radio])").first();
    const literal =
      answer.field === "amountCents"
        ? reaisLiteral(answer.value)
        : String(answer.value);
    await control.fill(literal);
    await expect(control).toHaveValue(literal);
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
        ? answer.value.kind === "KEEP_EXISTING"
          ? candidate!.description
          : "Criar nova compra"
        : answer.value.length === 0
          ? "Sem rateio — manter no projeto proprietário"
          : target!.projectName,
    );
    const affected = form.getByRole("list", {
      name: "Compras desta pergunta",
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
          "channel",
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
        channel: expect.stringMatching(/^(TEXT|VOICE)$/),
        answer: strictRequestAnswer(answer),
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
          !isDeepStrictEqual(
            (line as unknown as Record<string, unknown>)[answer.field],
            answer.value,
          ),
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
