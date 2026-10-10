import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ImportFocusedQuestion } from "./ImportFocusedQuestion";

const line = {
  id: "line-internal-a",
  titulo: "Texto local que não deve aparecer",
  fornecedor: "Fornecedor local",
  amountCents: 1,
  dataCompra: "2020-01-01",
  installmentCount: 1,
};

const question = {
  id: "question-internal-a",
  lineIds: [line.id],
  field: "tipoDespesa" as const,
  text: "RAW tipoDespesa",
};

const context = {
  title: "Tinta para a sala",
  merchant: "Loja das Cores",
  purchaseDate: "2026-10-08",
  amountCents: 20_696,
};

const baseFocus = {
  questionId: question.id,
  lineId: line.id,
  control: "EXPENSE_TYPE",
  prompt: "Qual é o tipo de despesa?",
  context,
  options: [],
  purchaseOrdinal: 8,
  purchaseTotal: 13,
  questionOrdinal: 2,
  questionTotal: 4,
};

function mount(
  focus: Record<string, unknown>,
  onSave = vi.fn(),
  pending = false,
) {
  render(
    <ImportFocusedQuestion
      question={question}
      lines={[line]}
      inputLabel="Sua resposta"
      inputHint="Confira a resposta."
      guidedFocus={{ ...baseFocus, ...focus } as never}
      pending={pending}
      onSave={onSave}
    />,
  );
  return onSave;
}

describe("ImportFocusedQuestion canonical guided review", () => {
  it.each([
    {
      control: "DECISION",
      option: {
        label: "Manter a compra que já existe",
        answer: {
          kind: "DECISION",
          value: { kind: "KEEP_EXISTING", expenseId: "expense-internal-a" },
        },
      },
    },
    {
      control: "EXPENSE_TYPE",
      option: {
        label: "Material de construção",
        answer: { kind: "EXPENSE_TYPE", value: "MATERIAL_CONSTRUCAO" },
      },
    },
    {
      control: "LABOR_CATEGORY",
      option: {
        label: "Pintura",
        answer: { kind: "LABOR_CATEGORY", value: "PINTOR" },
      },
    },
  ] as const)(
    "renders the server $control copy and persists its typed answer",
    async ({ control, option }) => {
      const user = userEvent.setup();
      const onSave = mount({ control, options: [option] });

      expect(screen.getByText("Compra 8 de 13")).toBeVisible();
      expect(screen.getByText("Pergunta 2 de 4 desta compra")).toBeVisible();
      expect(
        screen.getByRole("heading", { name: baseFocus.prompt }),
      ).toBeVisible();
      expect(screen.getByText(context.title)).toBeVisible();
      expect(screen.getByText(context.merchant)).toBeVisible();
      expect(document.body).not.toHaveTextContent("Texto local");
      expect(document.body).not.toHaveTextContent("RAW");
      expect(document.body).not.toHaveTextContent(question.id);
      expect(document.body).not.toHaveTextContent(line.id);
      expect(document.body).not.toHaveTextContent(control);
      expect(document.body).not.toHaveTextContent("expense-internal-a");
      expect(document.body).not.toHaveTextContent("MATERIAL_CONSTRUCAO");
      expect(document.body).not.toHaveTextContent("PINTOR");

      await user.click(screen.getByRole("radio", { name: option.label }));
      await user.click(
        screen.getByRole("button", { name: "Conferir informação" }),
      );

      const preview = screen.getByRole("region", {
        name: "Confira antes de guardar",
      });
      expect(preview).toHaveTextContent("Compra 8 de 13");
      expect(preview).toHaveTextContent("Pergunta 2 de 4 desta compra");
      expect(preview).toHaveTextContent(option.label);

      await user.click(
        within(preview).getByRole("button", {
          name: "Guardar e continuar",
        }),
      );
      expect(onSave).toHaveBeenCalledTimes(1);
      expect(onSave).toHaveBeenCalledWith({
        questionId: question.id,
        answer: option.answer,
      });
    },
  );

  it.each([
    {
      label: "Manter somente na origem",
      answer: { kind: "TARGETS", value: [] },
    },
    {
      label: "Usar na reforma",
      answer: {
        kind: "TARGETS",
        value: [
          {
            projectId: "reforma-project-internal",
            roomId: "room-internal",
            amountCents: 20_696,
          },
        ],
      },
    },
  ] as const)("saves the supplied TARGETS tuple for $label", async (option) => {
    const user = userEvent.setup();
    const onSave = mount({ control: "TARGETS", options: [option] });

    expect(screen.getByRole("radio", { name: option.label })).toBeVisible();
    expect(document.body).not.toHaveTextContent("reforma-project-internal");
    expect(document.body).not.toHaveTextContent("room-internal");

    await user.click(screen.getByRole("radio", { name: option.label }));
    await user.click(
      screen.getByRole("button", { name: "Conferir informação" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Guardar e continuar" }),
    );

    expect(onSave).toHaveBeenCalledWith({
      questionId: question.id,
      answer: option.answer,
    });
  });

  it("preserves the selected value and preview while a save is busy", async () => {
    const user = userEvent.setup();
    const option = {
      label: "Material de construção",
      answer: { kind: "EXPENSE_TYPE", value: "MATERIAL_CONSTRUCAO" },
    };
    const props = {
      question,
      lines: [line],
      inputLabel: "Sua resposta",
      inputHint: "Confira a resposta.",
      guidedFocus: { ...baseFocus, options: [option] } as never,
      onSave: vi.fn(),
    };
    const { rerender } = render(<ImportFocusedQuestion {...props} />);

    await user.click(screen.getByRole("radio", { name: option.label }));
    await user.click(
      screen.getByRole("button", { name: "Conferir informação" }),
    );
    rerender(<ImportFocusedQuestion {...props} pending />);

    expect(screen.getByRole("radio", { name: option.label })).toBeChecked();
    expect(
      screen.getByRole("region", { name: "Confira antes de guardar" }),
    ).toBeVisible();
    expect(screen.getByText("Guardando resposta…")).toBeVisible();
  });
});
