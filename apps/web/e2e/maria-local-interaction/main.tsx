import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ImportSessionQuestionV1 } from "@reformaflow/domain";
import { ImportLocalDocuments } from "@/app/projects/[projectId]/maria/_components/ImportLocalDocuments";
import { ImportFocusedQuestion } from "@/app/projects/[projectId]/maria/_components/ImportFocusedQuestion";
import "@/app/globals.css";
import "./harness.css";

const question: ImportSessionQuestionV1 = {
  id: "question-second",
  lineIds: ["purchase-second"],
  field: "amountMeaning",
  text: "Nesta compra, o valor informado é o total ou uma parcela?",
};

function Harness() {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [available, setAvailable] = useState(true);
  const [events, setEvents] = useState<object[]>([]);
  return (
    <main className="harness">
      <h1>Harness local M1 — sem API</h1>
      <p>Fixture sintética. Não é a Maria nem uma simulação do servidor.</p>
      <aside className="harness-controls">
        <label>
          <input
            type="checkbox"
            checked={pending}
            onChange={(event) => setPending(event.target.checked)}
          />
          Etapa pendente
        </label>
        <label>
          <input
            type="checkbox"
            checked={available}
            onChange={(event) => setAvailable(event.target.checked)}
          />
          Callbacks locais disponíveis
        </label>
      </aside>
      <ImportLocalDocuments
        pending={pending}
        onConsent={
          available
            ? (files) =>
                setEvents((current) => [
                  ...current,
                  { kind: "consent", names: files.map((file) => file.name) },
                ])
            : undefined
        }
      />
      <button
        className="harness-open"
        type="button"
        onClick={() => setOpen(true)}
      >
        Abrir pergunta
      </button>
      {open && (
        <ImportFocusedQuestion
          question={question}
          lines={[
            {
              id: "purchase-first",
              titulo:
                "Sofá modular com descrição documental longa para verificar quebra de linha sem agrupar compras",
            },
            {
              id: "purchase-second",
              titulo:
                "Sofá modular com descrição documental longa para verificar quebra de linha sem agrupar compras",
            },
          ]}
          inputLabel="Sua resposta sobre esta compra"
          inputHint="Responda com suas palavras, sem converter o valor."
          pending={pending}
          onAnswer={
            available
              ? (answer) =>
                  setEvents((current) => [
                    ...current,
                    { kind: "answer", ...answer },
                  ])
              : undefined
          }
        />
      )}
      <output aria-label="Eventos locais">{JSON.stringify(events)}</output>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing harness root");
createRoot(root).render(<Harness />);
