import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ImportFocusedQuestion } from "./ImportFocusedQuestion";

afterEach(cleanup);

it("does_not_send_before_save_preview and supplies exact input and accepted answer", () => {
  const onAnswer = vi.fn();
  render(
    <ImportFocusedQuestion
      question={{
        id: "oq-date",
        lineIds: ["line"],
        field: "dataCompra",
        text: "Qual a data da compra?",
        subject: {
          kind: "OBSERVATION",
          observationId: "obs",
          meaningContext: null,
        },
        answerState: "UNANSWERED",
      }}
      lines={[{ id: "line", titulo: "Compra" }]}
      inputLabel="Data da compra"
      inputHint="Confira antes de guardar"
      onAnswer={onAnswer}
    />,
  );
  fireEvent.change(screen.getByLabelText("Data da compra"), {
    target: { value: "2025-09-01" },
  });
  expect(onAnswer).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Conferir informação" }));
  expect(onAnswer).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Guardar informação" }));
  expect(onAnswer).toHaveBeenCalledOnce();
  expect(onAnswer).toHaveBeenCalledWith({
    id: "oq-date",
    text: expect.any(String),
    input: { kind: "VALUE", text: "2025-09-01" },
    answer: { field: "dataCompra", meaningContext: null, value: "2025-09-01" },
  });
});
