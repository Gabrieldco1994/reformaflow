import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

type FocusedField = Exclude<
  ImportSessionQuestionV1,
  { subject: unknown }
>["field"];

const line = {
  id: "line-1",
  titulo: "Compra documental",
  amountCents: 20_696,
};
const candidate: ImportSessionCandidateV1 = {
  lineId: line.id,
  kind: "EXPENSE",
  id: "candidate-current",
  projectId: "project-owner",
  description: "Compra já existente",
  amountCents: 20_696,
  date: "2026-10-10",
  reason: "NATURAL_MATCH",
  canKeepExisting: true,
};
const targetProjects = [
  {
    id: "project-owner",
    name: "Projeto proprietário",
    projectType: "PESSOAL",
    eligible: true,
    rooms: [{ id: "room-owner", name: "Carteira" }],
  },
  {
    id: "project-reforma",
    name: "Reforma autorizada",
    projectType: "REFORMA",
    eligible: true,
    rooms: [{ id: "room-reforma", name: "Cozinha" }],
  },
  {
    id: "project-carro",
    name: "Destino não elegível",
    projectType: "CARRO",
    eligible: false,
    rooms: [],
  },
];

function setup(
  field: FocusedField,
  options: {
    value?: string;
    voiceCapture?: {
      id: number;
      text: string;
      questionId: string;
      revision: number;
    };
    revision?: number;
  } = {},
) {
  const onAnswer = vi.fn();
  const onTextChange = vi.fn();
  const onVoiceGuidance = vi.fn();
  const question = {
    id: `question-${field}`,
    lineIds: [line.id],
    field,
    text: `Pergunta ${field}`,
  } as ImportSessionQuestionV1;
  render(
    <ProjectProvider
      value={{
        projectId: "project-owner",
        projectName: "Pessoal",
        projectType: "REFORMA",
      }}
    >
      <ImportFocusedQuestion
        question={question}
        lines={[line]}
        inputLabel={field}
        inputHint="Confira"
        onAnswer={onAnswer}
        onTextChange={onTextChange}
        candidates={[candidate]}
        targetProjects={targetProjects}
        onVoiceGuidance={onVoiceGuidance}
        {...options}
      />
    </ProjectProvider>,
  );
  return {
    form: screen.getByRole("form", { name: question.text }),
    onAnswer,
    onTextChange,
    onVoiceGuidance,
  };
}

