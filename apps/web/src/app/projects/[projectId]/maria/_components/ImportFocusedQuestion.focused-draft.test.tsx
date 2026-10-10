import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ExpenseType } from "@reformaflow/domain";
import { ProjectProvider } from "@/contexts/project-context";
import { ImportFocusedQuestion } from "./ImportFocusedQuestion";

afterEach(cleanup);
function setup(
  field: "firstDueDate" | "tipoDespesa" | "decision" | "targets",
  projectType = "REFORMA",
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
        lines={[{ id: "line", titulo: "Compra" }]}
        inputLabel="Sua resposta"
        inputHint="Confira antes de guardar"
        onAnswer={onAnswer}
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
    value: { kind: "CREATE", acceptNaturalDuplicate: false },
  },
  {
    field: "targets" as const,
    label: "Sem rateio — manter a compra no projeto proprietário",
    value: [],
  },
])(
  "requires an unselected $field choice, preview, and human save",
  ({ field, label, value }) => {
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
      text: label,
      draftAnswer: { field, value },
    });
  },
);

it.each(["decision", "targets"] as const)(
  "keeps unsupported %s choices on the existing conversation route",
  (field) => {
    const onAnswer = setup(field);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Responder outra opção pela conversa",
      }),
    );
    const input = screen.getByLabelText("Sua resposta");
    fireEvent.change(input, { target: { value: "Minha outra escolha" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Responder à pergunta" }),
    );
    expect(onAnswer).toHaveBeenCalledWith({
      id: "question",
      text: "Minha outra escolha",
    });
  },
);
