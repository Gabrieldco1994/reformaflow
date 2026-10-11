import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  ExpenseType,
  ImportSessionAmountMeaning,
  LaborCategory,
  type ImportSessionCandidateV1,
  type ImportSessionQuestionV1,
} from "@reformaflow/domain";
import { ProjectProvider } from "@/contexts/project-context";
import { ImportFocusedQuestion } from "./ImportFocusedQuestion";

afterEach(cleanup);
function setup(
  field: Exclude<ImportSessionQuestionV1, { subject: unknown }>["field"],
  projectType = "REFORMA",
  options: {
    candidates?: readonly ImportSessionCandidateV1[];
    targetProjects?: readonly {
      id: string;
      name: string;
      projectType: string;
      eligible: boolean;
      rooms: readonly { id: string; name: string }[];
    }[];
  } = {},
) {
  const onAnswer = vi.fn();
  render(
    <ProjectProvider
      value={{ projectId: "project", projectName: "Projeto", projectType }}
    >
      <ImportFocusedQuestion
        question={{
          id: "question",
          lineIds: ["line"],
          field,
          text: "Informe o campo",
        }}
        lines={[{ id: "line", titulo: "Compra", amountCents: 10_000 }]}
        inputLabel="Sua resposta"
        inputHint="Confira antes de guardar"
        onAnswer={onAnswer}
        {...options}
      />
    </ProjectProvider>,
  );
  return onAnswer;
}
it("only human save emits exact date-only answer, without changing its year", () => {
  const onAnswer = setup("firstDueDate");
  fireEvent.change(screen.getByLabelText("Primeiro vencimento"), {
    target: { value: "2025-10-10" },
  });
  expect(onAnswer).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Conferir informação" }));
  expect(onAnswer).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Guardar informação" }));
  expect(onAnswer).toHaveBeenCalledWith({
    id: "question",
    text: "2025-10-10",
    draftAnswer: { field: "firstDueDate", value: "2025-10-10" },
  });
});
it("does not silently choose a default expense or send a disallowed project option", () => {
  const onAnswer = setup("tipoDespesa", "CASA");
  expect(onAnswer).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Tipo de despesa"), {
    target: { value: ExpenseType.MAO_DE_OBRA },
  });
  fireEvent.click(screen.getByRole("button", { name: "Conferir informação" }));
  fireEvent.click(screen.getByRole("button", { name: "Guardar informação" }));
  expect(onAnswer).not.toHaveBeenCalled();
});
it("changing a date invalidates the accepted preview until another explicit check", () => {
  const onAnswer = setup("firstDueDate");
  const input = screen.getByLabelText("Primeiro vencimento");
  fireEvent.change(input, { target: { value: "2025-10-10" } });
  fireEvent.click(screen.getByRole("button", { name: "Conferir informação" }));
  fireEvent.change(input, { target: { value: "2026-10-10" } });
  fireEvent.click(screen.getByRole("button", { name: "Guardar informação" }));
  expect(onAnswer).not.toHaveBeenCalled();
});
it("native expense selection supplies an enum rather than its human label", () => {
  const onAnswer = setup("tipoDespesa");
  fireEvent.change(screen.getByLabelText("Tipo de despesa"), {
    target: { value: ExpenseType.MAO_DE_OBRA },
  });
  expect(onAnswer).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Conferir informação" }));
  expect(onAnswer).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Guardar informação" }));
  expect(onAnswer).toHaveBeenCalledWith({
    id: "question",
    text: ExpenseType.MAO_DE_OBRA,
    draftAnswer: { field: "tipoDespesa", value: ExpenseType.MAO_DE_OBRA },
  });
});
it.each([
  {
    field: "decision" as const,
    label: "Criar nova compra",
    text: "CREATE",
    value: { kind: "CREATE", acceptNaturalDuplicate: false },
  },
  {
    field: "targets" as const,
    label: "Sem rateio — manter no projeto proprietário",
    text: "NO_TARGETS",
    value: [],
  },
])(
  "requires an unselected $field choice, preview, and human save",
  ({ field, label, text, value }) => {
    const onAnswer = setup(field);
    const choice = screen.getByRole("radio", { name: label });
    expect(choice).not.toBeChecked();
    fireEvent.click(
      screen.getByRole("button", { name: "Conferir informação" }),
    );
    expect(onAnswer).not.toHaveBeenCalled();
    fireEvent.click(choice);
    expect(onAnswer).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Conferir informação" }),
    );
    expect(onAnswer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Guardar informação" }));
    expect(onAnswer).toHaveBeenCalledWith({
      id: "question",
      text,
      draftAnswer: { field, value },
    });
  },
);