describe("complete deterministic manual fallback", () => {
  it.each([
    ["amountMeaning", "radio", "Total da compra"],
    ["amountCents", "textbox", "Valor da compra"],
    ["installmentCount", "spinbutton", "Quantidade de parcelas"],
    ["tipoDespesa", "combobox", "Tipo de despesa"],
    ["categoriaMaoDeObra", "combobox", "Categoria de mão de obra"],
    ["decision", "radio", "Criar nova compra"],
    ["targets", "radio", "Sem rateio — manter no projeto proprietário"],
  ] as const)(
    "renders an enabled typed %s control with an inert save",
    (field, role, name) => {
      const { form, onAnswer } = setup(field);
      expect(within(form).getByRole(role, { name })).toBeEnabled();
      expect(
        within(form).getByRole("button", { name: "Guardar informação" }),
      ).toBeDisabled();
      expect(onAnswer).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["dataCompra", "Data da compra"],
    ["firstDueDate", "Primeiro vencimento"],
  ] as const)("renders an enabled date-only %s control", (field, label) => {
    const { form, onAnswer } = setup(field);
    expect(within(form).getByLabelText(label)).toBeEnabled();
    expect(
      within(form).getByRole("button", { name: "Guardar informação" }),
    ).toBeDisabled();
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it.each([
    [
      "amountMeaning",
      "Total da compra",
      ImportSessionAmountMeaning.TOTAL_PURCHASE,
    ],
    ["amountCents", "206,96", 20_696],
    ["installmentCount", "6", 6],
    ["dataCompra", "2028-02-29", "2028-02-29"],
    ["firstDueDate", "2026-10-10", "2026-10-10"],
    ["tipoDespesa", ExpenseType.MAO_DE_OBRA, ExpenseType.MAO_DE_OBRA],
    ["categoriaMaoDeObra", LaborCategory.PINTOR, LaborCategory.PINTOR],
  ] as const)(
    "requires preview and save for deterministic %s value",
    (field, input, value) => {
      const { form, onAnswer } = setup(field);
      if (field === "amountMeaning")
        fireEvent.click(within(form).getByRole("radio", { name: input }));
      else if (field === "tipoDespesa" || field === "categoriaMaoDeObra")
        fireEvent.change(within(form).getByRole("combobox"), {
          target: { value: input },
        });
      else
        fireEvent.change(
          within(form).getByLabelText(
            field === "amountCents"
              ? "Valor da compra"
              : field === "installmentCount"
                ? "Quantidade de parcelas"
                : field === "dataCompra"
                  ? "Data da compra"
                  : "Primeiro vencimento",
          ),
          { target: { value: input } },
        );
      expect(onAnswer).not.toHaveBeenCalled();
      fireEvent.click(
        within(form).getByRole("button", { name: "Conferir informação" }),
      );
      expect(onAnswer).not.toHaveBeenCalled();
      fireEvent.click(
        within(form).getByRole("button", { name: "Guardar informação" }),
      );
      expect(onAnswer).toHaveBeenCalledWith({
        id: `question-${field}`,
        text:
          field === "amountMeaning"
            ? ImportSessionAmountMeaning.TOTAL_PURCHASE
            : input,
        draftAnswer: { field, value },
      });
    },
  );

  it("never auto-submits a deterministic VOICE preview", async () => {
    const { form, onAnswer } = setup("amountCents", {
      value: "206,96",
      revision: 7,
      voiceCapture: {
        id: 1,
        text: "206,96",
        questionId: "question-amountCents",
        revision: 7,
      },
    });
    await waitFor(() =>
      expect(
        within(form).getByLabelText("Prévia da informação"),
      ).toBeInTheDocument(),
    );
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("keeps ambiguous VOICE text in manual fallback without submitting", async () => {
    const { form, onAnswer, onVoiceGuidance } = setup("amountCents", {
      value: "R$ 41,20 ou R$ 42,10",
      revision: 7,
      voiceCapture: {
        id: 2,
        text: "R$ 41,20 ou R$ 42,10",
        questionId: "question-amountCents",
        revision: 7,
      },
    });
    await waitFor(() => expect(onVoiceGuidance).toHaveBeenCalledOnce());
    expect(
      within(form).getByRole("button", { name: "Guardar informação" }),
    ).toBeDisabled();
    expect(within(form).getByLabelText("Valor da compra")).toHaveFocus();
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("admits only a visible candidate and one integral project-room target", () => {
    const { form: decision, onAnswer: onDecision } = setup("decision");
    fireEvent.click(
      within(decision).getByRole("radio", {
        name: /Manter compra existente: Compra já existente/,
      }),
    );
    fireEvent.click(
      within(decision).getByRole("button", { name: "Conferir informação" }),
    );
    fireEvent.click(
      within(decision).getByRole("button", { name: "Guardar informação" }),
    );
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        draftAnswer: {
          field: "decision",
          value: {
            kind: "KEEP_EXISTING",
            expenseId: "candidate-current",
          },
        },
      }),
    );
    cleanup();

    const { form: targets, onAnswer: onTargets } = setup("targets");
    fireEvent.click(
      within(targets).getByRole("radio", {
        name: "Enviar o valor integral para outro projeto",
      }),
    );
    fireEvent.change(within(targets).getByLabelText("Projeto de destino"), {
      target: { value: "project-reforma" },
    });
    fireEvent.change(within(targets).getByLabelText("Cômodo (opcional)"), {
      target: { value: "room-reforma" },
    });
    fireEvent.click(
      within(targets).getByRole("button", { name: "Conferir informação" }),
    );
    fireEvent.click(
      within(targets).getByRole("button", { name: "Guardar informação" }),
    );
    expect(onTargets).toHaveBeenCalledWith(
      expect.objectContaining({
        draftAnswer: {
          field: "targets",
          value: [
            {
              projectId: "project-reforma",
              roomId: "room-reforma",
              amountCents: 20_696,
            },
          ],
        },
      }),
    );
  });

  it("offers only an eligible REFORMA destination distinct from the owner", () => {
    const { form } = setup("targets");
    fireEvent.click(
      within(form).getByRole("radio", {
        name: "Enviar o valor integral para outro projeto",
      }),
    );
    const options = within(within(form).getByLabelText("Projeto de destino"))
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).value);
    expect(options).toEqual(["", "project-reforma"]);
  });
});
