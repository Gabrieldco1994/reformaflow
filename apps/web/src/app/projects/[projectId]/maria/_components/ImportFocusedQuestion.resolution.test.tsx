import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ImportSessionQuestionV1 } from "@reformaflow/domain";
import { describe, expect, it, vi } from "vitest";
import { ImportFocusedQuestion } from "./ImportFocusedQuestion";

const line = {
  id: "line-a",
  titulo: "Compra reconhecível",
  fornecedor: "Loja do bairro",
  amountCents: 1099,
  dataCompra: "2026-10-09",
  installmentCount: 2,
};

describe("ImportFocusedQuestion draft resolution contract", () => {
  it.each([
    {
      field: "firstDueDate",
      label: "Sua resposta",
      value: "2026-10-28",
      answer: { kind: "DATE", value: "2026-10-28" },
    },
    {
      field: "installmentCount",
      label: "Sua resposta",
      value: "2",
      answer: { kind: "POSITIVE_INTEGER", value: 2 },
    },
  ] as const)(
    "maps $field to the domain-owned typed resolution",
    async ({ field, label, value, answer }) => {
      const user = userEvent.setup();
      const onSave = vi.fn();
      const question: ImportSessionQuestionV1 = {
        id: `question-${field}`,
        lineIds: [line.id],
        field,
        text: "raw internal text",
      };
      render(
        <ImportFocusedQuestion
          question={question}
          lines={[line]}
          inputLabel={label}
          inputHint="Confira a resposta."
          onSave={onSave}
        />,
      );

      await user.type(screen.getByLabelText(label), value);
      await user.click(
        screen.getByRole("button", { name: "Conferir informação" }),
      );
      await user.click(
        screen.getByRole("button", { name: "Guardar informação" }),
      );

      expect(onSave).toHaveBeenCalledWith({
        questionId: question.id,
        answer,
      });
    },
  );

  it.each([
    {
      label: "Criar uma nova compra",
      preview: "Criar uma nova compra",
      answer: {
        kind: "DECISION",
        value: { kind: "CREATE", acceptNaturalDuplicate: false },
      },
    },
    {
      label: "Criar mesmo parecendo repetida",
      preview: "Criar mesmo parecendo repetida",
      answer: {
        kind: "DECISION",
        value: { kind: "CREATE", acceptNaturalDuplicate: true },
      },
    },
    {
      label: "Não importar esta compra",
      preview: "Não importar esta compra",
      answer: {
        kind: "DECISION",
        value: { kind: "EXCLUDE" },
      },
    },
  ] as const)(
    "previews and saves the structured decision '$label'",
    async ({ label, preview, answer }) => {
      const user = userEvent.setup();
      const onSave = vi.fn();
      const onInterpret = vi.fn();
      const onVoice = vi.fn();
      const question: ImportSessionQuestionV1 = {
        id: "question-decision",
        lineIds: [line.id],
        field: "decision",
        text: "raw internal text",
      };
      render(
        <ImportFocusedQuestion
          question={question}
          lines={[line]}
          inputLabel="Sua resposta"
          inputHint="Confira a resposta."
          onSave={onSave}
          onInterpret={onInterpret}
          onVoice={onVoice}
          guidedFocus={
            {
              questionId: question.id,
              lineId: line.id,
              control: "DECISION",
              prompt: "O que deve acontecer com esta compra?",
              context: {
                title: line.titulo,
                merchant: line.fornecedor,
                amountCents: line.amountCents,
                purchaseDate: line.dataCompra,
              },
              options: [{ label, answer }],
              purchaseOrdinal: 1,
              purchaseTotal: 1,
              questionOrdinal: 1,
              questionTotal: 1,
            } as never
          }
        />,
      );

      expect(
        screen.queryByRole("button", { name: "Prefiro digitar" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Prefiro falar" }),
      ).not.toBeInTheDocument();

      await user.click(screen.getByRole("radio", { name: label }));
      await user.click(
        screen.getByRole("button", { name: "Conferir informação" }),
      );

      expect(onSave).not.toHaveBeenCalled();
      expect(
        screen.getByRole("region", { name: "Confira antes de guardar" }),
      ).toHaveTextContent(preview);

      await user.click(
        screen.getByRole("button", { name: "Guardar e continuar" }),
      );
      expect(onSave).toHaveBeenCalledWith({
        questionId: question.id,
        answer,
      });
      expect(onInterpret).not.toHaveBeenCalled();
      expect(onVoice).not.toHaveBeenCalled();
    },
  );

  it.each([["targets"], ["tipoDespesa"], ["categoriaMaoDeObra"]] as const)(
    "shows a visible safe fallback instead of silently ignoring %s",
    (field) => {
      const question: ImportSessionQuestionV1 = {
        id: `question-${field}`,
        lineIds: [line.id],
        field,
        text: "raw internal text",
      };
      render(
        <ImportFocusedQuestion
          question={question}
          lines={[line]}
          inputLabel="Sua resposta"
          inputHint="Confira a resposta."
          onSave={vi.fn()}
          onInterpret={vi.fn()}
        />,
      );

      expect(screen.getByRole("alert")).toHaveTextContent(
        "não estão disponíveis",
      );
      expect(
        screen.getByRole("button", { name: "Conferir informação" }),
      ).toBeDisabled();
      expect(
        screen.queryByRole("button", { name: "Prefiro digitar" }),
      ).not.toBeInTheDocument();
    },
  );

  it("shows validation feedback when a typed answer cannot be formed", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const question: ImportSessionQuestionV1 = {
      id: "question-amount",
      lineIds: [line.id],
      field: "amountCents",
      text: "raw internal text",
    };
    render(
      <ImportFocusedQuestion
        question={question}
        lines={[line]}
        inputLabel="Valor informado"
        inputHint="Confira a resposta."
        onSave={onSave}
      />,
    );

    await user.type(screen.getByLabelText("Valor informado"), "valor inválido");
    await user.click(
      screen.getByRole("button", { name: "Conferir informação" }),
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Confira a informação e tente novamente.",
    );
    expect(
      screen.queryByRole("region", { name: "Prévia da informação" }),
    ).not.toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });
});
