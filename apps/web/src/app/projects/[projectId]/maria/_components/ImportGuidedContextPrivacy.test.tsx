import type { ComponentProps, ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  ImportSessionAmountMeaning,
  ProjectType,
  type ImportDeclaredFactViewV1,
  type ImportObservationQuestionV1,
  type ImportSessionObservationViewV1,
  type ImportSessionDraftLineV1,
  type ImportSessionQuestionV1,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import { ProjectProvider } from "@/contexts/project-context";
import { ImportFocusedQuestion } from "./ImportFocusedQuestion";
import {
  ImportDeclaredFacts,
  ImportReviewBlockerNotice,
} from "./ImportReviewBlockerNotice";

afterEach(cleanup);

const LINE_ID = "550e8400-e29b-41d4-a716-446655440000";
const OBSERVATION_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const QUESTION_ID = "9fd160aa-52b6-4df1-bb10-9a179900a201";
const DRAFT_QUESTION_ID = "9fd160aa-52b6-4df1-bb10-9a179900a202";

function draftLine(
  overrides: Partial<ImportSessionDraftLineV1> = {},
): ImportSessionDraftLineV1 {
  return {
    id: LINE_ID,
    observationIds: [OBSERVATION_ID],
    titulo: "Liquidificador 900 W",
    fornecedor: "Loja Aurora",
    tipoDespesa: null,
    categoriaMaoDeObra: null,
    amountMeaning: ImportSessionAmountMeaning.TOTAL_PURCHASE,
    amountCents: 12_345,
    installmentCount: 3,
    dataCompra: "2026-09-07",
    firstDueDate: null,
    targets: [],
    decision: { kind: "CREATE", acceptNaturalDuplicate: false },
    ...overrides,
  };
}

const amountQuestion: ImportObservationQuestionV1 = {
  id: QUESTION_ID,
  lineIds: [LINE_ID],
  field: "amountCents",
  text: "Qual é o valor da compra?",
  subject: {
    kind: "OBSERVATION",
    observationId: OBSERVATION_ID,
    meaningContext: ImportSessionAmountMeaning.TOTAL_PURCHASE,
  },
  answerState: "UNANSWERED",
};

function withProject(children: ReactNode) {
  return (
    <ProjectProvider
      value={{
        projectId: "project-owner",
        projectName: "Projeto",
        projectType: ProjectType.REFORMA,
      }}
    >
      {children}
    </ProjectProvider>
  );
}

function forbiddenPresentationText(...extra: string[]) {
  const escape = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    [
      LINE_ID,
      OBSERVATION_ID,
      QUESTION_ID,
      DRAFT_QUESTION_ID,
      "amountMeaning",
      ImportSessionAmountMeaning.TOTAL_PURCHASE,
      ImportSessionAmountMeaning.INSTALLMENT_CHARGE,
      ImportSessionAmountMeaning.UNKNOWN,
      ...extra,
    ]
      .map(escape)
      .join("|"),
    "i",
  );
}

function expectNoInternalPresentationText(...extra: string[]) {
  const forbidden = forbiddenPresentationText(...extra);
  expect(document.body.textContent ?? "").not.toMatch(forbidden);

  for (const role of [
    "article",
    "button",
    "form",
    "group",
    "list",
    "radio",
    "alert",
    "status",
  ] as const) {
    screen
      .queryAllByRole(role)
      .forEach((element) =>
        expect(element).not.toHaveAccessibleName(forbidden),
      );
  }

  document.body
    .querySelectorAll<HTMLElement>(
      "[title], [alt], [placeholder], [aria-label], [aria-description], [aria-roledescription], [aria-valuetext], [aria-placeholder]",
    )
    .forEach((element) => {
      for (const attribute of [
        "title",
        "alt",
        "placeholder",
        "aria-label",
        "aria-description",
        "aria-roledescription",
        "aria-valuetext",
        "aria-placeholder",
      ]) {
        expect(element.getAttribute(attribute) ?? "").not.toMatch(forbidden);
      }
    });
  document.body
    .querySelectorAll<HTMLElement>("[aria-describedby]")
    .forEach((element) => {
      const description = element
        .getAttribute("aria-describedby")
        ?.split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      expect(description ?? "").not.toMatch(forbidden);
    });
}

