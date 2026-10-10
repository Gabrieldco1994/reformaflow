import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ImportFocusedQuestion } from "./ImportFocusedQuestion";
import { declarationQuestionFixture } from "../_lib/import-workflow-fixtures";

const question = {
  ...declarationQuestionFixture("line-11111111-1111-4111-8111-111111111111"),
  id: "question-22222222-2222-4222-8222-222222222222",
  text: "Informe firstDueDate para observation-33333333-3333-4333-8333-333333333333",
};
const line = {
  id: question.lineIds[0],
  titulo: "Tinta acrílica",
  fornecedor: "Bela Tintas",
  amountCents: 10001,
  dataCompra: "2026-10-08",
  installmentCount: 3,
};

describe("ImportFocusedQuestion optional interpretation", () => {
  it("ignores raw question copy and never exposes documentary identifiers", () => {
    render(
      <ImportFocusedQuestion
        question={question}
        lines={[line]}
        inputLabel="Valor"
        inputHint="Informe o valor."
        onSave={vi.fn()}
        onInterpret={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Qual é o total da compra?" }),
    ).toBeVisible();
    expect(screen.getByText("Bela Tintas")).toBeVisible();
    expect(screen.getByText("08/10/2026")).toBeVisible();
    expect(screen.getByText("R$ 100,01")).toBeVisible();
    expect(document.body).not.toHaveTextContent("firstDueDate");
    expect(document.body).not.toHaveTextContent(/11111111|22222222|33333333/);
  });

  it("keeps free text tertiary, discloses external processing, and saves only the reviewed candidate", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onInterpret = vi.fn().mockResolvedValue({
      version: 1,
      requestId: "44444444-4444-4444-8444-444444444444",
      outcome: "CANDIDATE",
      candidate: { kind: "KNOWN", value: 10001 },
    });
    render(
      <ImportFocusedQuestion
        question={question}
        lines={[line]}
        inputLabel="Valor"
        inputHint="Informe o valor."
        onSave={onSave}
        onInterpret={onInterpret}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Prefiro digitar" }));
    expect(
      screen.getByText(
        "Seu texto será enviado ao provedor de IA apenas para interpretar esta resposta. Nenhuma compra será alterada até você conferir e guardar.",
      ),
    ).toBeVisible();
    const input = screen.getByRole("textbox", {
      name: "Sua resposta em texto",
    });
    await user.type(input, "foi cem reais e um centavo");
    await user.click(
      screen.getByRole("button", { name: "Interpretar resposta" }),
    );

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getAllByRole("button", { name: /^Guardar/ })).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "Guardar e continuar" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Guardar informação" }),
    );
    expect(onSave).toHaveBeenCalledWith({
      questionId: question.id,
      answer: { kind: "KNOWN", value: 10001 },
    });
  });

  it("preserves text and focus on provider failure while structured controls stay enabled", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    let rejectInterpretation: ((reason: Error) => void) | undefined;
    const onInterpret = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectInterpretation = reject;
        }),
    );
    render(
      <ImportFocusedQuestion
        question={question}
        lines={[line]}
        inputLabel="Valor"
        inputHint="Informe o valor."
        onSave={onSave}
        onInterpret={onInterpret}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Prefiro digitar" }));
    const input = screen.getByRole("textbox", {
      name: "Sua resposta em texto",
    });
    await user.type(input, "cem reais");
    await user.click(
      screen.getByRole("button", { name: "Interpretar resposta" }),
    );
    expect(input).toBeDisabled();

    await act(async () => {
      rejectInterpretation?.(new Error("provider down"));
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Não foi possível interpretar agora",
    );
    expect(input).toHaveValue("cem reais");
    expect(input).toBeEnabled();
    expect(input).toHaveFocus();
    expect(screen.getByPlaceholderText("R$ 100,00")).toBeEnabled();
    expect(
      screen.queryByRole("region", {
        name: "Prévia da resposta interpretada",
      }),
    ).not.toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("uses the exact clarification copy without exposing a preview or save", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <ImportFocusedQuestion
        question={question}
        lines={[line]}
        inputLabel="Valor"
        inputHint="Informe o valor."
        onSave={onSave}
        onInterpret={vi.fn().mockResolvedValue({
          version: 1,
          requestId: "44444444-4444-4444-8444-444444444444",
          outcome: "CLARIFY",
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Prefiro digitar" }));
    const input = screen.getByRole("textbox", {
      name: "Sua resposta em texto",
    });
    await user.type(input, "talvez cem");
    await user.click(
      screen.getByRole("button", { name: "Interpretar resposta" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Não foi possível entender com segurança. Use os controles acima ou ajuste o texto.",
    );
    expect(input).toHaveValue("talvez cem");
    expect(
      screen.queryByRole("region", {
        name: "Prévia da resposta interpretada",
      }),
    ).not.toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("keeps voice tertiary, discloses processing before capture, and preserves typed fallback on denial", async () => {
    const user = userEvent.setup();
    const onVoice = vi.fn().mockRejectedValue(new Error("permission denied"));
    render(
      <ImportFocusedQuestion
        question={question}
        lines={[line]}
        inputLabel="Valor"
        inputHint="Informe o valor."
        onSave={vi.fn()}
        onInterpret={vi.fn()}
        onVoice={onVoice}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Prefiro falar" }));
    expect(onVoice).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Seu texto será enviado ao provedor de IA apenas para interpretar esta resposta. Nenhuma compra será alterada até você conferir e guardar.",
      ),
    ).toBeVisible();

    const fallback = screen.getByRole("textbox", {
      name: "Sua resposta em texto",
    });
    await user.type(fallback, "texto preservado");
    await user.click(screen.getByRole("button", { name: "Usar microfone" }));

    expect(onVoice).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Não foi possível usar o microfone",
    );
    expect(fallback).toHaveValue("texto preservado");
    expect(fallback).toHaveFocus();
    expect(screen.getByPlaceholderText("R$ 100,00")).toBeEnabled();
  });

  it("keeps a successful voice transcript local until explicit interpretation and save", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onInterpret = vi.fn().mockResolvedValue({
      version: 1,
      requestId: "44444444-4444-4444-8444-444444444444",
      outcome: "CANDIDATE",
      candidate: { kind: "KNOWN", value: 10001 },
    });
    const onVoice = vi.fn().mockResolvedValue("cem reais e um centavo");
    render(
      <ImportFocusedQuestion
        question={question}
        lines={[line]}
        inputLabel="Valor"
        inputHint="Informe o valor."
        onSave={onSave}
        onInterpret={onInterpret}
        onVoice={onVoice}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Prefiro falar" }));
    await user.click(screen.getByRole("button", { name: "Usar microfone" }));

    const input = screen.getByRole("textbox", {
      name: "Sua resposta em texto",
    });
    expect(input).toHaveValue("cem reais e um centavo");
    expect(input).toHaveFocus();
    expect(onVoice).toHaveBeenCalledTimes(1);
    expect(onInterpret).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Interpretar resposta" }),
    );

    expect(onInterpret).toHaveBeenCalledTimes(1);
    expect(onInterpret).toHaveBeenCalledWith("cem reais e um centavo");
    expect(onSave).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Guardar informação" }),
    ).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Guardar informação" }),
    );
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      questionId: question.id,
      answer: { kind: "KNOWN", value: 10001 },
    });
  });

  it("structured actions never invoke interpretation", async () => {
    const user = userEvent.setup();
    const onInterpret = vi.fn();
    render(
      <ImportFocusedQuestion
        question={question}
        lines={[line]}
        inputLabel="Valor"
        inputHint="Informe o valor."
        onSave={vi.fn()}
        onInterpret={onInterpret}
      />,
    );

    await user.type(screen.getByPlaceholderText("R$ 100,00"), "100,01");
    await user.click(
      screen.getByRole("button", { name: "Conferir informação" }),
    );
    expect(onInterpret).not.toHaveBeenCalled();
  });
});
