import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { declarationQuestionFixture } from "../_lib/import-workflow-fixtures";
import { ImportFocusedQuestion } from "./ImportFocusedQuestion";

const lines = [
  { id: "purchase-first", titulo: "Sofá igual" },
  {
    id: "purchase-second",
    titulo: "Sofá igual",
    fornecedor: "Loja B",
    amountCents: 10000,
    dataCompra: "2026-10-08",
    installmentCount: 2,
  },
];
const baseQuestion = {
  ...declarationQuestionFixture("purchase-second"),
  text: "RAW_TECHNICAL_QUESTION amountCents observation-purchase-second",
};
const props = {
  question: baseQuestion,
  lines,
  inputLabel: "Sua resposta sobre esta compra",
  inputHint: "Use o controle acima; você poderá conferir antes de guardar.",
};
const input = () => screen.getByRole("textbox", { name: props.inputLabel });

describe("ImportFocusedQuestion guided contract", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T12:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("uses guided Portuguese copy and one purchase context, never raw technical text", () => {
    render(<ImportFocusedQuestion {...props} onSave={vi.fn()} />);

    expect(
      screen.getByRole("heading", { name: "Qual é o total da compra?" }),
    ).toBeVisible();
    expect(document.body).not.toHaveTextContent("RAW_TECHNICAL_QUESTION");
    expect(document.body).not.toHaveTextContent("observation-purchase-second");
    expect(
      screen.getByRole("region", { name: "Compra 2 de 2" }),
    ).toHaveTextContent("Loja B");
    expect(screen.queryByText("purchase-first")).toBeNull();
  });

  it("focuses only for a new applied focus request, never for generic mount or unblock", () => {
    const focus = vi.spyOn(HTMLInputElement.prototype, "focus");
    const onSave = vi.fn();
    const { rerender } = render(
      <ImportFocusedQuestion {...props} disabled onSave={onSave} />,
    );
    expect(focus).not.toHaveBeenCalled();
    expect(input()).not.toHaveFocus();

    rerender(<ImportFocusedQuestion {...props} onSave={onSave} />);
    expect(focus).not.toHaveBeenCalled();
    expect(input()).not.toHaveFocus();

    rerender(
      <ImportFocusedQuestion {...props} focusRequest={1} onSave={onSave} />,
    );
    expect(focus).toHaveBeenCalledTimes(1);
    expect(input()).toHaveFocus();

    input().blur();
    rerender(
      <ImportFocusedQuestion {...props} focusRequest={1} onSave={onSave} />,
    );
    expect(focus).toHaveBeenCalledTimes(1);
    expect(input()).not.toHaveFocus();

    rerender(
      <ImportFocusedQuestion {...props} focusRequest={2} onSave={onSave} />,
    );
    expect(focus).toHaveBeenCalledTimes(2);
    expect(input()).toHaveFocus();
  });

  it("previews and stores a PT-BR monetary declaration in centavos", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<ImportFocusedQuestion {...props} onSave={onSave} />);

    await user.type(input(), "206,96");
    await user.keyboard("{Enter}");
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Prévia da informação")).toHaveTextContent(
      "R$ 206,96",
    );
    await user.click(
      screen.getByRole("button", { name: "Guardar e continuar" }),
    );
    expect(onSave).toHaveBeenCalledWith({
      questionId: baseQuestion.id,
      answer: { kind: "KNOWN", value: 20696 },
    });
  });

  it("does not extract a monetary value from a negated phrase", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    render(<ImportFocusedQuestion {...props} onSave={vi.fn()} />);

    await user.type(input(), "não foi R$ 100,00");
    await user.keyboard("{Enter}");
    expect(screen.queryByLabelText("Prévia da informação")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Guardar e continuar" }),
    ).toBeNull();
  });

  it("offers a date control and stores the exact ISO date after preview", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onSave = vi.fn();
    const question = {
      ...baseQuestion,
      field: "dataCompra" as const,
      subject: { ...baseQuestion.subject, meaningContext: null },
    };
    render(
      <ImportFocusedQuestion {...props} question={question} onSave={onSave} />,
    );

    const date = screen.getByLabelText("Sua resposta sobre esta compra");
    expect(date).toHaveAttribute("type", "date");
    expect(screen.getByText(/Exemplo: 08\/10\/2026/)).toBeVisible();
    fireEvent.change(date, { target: { value: "2026-10-09" } });
    await user.click(
      screen.getByRole("button", { name: "Conferir informação" }),
    );
    expect(screen.getByLabelText("Prévia da informação")).toHaveTextContent(
      "09/10/2026",
    );
    await user.click(
      screen.getByRole("button", { name: "Guardar e continuar" }),
    );
    expect(onSave).toHaveBeenCalledWith({
      questionId: baseQuestion.id,
      answer: { kind: "KNOWN", value: "2026-10-09" },
    });
  });

  it.each([
    ["É o total da compra", "TOTAL_PURCHASE"],
    ["É o valor de uma parcela", "INSTALLMENT_CHARGE"],
  ] as const)("stores the explicit amount meaning %s", async (label, value) => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onSave = vi.fn();
    const question = {
      ...baseQuestion,
      field: "amountMeaning" as const,
      subject: { ...baseQuestion.subject, meaningContext: null },
    };
    render(
      <ImportFocusedQuestion {...props} question={question} onSave={onSave} />,
    );

    const option = screen.getByRole("radio", { name: label });
    expect(option).not.toBeChecked();
    await user.click(option);
    expect(onSave).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Conferir informação" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Guardar e continuar" }),
    );
    expect(onSave).toHaveBeenCalledWith({
      questionId: baseQuestion.id,
      answer: { kind: "KNOWN", value },
    });
  });

  it.each([
    ["installmentCount", "Em quantas parcelas esta compra foi feita?"],
    ["installmentIndex", "Qual é o número desta parcela?"],
  ] as const)("stores a positive integer for %s", async (field, copy) => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onSave = vi.fn();
    const question = {
      ...baseQuestion,
      field,
      subject: { ...baseQuestion.subject, meaningContext: null },
    };
    render(
      <ImportFocusedQuestion {...props} question={question} onSave={onSave} />,
    );

    expect(screen.getByRole("heading", { name: copy })).toBeVisible();
    const number = screen.getByRole("spinbutton");
    expect(number).toHaveValue(null);
    await user.type(number, "3");
    await user.click(
      screen.getByRole("button", { name: "Conferir informação" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Guardar e continuar" }),
    );
    expect(onSave).toHaveBeenCalledWith({
      questionId: baseQuestion.id,
      answer: { kind: "KNOWN", value: 3 },
    });
  });

  it("invalidates a displayed preview when the structured value changes", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    render(<ImportFocusedQuestion {...props} onSave={vi.fn()} />);
    await user.type(input(), "100,00");
    await user.keyboard("{Enter}");
    expect(screen.getByLabelText("Prévia da informação")).toBeVisible();

    await user.clear(input());
    await user.type(input(), "120,00");
    expect(screen.queryByLabelText("Prévia da informação")).toBeNull();
    expect(input()).toHaveValue("120,00");
  });

  it("interprets free text into a candidate but saves only after confirmation", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onInterpret = vi.fn().mockResolvedValue({
      version: 1,
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      outcome: "CANDIDATE",
      candidate: { kind: "KNOWN", value: 150000 },
    });
    render(
      <ImportFocusedQuestion
        {...props}
        onSave={onSave}
        onInterpret={onInterpret}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Prefiro digitar" }));
    const free = screen.getByRole("textbox", {
      name: "Sua resposta em texto",
    });
    await user.type(free, "foi mil e quinhentos");
    await user.click(
      screen.getByRole("button", { name: "Interpretar resposta" }),
    );
    expect(onInterpret).toHaveBeenCalledWith("foi mil e quinhentos");
    expect(onSave).not.toHaveBeenCalled();
    const preview = screen.getByLabelText("Prévia da resposta interpretada");
    expect(within(preview).getByText("R$ 1.500,00")).toBeVisible();
    await user.click(
      within(preview).getByRole("button", { name: "Guardar informação" }),
    );
    expect(onSave).toHaveBeenCalledWith({
      questionId: baseQuestion.id,
      answer: { kind: "KNOWN", value: 150000 },
    });
  });

  it("fails closed when the affected purchase is absent", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <ImportFocusedQuestion {...props} lines={[lines[0]]} onSave={onSave} />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Não foi possível mostrar o contexto desta compra",
    );
    expect(input()).toBeDisabled();
    await user.type(input(), "100,00");
    expect(onSave).not.toHaveBeenCalled();
  });
});
