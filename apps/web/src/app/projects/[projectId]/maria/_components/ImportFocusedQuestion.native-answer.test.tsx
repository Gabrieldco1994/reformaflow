import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ImportSessionQuestionV1 } from "@reformaflow/domain";
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

const merchantQuestion: ImportSessionQuestionV1 = {
  id: "oq-merchant",
  lineIds: ["line"],
  field: "merchant",
  text: "Qual o estabelecimento?",
  subject: {
    kind: "OBSERVATION",
    observationId: "obs",
    meaningContext: null,
  },
  answerState: "UNANSWERED",
};

it.each([
  "Mercado Central ou Loja Sul",
  "Mercado Central / Loja Sul",
  "não sei",
  "Mercado Central; Loja Sul",
])(
  "keeps ambiguous merchant voice %j local with zero answer request",
  async (transcript) => {
    const onAnswer = vi.fn();
    const onVoiceGuidance = vi.fn();
    render(
      <ImportFocusedQuestion
        question={merchantQuestion}
        lines={[{ id: "line", titulo: "Compra" }]}
        inputLabel="Nome do estabelecimento"
        inputHint="Confira antes de guardar"
        value={transcript}
        revision={7}
        voiceCapture={{
          id: 1,
          text: transcript,
          questionId: merchantQuestion.id,
          revision: 7,
        }}
        onAnswer={onAnswer}
        onVoiceGuidance={onVoiceGuidance}
      />,
    );

    await waitFor(() => expect(onVoiceGuidance).toHaveBeenCalledOnce());
    expect(
      screen.queryByLabelText("Prévia da informação"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Guardar informação" }),
    ).toBeDisabled();
    expect(onAnswer).not.toHaveBeenCalled();
  },
);

it.each([
  {
    label: "stale revision",
    capture: {
      id: 2,
      text: "Mercado Central",
      questionId: merchantQuestion.id,
      revision: 6,
    },
  },
  {
    label: "stale question callback",
    capture: {
      id: 3,
      text: "Mercado Central",
      questionId: "oq-previous",
      revision: 7,
    },
  },
])("ignores a clear merchant from a $label", async ({ capture }) => {
  const onAnswer = vi.fn();
  const onVoiceGuidance = vi.fn();
  render(
    <ImportFocusedQuestion
      question={merchantQuestion}
      lines={[{ id: "line", titulo: "Compra" }]}
      inputLabel="Nome do estabelecimento"
      inputHint="Confira antes de guardar"
      value={capture.text}
      revision={7}
      voiceCapture={capture}
      onAnswer={onAnswer}
      onVoiceGuidance={onVoiceGuidance}
    />,
  );

  await Promise.resolve();
  expect(
    screen.queryByLabelText("Prévia da informação"),
  ).not.toBeInTheDocument();
  expect(onVoiceGuidance).not.toHaveBeenCalled();
  expect(onAnswer).not.toHaveBeenCalled();
});
