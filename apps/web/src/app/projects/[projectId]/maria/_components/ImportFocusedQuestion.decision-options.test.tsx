import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProjectType,
  type ImportSessionCandidateV1,
} from "@reformaflow/domain";
import { ProjectProvider } from "@/contexts/project-context";
import { ImportFocusedQuestion } from "./ImportFocusedQuestion";

afterEach(cleanup);

const decisionQuestion = {
  id: "question-decision",
  field: "decision" as const,
  lineIds: ["line-1"],
  text: "Resolva o conflito",
};

function candidate(
  kind: ImportSessionCandidateV1["kind"],
  reason: ImportSessionCandidateV1["reason"],
  canKeepExisting: boolean,
  id: string,
): ImportSessionCandidateV1 {
  return {
    lineId: "line-1",
    kind,
    id,
    projectId: "project-owner",
    description: `${kind} ${reason}`,
    amountCents: 20_696,
    date: "2026-10-10",
    reason,
    canKeepExisting,
  };
}

function setup(candidates: readonly ImportSessionCandidateV1[]) {
  const onAnswer = vi.fn();
  render(
    <ProjectProvider
      value={{
        projectId: "project-owner",
        projectName: "Projeto proprietário",
        projectType: ProjectType.PESSOAL,
      }}
    >
      <ImportFocusedQuestion
        question={decisionQuestion}
        lines={[
          {
            id: "line-1",
            titulo: "Compra documental",
            amountCents: 20_696,
          },
        ]}
        inputLabel="Decisão"
        inputHint="Confira"
        candidates={candidates}
        onAnswer={onAnswer}
      />
    </ProjectProvider>,
  );
  return onAnswer;
}

function chooseAndSave(name: string | RegExp, testId: string) {
  const radio = screen.getByRole("radio", { name });
  const label = screen.getByTestId(testId);
  expect(label).toHaveClass("min-h-11");
  expect(label).toHaveAttribute("for", radio.id);
  fireEvent.click(label);
  expect(radio).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Conferir informação" }));
  fireEvent.click(screen.getByRole("button", { name: "Guardar informação" }));
}

describe("server-supported import decisions", () => {
  it("offers and submits the natural-match CREATE waiver for an expense", () => {
    const onAnswer = setup([
      candidate("EXPENSE", "NATURAL_MATCH", true, "expense-natural"),
    ]);

    expect(
      screen.queryByRole("radio", { name: "Criar nova compra" }),
    ).not.toBeInTheDocument();
    chooseAndSave(
      "Criar outra compra — são compras distintas",
      "decision-choice-label-CREATE_ACCEPT_NATURAL_DUPLICATE",
    );

    expect(onAnswer).toHaveBeenCalledWith({
      id: "question-decision",
      text: "CREATE_ACCEPT_NATURAL_DUPLICATE",
      draftAnswer: {
        field: "decision",
        value: { kind: "CREATE", acceptNaturalDuplicate: true },
      },
    });
  });

  it("offers and submits KEEP_EXISTING for a compatible natural expense", () => {
    const onAnswer = setup([
      candidate("EXPENSE", "NATURAL_MATCH", true, "expense-natural"),
    ]);

    chooseAndSave(
      /Manter compra existente: EXPENSE NATURAL_MATCH/,
      "decision-choice-label-expense-natural",
    );

    expect(onAnswer).toHaveBeenCalledWith({
      id: "question-decision",
      text: "expense-natural",
      draftAnswer: {
        field: "decision",
        value: { kind: "KEEP_EXISTING", expenseId: "expense-natural" },
      },
    });
  });

  it("offers only the natural-match waiver for a receipt", () => {
    const onAnswer = setup([
      candidate("RECEIPT", "NATURAL_MATCH", false, "receipt-natural"),
    ]);

    expect(screen.getAllByRole("radio")).toHaveLength(1);
    chooseAndSave(
      "Criar outra compra — são compras distintas",
      "decision-choice-label-CREATE_ACCEPT_NATURAL_DUPLICATE",
    );
    expect(onAnswer).toHaveBeenCalledWith({
      id: "question-decision",
      text: "CREATE_ACCEPT_NATURAL_DUPLICATE",
      draftAnswer: {
        field: "decision",
        value: { kind: "CREATE", acceptNaturalDuplicate: true },
      },
    });
  });

  it("offers only KEEP_EXISTING for a compatible strong expense", () => {
    const onAnswer = setup([
      candidate("EXPENSE", "STRONG_IDENTITY", true, "expense-strong"),
    ]);

    expect(screen.getAllByRole("radio")).toHaveLength(1);
    expect(
      screen.queryByRole("radio", {
        name: "Criar outra compra — são compras distintas",
      }),
    ).not.toBeInTheDocument();
    chooseAndSave(
      /Manter compra existente: EXPENSE STRONG_IDENTITY/,
      "decision-choice-label-expense-strong",
    );
    expect(onAnswer).toHaveBeenCalledWith(
      expect.objectContaining({
        draftAnswer: {
          field: "decision",
          value: { kind: "KEEP_EXISTING", expenseId: "expense-strong" },
        },
      }),
    );
  });

  it("offers only KEEP_EXISTING for a compatible installment expense", () => {
    const onAnswer = setup([
      candidate("EXPENSE", "INSTALLMENT_MATCH", true, "expense-installment"),
    ]);

    expect(screen.getAllByRole("radio")).toHaveLength(1);
    chooseAndSave(
      /Manter compra existente: EXPENSE INSTALLMENT_MATCH/,
      "decision-choice-label-expense-installment",
    );
    expect(onAnswer).toHaveBeenCalledOnce();
  });

  it("offers and submits clean CREATE when the candidate catalog is empty", () => {
    const onAnswer = setup([]);

    expect(screen.getAllByRole("radio")).toHaveLength(1);
    chooseAndSave("Criar nova compra", "decision-choice-label-CREATE");

    expect(onAnswer).toHaveBeenCalledOnce();
    expect(onAnswer).toHaveBeenCalledWith({
      id: "question-decision",
      text: "CREATE",
      draftAnswer: {
        field: "decision",
        value: { kind: "CREATE", acceptNaturalDuplicate: false },
      },
    });
  });

  it.each([
    [
      "a strong receipt",
      [candidate("RECEIPT", "STRONG_IDENTITY", false, "receipt-strong")],
    ],
    [
      "an incompatible strong expense",
      [candidate("EXPENSE", "STRONG_IDENTITY", false, "expense-strong")],
    ],
    [
      "a natural candidate shadowed by an unsupported strong conflict",
      [
        candidate("EXPENSE", "NATURAL_MATCH", true, "expense-natural"),
        candidate("RECEIPT", "STRONG_IDENTITY", false, "receipt-strong"),
      ],
    ],
  ] as const)("blocks without a request for %s", (_name, candidates) => {
    const onAnswer = setup(candidates);

    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(
      screen.getByText(
        "Não há uma decisão segura disponível para este conflito. Revise a compra manualmente; nada foi enviado.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Conferir informação" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Guardar informação" }),
    ).toBeDisabled();
    expect(onAnswer).not.toHaveBeenCalled();
  });
});