it("uses merchant-first guided context and preserves the structured amount answer", () => {
  const onAnswer = vi.fn();
  render(
    <ImportFocusedQuestion
      question={amountQuestion}
      lines={[draftLine()]}
      inputLabel="Valor da compra"
      inputHint="Confira antes de guardar."
      declaredFacts={[]}
      onAnswer={onAnswer}
    />,
  );

  const purchaseList = screen.getByRole("list", {
    name: "Compras desta pergunta",
  });
  expect(purchaseList).toHaveTextContent(/^Loja Aurora/);
  expect(purchaseList).toHaveTextContent("Liquidificador 900 W");
  expect(purchaseList).toHaveTextContent("07/09/2026");
  expect(purchaseList).toHaveTextContent("R$ 123,45");
  expect(purchaseList).toHaveTextContent("Total");
  expect(purchaseList).toHaveTextContent("3 parcelas");
  expect(
    screen.getByRole("form", { name: amountQuestion.text }),
  ).toHaveAccessibleName(amountQuestion.text);
  expect(screen.getByLabelText("Valor da compra").className).toContain(
    "min-h-11",
  );
  expect(screen.getByLabelText("Valor da compra").className).toContain(
    "focus-visible:outline",
  );
  expect(
    screen.getByRole("button", { name: "Conferir informação" }).className,
  ).toContain("min-h-11");
  expect(
    screen.getByRole("button", { name: "Guardar informação" }).className,
  ).toContain("min-h-11");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expectNoInternalPresentationText();

  fireEvent.change(screen.getByLabelText("Valor da compra"), {
    target: { value: "123,45" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Conferir informação" }));
  expect(screen.getByLabelText("Prévia da informação")).toBeInTheDocument();
  expectNoInternalPresentationText();
  fireEvent.click(screen.getByRole("button", { name: "Guardar informação" }));

  expect(onAnswer).toHaveBeenCalledOnce();
  expect(onAnswer).toHaveBeenCalledWith({
    id: QUESTION_ID,
    text: "123,45",
    input: { kind: "VALUE", text: "123,45" },
    answer: {
      field: "amountCents",
      value: 12_345,
      meaningContext: ImportSessionAmountMeaning.TOTAL_PURCHASE,
    },
  });
  expectNoInternalPresentationText();
});

it("maps known amount meaning to a human label while keeping its canonical answer", () => {
  const onAnswer = vi.fn();
  const question: ImportSessionQuestionV1 = {
    id: DRAFT_QUESTION_ID,
    lineIds: [LINE_ID],
    field: "amountMeaning",
    text: "Informe o significado do valor.",
  };
  render(
    withProject(
      <ImportFocusedQuestion
        question={question}
        lines={[
          draftLine({
            amountMeaning: ImportSessionAmountMeaning.INSTALLMENT_CHARGE,
          }),
        ]}
        inputLabel="Sua resposta"
        inputHint="Confira antes de guardar."
        onAnswer={onAnswer}
      />,
    ),
  );

  const purchaseList = screen.getByRole("list", {
    name: "Compras desta pergunta",
  });
  expect(purchaseList).toHaveTextContent("Loja Aurora");
  expect(purchaseList).toHaveTextContent("Parcela");
  expectNoInternalPresentationText();

  fireEvent.click(screen.getByRole("radio", { name: "Valor da parcela" }));
  fireEvent.click(screen.getByRole("button", { name: "Conferir informação" }));
  fireEvent.click(screen.getByRole("button", { name: "Guardar informação" }));
  expect(onAnswer).toHaveBeenCalledOnce();
  expect(onAnswer).toHaveBeenCalledWith({
    id: DRAFT_QUESTION_ID,
    text: ImportSessionAmountMeaning.INSTALLMENT_CHARGE,
    draftAnswer: {
      field: "amountMeaning",
      value: ImportSessionAmountMeaning.INSTALLMENT_CHARGE,
    },
  });
  expectNoInternalPresentationText();
});

it("shows the exact observation amount and unresolved meaning before the user answers", () => {
  const observation: ImportSessionObservationViewV1 = {
    id: OBSERVATION_ID,
    attachmentId: "36b8f84d-df4e-4d49-b662-bcde71a8764f",
    reference: "linha-1",
    text: "Loja Aurora",
    amountMeaning: ImportSessionAmountMeaning.UNKNOWN,
    amountCents: 12_345,
    installmentCount: null,
    installmentIndex: null,
    dataCompra: "2026-09-07",
  };
  const question: ImportSessionQuestionV1 = {
    id: DRAFT_QUESTION_ID,
    lineIds: [LINE_ID],
    field: "amountMeaning",
    text: "Informe o significado do valor.",
  };

  render(
    withProject(
      <ImportFocusedQuestion
        question={question}
        lines={[
          draftLine({
            amountMeaning: ImportSessionAmountMeaning.UNKNOWN,
            amountCents: null,
          }),
        ]}
        observations={[observation]}
        inputLabel="Sua resposta"
        inputHint="Confira antes de guardar."
        onAnswer={vi.fn()}
      />,
    ),
  );

  const purchaseList = screen.getByRole("list", {
    name: "Compras desta pergunta",
  });
  expect(purchaseList).toHaveTextContent("R$ 123,45");
  expect(purchaseList).toHaveTextContent("Significado a confirmar");
  expect(purchaseList).not.toHaveTextContent("Total");
});

it.each([
  {
    meaning: ImportSessionAmountMeaning.UNKNOWN,
    rawValue: ImportSessionAmountMeaning.UNKNOWN,
  },
  {
    meaning:
      "FUTURE_INTERNAL_MEANING" as ImportSessionDraftLineV1["amountMeaning"],
    rawValue: "FUTURE_INTERNAL_MEANING",
  },
])(
  "marks $rawValue as unresolved without inferring missing source details",
  ({ meaning, rawValue }) => {
    render(
      <ImportFocusedQuestion
        question={amountQuestion}
        lines={[
          draftLine({
            amountMeaning: meaning,
            dataCompra: null,
            installmentCount: null,
          }),
        ]}
        inputLabel="Valor da compra"
        inputHint="Confira antes de guardar."
        declaredFacts={[]}
        onAnswer={vi.fn()}
      />,
    );

    const purchaseList = screen.getByRole("list", {
      name: "Compras desta pergunta",
    });
    expect(purchaseList).toHaveTextContent("Significado a confirmar");
    expect(purchaseList).toHaveTextContent("R$ 123,45");
    expect(purchaseList).not.toHaveTextContent("07/09/2026");
    expect(purchaseList).not.toHaveTextContent("parcela");
    expectNoInternalPresentationText(rawValue);
  },
);

it.each(["constructor", "toString", "__proto__"])(
  "maps malformed amount meaning key %s to unresolved",
  (meaning) => {
    render(
      <ImportFocusedQuestion
        question={amountQuestion}
        lines={[
          draftLine({
            amountMeaning: meaning as ImportSessionDraftLineV1["amountMeaning"],
          }),
        ]}
        inputLabel="Valor da compra"
        inputHint="Confira antes de guardar."
        declaredFacts={[]}
        onAnswer={vi.fn()}
      />,
    );

    const purchaseList = screen.getByRole("list", {
      name: "Compras desta pergunta",
    });
    expect(purchaseList).toHaveTextContent(
      "R$ 123,45 · Significado a confirmar",
    );
    expect(purchaseList).not.toHaveTextContent(
      /function|native code|\[object Object\]/i,
    );
    expectNoInternalPresentationText(meaning);
  },
);

it("falls back to title and then Compra while omitting unavailable context", () => {
  const question: ImportSessionQuestionV1 = {
    id: DRAFT_QUESTION_ID,
    lineIds: [LINE_ID],
    field: "dataCompra",
    text: "Informe a data da compra.",
  };
  const onAnswer = vi.fn();
  const renderQuestion = (line: ImportSessionDraftLineV1) =>
    withProject(
      <ImportFocusedQuestion
        question={question}
        lines={[line]}
        inputLabel="Data da compra"
        inputHint="Confira antes de guardar."
        onAnswer={onAnswer}
      />,
    );
  const { rerender } = render(
    renderQuestion(
      draftLine({
        fornecedor: null,
        titulo: "Serra circular",
        amountCents: null,
        dataCompra: null,
        installmentCount: null,
      }),
    ),
  );

  let purchaseList = screen.getByRole("list", {
    name: "Compras desta pergunta",
  });
  expect(purchaseList).toHaveTextContent(/^Serra circular$/);
  expect(purchaseList).not.toHaveTextContent("R$");
  expect(purchaseList).not.toHaveTextContent("parcela");
  expect(purchaseList).not.toHaveTextContent("Total");
  expect(purchaseList).not.toHaveTextContent(/\d{2}\/\d{2}\/\d{4}/);
  expectNoInternalPresentationText();

  rerender(
    renderQuestion(
      draftLine({
        fornecedor: null,
        titulo: "",
        amountCents: null,
        dataCompra: null,
        installmentCount: null,
      }),
    ),
  );
  purchaseList = screen.getByRole("list", {
    name: "Compras desta pergunta",
  });
  expect(purchaseList).toHaveTextContent(/^Compra$/);
  expect(purchaseList).not.toHaveTextContent("R$");
  expect(purchaseList).not.toHaveTextContent("parcela");
  expectNoInternalPresentationText();
});

it("uses safe blocker and declaration context while retaining the internal include callback", () => {
  const purchase = draftLine();
  const onInclude = vi.fn();
  const blockers: ImportSessionViewV1["reviewBlockers"] = [
    {
      lineId: LINE_ID,
      code: "ORIGINAL_IDENTITY_INCOMPLETE",
      resolution: "NEEDS_DECLARATION",
    },
  ];
  const fact: ImportDeclaredFactViewV1 = {
    lineId: LINE_ID,
    observationId: OBSERVATION_ID,
    questionId: QUESTION_ID,
    origin: "USER_ATTESTATION",
    field: "merchant",
    meaningContext: null,
    status: "CURRENT",
    value: "Loja Aurora",
  };
  const factProps: ComponentProps<typeof ImportDeclaredFacts> = {
    line: purchase,
    facts: [fact],
  };

  render(
    <>
      <ImportReviewBlockerNotice
        line={purchase}
        blockers={blockers}
        selected={false}
        showLine
        onInclude={onInclude}
      />
      <ImportDeclaredFacts {...factProps} />
    </>,
  );

  const article = screen.getByRole("article");
  expect(article).toHaveAccessibleName(/Loja Aurora.*Liquidificador 900 W/);
  expect(article).toHaveTextContent("07/09/2026");
  expect(article).toHaveTextContent("R$ 123,45");
  expect(article).toHaveTextContent("Total");
  expect(article).toHaveTextContent("3 parcelas");
  expect(
    screen.getByRole("group", {
      name: /Nome do estabelecimento.*Loja Aurora.*Liquidificador 900 W/,
    }),
  ).toBeInTheDocument();

  const includeButton = screen.getByRole("button", {
    name: /Incluir compra Loja Aurora.*Liquidificador 900 W.*na revisão/,
  });

  expect(includeButton.className).toContain("min-h-11");
  expect(includeButton.className).toContain("focus-visible:outline");
  expectNoInternalPresentationText();
  fireEvent.click(includeButton);
  expect(onInclude).toHaveBeenCalledOnce();
  expect(onInclude).toHaveBeenCalledWith(LINE_ID);
});

it("gives duplicate purchases unique visible include labels with their amount context", () => {
  const secondLineId = "550e8400-e29b-41d4-a716-446655440001";
  render(
    <>
      <ImportReviewBlockerNotice
        line={draftLine()}
        blockers={[]}
        selected={false}
        showLine
        onInclude={vi.fn()}
      />
      <ImportReviewBlockerNotice
        line={draftLine({
          id: secondLineId,
          amountCents: 67_890,
          amountMeaning: ImportSessionAmountMeaning.INSTALLMENT_CHARGE,
        })}
        blockers={[]}
        selected={false}
        showLine
        onInclude={vi.fn()}
      />
    </>,
  );

  const buttons = screen.getAllByRole("button");
  const visibleLabels = buttons.map((button) => button.textContent?.trim());
  expect(new Set(visibleLabels).size).toBe(buttons.length);
  expect(visibleLabels[0]).toMatch(
    /Incluir.*Loja Aurora.*R\$ 123,45.*Total.*revisão/,
  );
  expect(visibleLabels[1]).toMatch(
    /Incluir.*Loja Aurora.*R\$ 678,90.*Parcela.*revisão/,
  );
});

it("gives selected duplicate purchases unique visible remove labels with their amount context", () => {
  const secondLineId = "550e8400-e29b-41d4-a716-446655440001";
  render(
    <>
      <ImportReviewBlockerNotice
        line={draftLine()}
        blockers={[]}
        selected
        showLine
        onRemove={vi.fn()}
      />
      <ImportReviewBlockerNotice
        line={draftLine({
          id: secondLineId,
          amountCents: 67_890,
          amountMeaning: ImportSessionAmountMeaning.INSTALLMENT_CHARGE,
        })}
        blockers={[]}
        selected
        showLine
        onRemove={vi.fn()}
      />
    </>,
  );

  const buttons = screen.getAllByRole("button");
  const visibleLabels = buttons.map((button) => button.textContent?.trim());
  expect(new Set(visibleLabels).size).toBe(buttons.length);
  expect(visibleLabels[0]).toMatch(
    /Retirar.*Loja Aurora.*R\$ 123,45.*Total.*seleção/,
  );
  expect(visibleLabels[1]).toMatch(
    /Retirar.*Loja Aurora.*R\$ 678,90.*Parcela.*seleção/,
  );
  buttons.forEach((button) =>
    expect(
      button.querySelector<HTMLElement>("[data-workflow-money]")?.className,
    ).toContain("whitespace-nowrap"),
  );
});

it("uses neutral Compra for legacy declarations with only an internal line key", () => {
  const fact: ImportDeclaredFactViewV1 = {
    lineId: LINE_ID,
    observationId: OBSERVATION_ID,
    questionId: QUESTION_ID,
    origin: "USER_ATTESTATION",
    field: "merchant",
    meaningContext: null,
    status: "CURRENT",
    value: "Loja Aurora",
  };
  render(<ImportDeclaredFacts lineId={LINE_ID} facts={[fact]} />);

  expect(
    screen.getByRole("group", {
      name: "Nome do estabelecimento · Compra",
    }),
  ).toHaveTextContent("Nome do estabelecimento · Compra");
  expectNoInternalPresentationText();
});

it("keeps blocker focus management and answer-field focus when pending settles", async () => {
  const onInclude = vi.fn();
  const blockers: ImportSessionViewV1["reviewBlockers"] = [
    {
      lineId: LINE_ID,
      code: "ORIGINAL_IDENTITY_INCOMPLETE",
      resolution: "NEEDS_DECLARATION",
    },
  ];
  const blocker = (selected: boolean) => (
    <ImportReviewBlockerNotice
      line={draftLine()}
      blockers={blockers}
      selected={selected}
      showLine
      onInclude={onInclude}
    />
  );
  const { rerender } = render(blocker(true));
  const heading = screen.getByRole("heading", {
    name: "Verificação documental pendente",
  });
  rerender(blocker(false));
  expect(heading).toHaveFocus();

  const question = {
    ...amountQuestion,
    field: "merchant",
    text: "Qual o estabelecimento?",
    subject: {
      kind: "OBSERVATION" as const,
      observationId: OBSERVATION_ID,
      meaningContext: null,
    },
  } satisfies ImportObservationQuestionV1;
  const answerQuestion = (pending: boolean) => (
    <ImportFocusedQuestion
      question={question}
      lines={[draftLine()]}
      inputLabel="Nome do estabelecimento"
      inputHint="Confira antes de guardar."
      declaredFacts={[]}
      onAnswer={vi.fn()}
      pending={pending}
    />
  );
  const questionRender = render(answerQuestion(true));
  const input = screen.getByLabelText("Nome do estabelecimento");
  expect(input).toBeDisabled();
  questionRender.rerender(answerQuestion(false));
  await waitFor(() => expect(input).toHaveFocus());
  expectNoInternalPresentationText();
});
