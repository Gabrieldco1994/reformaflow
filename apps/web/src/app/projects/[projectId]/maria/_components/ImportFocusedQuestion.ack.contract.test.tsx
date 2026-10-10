import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { declarationQuestionFixture } from "../_lib/import-workflow-fixtures";
import { ImportFocusedQuestion } from "./ImportFocusedQuestion";

const question = {
  ...declarationQuestionFixture("purchase-second"),
  text: "RAW_TECHNICAL_QUESTION",
};
const lines = [
  { id: "purchase-first", titulo: "Sofá igual" },
  { id: "purchase-second", titulo: "Sofá igual" },
];
const props = {
  question,
  lines,
  inputLabel: "Sua resposta sobre esta compra",
  inputHint: "Informe o valor sem alterar o documento.",
};
const input = () => screen.getByRole("textbox", { name: props.inputLabel });

describe("ImportFocusedQuestion acknowledgment boundary", () => {
  it("keeps typing and Enter local until the explicit documentary continuation", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<ImportFocusedQuestion {...props} onSave={onSave} />);

    await user.type(input(), "R$ 1.234,56");
    await user.keyboard("{Enter}");
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Prévia da informação")).toHaveTextContent(
      "R$ 1.234,56",
    );

    expect(screen.getAllByRole("button", { name: /^Guardar/ })).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "Guardar informação" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Guardar e continuar" }),
    );
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      questionId: "oq_purchase-second_amount",
      answer: { kind: "KNOWN", value: 123456 },
    });
  });

  it("a void callback does not manufacture acknowledgment or clear the literal", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const { rerender } = render(
      <ImportFocusedQuestion {...props} onSave={onSave} />,
    );
    await user.type(input(), "R$ 10,00");
    await user.keyboard("{Enter}");
    await user.click(
      screen.getByRole("button", { name: "Guardar e continuar" }),
    );

    rerender(
      <ImportFocusedQuestion
        {...props}
        question={{ ...question, lineIds: [...question.lineIds] }}
        onSave={onSave}
      />,
    );
    expect(input()).toHaveValue("R$ 10,00");
    expect(screen.getByLabelText("Prévia da informação")).toBeVisible();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("pending blocks the stored command while preserving the exact local value", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const { rerender } = render(
      <ImportFocusedQuestion {...props} onSave={onSave} />,
    );
    await user.type(input(), "R$ 10,00");
    await user.keyboard("{Enter}");
    rerender(<ImportFocusedQuestion {...props} onSave={onSave} pending />);

    expect(input()).toBeDisabled();
    expect(input()).toHaveValue("R$ 10,00");
    const save = screen.getByRole("button", {
      name: "Guardar e continuar",
    });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("a newly mounted question has no stale local value and does not steal focus", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const first = render(<ImportFocusedQuestion {...props} onSave={onSave} />);
    await user.type(input(), "R$ 10,00");
    await user.keyboard("{Enter}");

    first.unmount();
    render(
      <ImportFocusedQuestion
        {...props}
        question={{
          ...question,
          id: "oq_purchase-first_amount",
          lineIds: ["purchase-first"],
          subject: {
            ...question.subject,
            observationId: "observation-purchase-first",
          },
        }}
        onSave={onSave}
      />,
    );
    expect(input()).toHaveValue("");
    expect(screen.queryByLabelText("Prévia da informação")).toBeNull();
    expect(input()).not.toHaveFocus();
  });
});