it("offers explicit duplicate waiver and only an authorized keep candidate", () => {
  const candidate: ImportSessionCandidateV1 = {
    lineId: "line",
    kind: "EXPENSE",
    id: "expense-1",
    projectId: "project",
    description: "Compra existente",
    amountCents: 10_000,
    date: "2026-10-10",
    reason: "NATURAL_MATCH",
    canKeepExisting: true,
  };
  const denied = { ...candidate, id: "expense-2", canKeepExisting: false };
  const onAnswer = setup("decision", "REFORMA", {
    candidates: [candidate, denied],
  });
  expect(
    screen.queryByRole("radio", { name: /expense-2/i }),
  ).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("radio", {
      name: "Criar outra compra — são compras distintas",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Conferir informação" }));
  fireEvent.click(screen.getByRole("button", { name: "Guardar informação" }));
  expect(onAnswer).toHaveBeenCalledWith({
    id: "question",
    text: "CREATE_ACCEPT_NATURAL_DUPLICATE",
    draftAnswer: {
      field: "decision",
      value: { kind: "CREATE", acceptNaturalDuplicate: true },
    },
  });
});

it("builds one project-room integral target using the purchase amount", () => {
  const onAnswer = setup("targets", "REFORMA", {
    targetProjects: [
      {
        id: "project-2",
        name: "Casa",
        projectType: "REFORMA",
        eligible: true,
        rooms: [{ id: "room-2", name: "Cozinha" }],
      },
    ],
  });
  fireEvent.click(
    screen.getByRole("radio", {
      name: "Enviar o valor integral para outro projeto",
    }),
  );
  fireEvent.change(screen.getByLabelText("Projeto de destino"), {
    target: { value: "project-2" },
  });
  fireEvent.change(screen.getByLabelText("Cômodo (opcional)"), {
    target: { value: "room-2" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Conferir informação" }));
  fireEvent.click(screen.getByRole("button", { name: "Guardar informação" }));
  expect(onAnswer).toHaveBeenCalledWith({
    id: "question",
    text: "target",
    draftAnswer: {
      field: "targets",
      value: [
        {
          projectId: "project-2",
          roomId: "room-2",
          amountCents: 10_000,
        },
      ],
    },
  });
});

it("clears the room when the selected destination project changes", () => {
  setup("targets", "REFORMA", {
    targetProjects: [
      {
        id: "project-2",
        name: "Reforma 2",
        projectType: "REFORMA",
        eligible: true,
        rooms: [{ id: "room-2", name: "Cozinha" }],
      },
      {
        id: "project-3",
        name: "Reforma 3",
        projectType: "REFORMA",
        eligible: true,
        rooms: [{ id: "room-3", name: "Quarto" }],
      },
    ],
  });
  fireEvent.click(
    screen.getByRole("radio", {
      name: "Enviar o valor integral para outro projeto",
    }),
  );
  const project = screen.getByLabelText("Projeto de destino");
  const room = screen.getByLabelText("Cômodo (opcional)");
  fireEvent.change(project, { target: { value: "project-2" } });
  fireEvent.change(room, { target: { value: "room-2" } });
  expect(room).toHaveValue("room-2");

  fireEvent.change(project, { target: { value: "project-3" } });

  expect(room).toHaveValue("");
  expect(
    screen.queryByRole("option", { name: "Cozinha" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("option", { name: "Quarto" })).toBeInTheDocument();
});

it.each([
  {
    field: "amountCents" as const,
    label: "Valor da compra",
    value: "1.234,56",
    answer: { field: "amountCents", value: 123456 },
  },
  {
    field: "installmentCount" as const,
    label: "Quantidade de parcelas",
    value: "3",
    answer: { field: "installmentCount", value: 3 },
  },
  {
    field: "dataCompra" as const,
    label: "Data da compra",
    value: "2026-10-11",
    answer: { field: "dataCompra", value: "2026-10-11" },
  },
])("previews and saves strict $field", ({ field, label, value, answer }) => {
  const onAnswer = setup(field);
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Conferir informação" }));
  expect(screen.getByLabelText("Prévia da informação")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Guardar informação" }));
  expect(onAnswer).toHaveBeenCalledWith({
    id: "question",
    text: value,
    draftAnswer: answer,
  });
});

it("uses amount-meaning radios and labor-category enum options", () => {
  const meaningAnswer = setup("amountMeaning");
  fireEvent.click(screen.getByRole("radio", { name: "Total da compra" }));
  fireEvent.click(screen.getByRole("button", { name: "Conferir informação" }));
  fireEvent.click(screen.getByRole("button", { name: "Guardar informação" }));
  expect(meaningAnswer).toHaveBeenCalledWith({
    id: "question",
    text: ImportSessionAmountMeaning.TOTAL_PURCHASE,
    draftAnswer: {
      field: "amountMeaning",
      value: ImportSessionAmountMeaning.TOTAL_PURCHASE,
    },
  });
  cleanup();
  const laborAnswer = setup("categoriaMaoDeObra");
  fireEvent.change(screen.getByLabelText("Categoria de mão de obra"), {
    target: { value: LaborCategory.EMPREITEIRO },
  });
  fireEvent.click(screen.getByRole("button", { name: "Conferir informação" }));
  fireEvent.click(screen.getByRole("button", { name: "Guardar informação" }));
  expect(laborAnswer).toHaveBeenCalledWith({
    id: "question",
    text: LaborCategory.EMPREITEIRO,
    draftAnswer: {
      field: "categoriaMaoDeObra",
      value: LaborCategory.EMPREITEIRO,
    },
  });
});

it("voice fills an unambiguous preview without submitting", async () => {
  const onAnswer = vi.fn();
  render(
    <ProjectProvider
      value={{
        projectId: "project",
        projectName: "Projeto",
        projectType: "REFORMA",
      }}
    >
      <ImportFocusedQuestion
        question={{
          id: "question",
          lineIds: ["line"],
          field: "amountCents",
          text: "Qual valor?",
        }}
        lines={[{ id: "line", titulo: "Compra", amountCents: 10_000 }]}
        inputLabel="Valor"
        inputHint="Confira"
        value="1.234,56"
        revision={7}
        voiceCapture={{
          id: 1,
          text: "1.234,56",
          questionId: "question",
          revision: 7,
        }}
        onAnswer={onAnswer}
      />
    </ProjectProvider>,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Prévia da informação")).toHaveTextContent(
      "R$ 1.234,56",
    ),
  );
  expect(onAnswer).not.toHaveBeenCalled();
});

it("ambiguous voice keeps the transcript, announces guidance, focuses manual control, and ignores late revisions", async () => {
  const onAnswer = vi.fn();
  const onVoiceGuidance = vi.fn();
  const question = {
    id: "question",
    lineIds: ["line"],
    field: "decision" as const,
    text: "Criar ou manter?",
  };
  const view = render(
    <ProjectProvider
      value={{
        projectId: "project",
        projectName: "Projeto",
        projectType: "REFORMA",
      }}
    >
      <ImportFocusedQuestion
        question={question}
        lines={[{ id: "line", titulo: "Compra", amountCents: 10_000 }]}
        inputLabel="Decisão"
        inputHint="Confira"
        value="criar talvez"
        revision={7}
        voiceCapture={{
          id: 2,
          text: "criar talvez",
          questionId: "question",
          revision: 7,
        }}
        onVoiceGuidance={onVoiceGuidance}
        onAnswer={onAnswer}
      />
    </ProjectProvider>,
  );
  await waitFor(() => expect(onVoiceGuidance).toHaveBeenCalledOnce());
  expect(screen.getByText("criar talvez")).toBeInTheDocument();
  expect(
    screen.getByRole("radio", { name: "Criar nova compra" }),
  ).toHaveFocus();
  expect(onAnswer).not.toHaveBeenCalled();

  onVoiceGuidance.mockClear();
  view.rerender(
    <ProjectProvider
      value={{
        projectId: "project",
        projectName: "Projeto",
        projectType: "REFORMA",
      }}
    >
      <ImportFocusedQuestion
        question={question}
        lines={[{ id: "line", titulo: "Compra", amountCents: 10_000 }]}
        inputLabel="Decisão"
        inputHint="Confira"
        value="criar talvez"
        revision={8}
        voiceCapture={{
          id: 3,
          text: "criar talvez",
          questionId: "question",
          revision: 7,
        }}
        onVoiceGuidance={onVoiceGuidance}
        onAnswer={onAnswer}
      />
    </ProjectProvider>,
  );
  expect(onVoiceGuidance).not.toHaveBeenCalled();
  expect(onAnswer).not.toHaveBeenCalled();
});

it("previews one clear merchant voice value without sending it", async () => {
  const onAnswer = vi.fn();
  render(
    <ImportFocusedQuestion
      question={{
        id: "merchant-question",
        lineIds: ["line"],
        field: "merchant",
        text: "Qual estabelecimento?",
        subject: {
          kind: "OBSERVATION",
          observationId: "observation",
          meaningContext: null,
        },
        answerState: "UNANSWERED",
      }}
      lines={[{ id: "line", titulo: "Compra" }]}
      inputLabel="Nome do estabelecimento"
      inputHint="Confira"
      value="Loja Fictícia Norte"
      revision={7}
      voiceCapture={{
        id: 10,
        text: "Loja Fictícia Norte",
        questionId: "merchant-question",
        revision: 7,
      }}
      onAnswer={onAnswer}
    />,
  );

  await waitFor(() =>
    expect(screen.getByLabelText("Prévia da informação")).toHaveTextContent(
      "Loja Fictícia Norte",
    ),
  );
  expect(onAnswer).not.toHaveBeenCalled();
});

it.each([
  "Carrefour ou Assaí",
  "Carrefour / Assaí",
  "Carrefour e Assaí",
  "não sei",
])(
  "keeps uncertain merchant voice %j manual, focused, announced, and unsent",
  async (transcript) => {
    const onAnswer = vi.fn();
    const onVoiceGuidance = vi.fn();
    render(
      <ImportFocusedQuestion
        question={{
          id: "merchant-question",
          lineIds: ["line"],
          field: "merchant",
          text: "Qual estabelecimento?",
          subject: {
            kind: "OBSERVATION",
            observationId: "observation",
            meaningContext: null,
          },
          answerState: "UNANSWERED",
        }}
        lines={[{ id: "line", titulo: "Compra" }]}
        inputLabel="Nome do estabelecimento"
        inputHint="Confira"
        value={transcript}
        revision={7}
        voiceCapture={{
          id: 11,
          text: transcript,
          questionId: "merchant-question",
          revision: 7,
        }}
        onVoiceGuidance={onVoiceGuidance}
        onAnswer={onAnswer}
      />,
    );

    await waitFor(() =>
      expect(onVoiceGuidance).toHaveBeenCalledWith(
        "Confira este campo manualmente; nada foi enviado.",
      ),
    );
    expect(screen.getByLabelText("Nome do estabelecimento")).toHaveValue(
      transcript,
    );
    expect(screen.getByLabelText("Nome do estabelecimento")).toHaveFocus();
    expect(onAnswer).not.toHaveBeenCalled();
  },
);

it.each([
  {
    name: "late callback for another question",
    capture: {
      id: 12,
      text: "Loja tardia",
      questionId: "old-question",
      revision: 8,
    },
  },
  {
    name: "callback from an earlier revision",
    capture: {
      id: 13,
      text: "Loja antiga",
      questionId: "merchant-question",
      revision: 7,
    },
  },
])("ignores merchant $name", async ({ capture }) => {
  const onAnswer = vi.fn();
  const onVoiceGuidance = vi.fn();
  render(
    <ImportFocusedQuestion
      question={{
        id: "merchant-question",
        lineIds: ["line"],
        field: "merchant",
        text: "Qual estabelecimento?",
        subject: {
          kind: "OBSERVATION",
          observationId: "observation",
          meaningContext: null,
        },
        answerState: "UNANSWERED",
      }}
      lines={[{ id: "line", titulo: "Compra" }]}
      inputLabel="Nome do estabelecimento"
      inputHint="Confira"
      value={capture.text}
      revision={8}
      voiceCapture={capture}
      onVoiceGuidance={onVoiceGuidance}
      onAnswer={onAnswer}
    />,
  );

  await waitFor(() =>
    expect(screen.getByLabelText("Nome do estabelecimento")).toHaveValue(
      capture.text,
    ),
  );
  expect(
    screen.queryByLabelText("Prévia da informação"),
  ).not.toBeInTheDocument();
  expect(onVoiceGuidance).not.toHaveBeenCalled();
  expect(onAnswer).not.toHaveBeenCalled();
});
