"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  ExpenseType,
  type ImportSessionQuestionV1,
  type ImportSessionDraftLineV1,
  type ImportSessionFocusedDraftAnswerV1,
} from "@reformaflow/domain";
import { useProject } from "@/contexts/project-context";
import { Button } from "@/components/ui/button";
import journeyStyles from "@/components/import/ImportJourney.module.css";
import { getExpenseOptions } from "../../expenses/_types";
import { tipoLabel } from "@/lib/expense-options";
import { formatDateOnly } from "../_lib/import-format";
import { validFocusedDraftAnswer } from "../_lib/import-focused-draft";
import type { ImportQuestionAnswerInput } from "../_lib/import-session-api";

export interface ImportFocusedDraftQuestionProps {
  question: ImportSessionQuestionV1;
  lines: readonly Pick<ImportSessionDraftLineV1, "id" | "titulo">[];
  onAnswer?: (answer: ImportQuestionAnswerInput) => void;
  pending?: boolean;
  disabled?: boolean;
  value?: string;
  onTextChange?: (text: string) => void;
  contextKey?: string;
}

/** Explicit local draft preview: dates are literal date-only, categories remain separate questions. */
export function ImportFocusedDraftQuestion({
  question,
  lines,
  onAnswer,
  pending = false,
  disabled = false,
  value,
  onTextChange,
  contextKey = "",
}: ImportFocusedDraftQuestionProps) {
  const { projectType } = useProject();
  const options = getExpenseOptions(projectType);
  const id = useId();
  const [local, setLocal] = useState("");
  const text = value ?? local;
  const stamp = JSON.stringify([contextKey, question, projectType]);
  const [preview, setPreview] = useState<{
    answer: ImportSessionFocusedDraftAnswerV1;
    stamp: string;
    text: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sent = useRef(false);
  const control = useRef<HTMLInputElement | HTMLSelectElement | null>(null);
  const wasPending = useRef(pending);
  useEffect(() => {
    setPreview(null);
    setError(null);
  }, [text, stamp, disabled]);
  useEffect(() => {
    if (wasPending.current && !pending && !disabled) control.current?.focus();
    wasPending.current = pending;
  }, [pending, disabled]);
  const targets = question.lineIds.map((lineId) =>
    lines.find((line) => line.id === lineId),
  );
  const blocked =
    pending ||
    disabled ||
    !targets.length ||
    targets.some((line) => !line) ||
    !onAnswer;
  const currentPreview =
    preview?.stamp === stamp && preview.text === text ? preview : null;
  const isDate = question.field === "firstDueDate";
  const label = isDate ? "Primeiro vencimento" : "Tipo de despesa";
  function change(text: string) {
    setLocal(text);
    setPreview(null);
    onTextChange?.(text);
  }
  function check(answer: ImportSessionFocusedDraftAnswerV1 | null) {
    if (blocked) return;
    if (!answer || !validFocusedDraftAnswer(answer)) {
      setPreview(null);
      setError("Confira o campo antes de guardar.");
      return;
    }
    setError(null);
    setPreview({ answer, stamp, text });
  }
  function valueAnswer(): ImportSessionFocusedDraftAnswerV1 | null {
    if (isDate) return { field: "firstDueDate", value: text };
    const selected = options.find((option) => option.value === text);
    return selected ? { field: "tipoDespesa", value: selected.value } : null;
  }
  return (
    <form
      aria-labelledby={`${id}-question`}
      aria-busy={pending}
      className={`${journeyStyles.journey} space-y-3 rounded-xl border border-darc-linen bg-white p-4`}
      onSubmit={(event) => {
        event.preventDefault();
        check(valueAnswer());
      }}
    >
      <h3
        id={`${id}-question`}
        className="break-words text-base font-semibold text-darc-velvet"
      >
        {question.text}
      </h3>
      <ul aria-label="Compras desta pergunta" className="space-y-1 text-sm">
        {targets.map(
          (line, index) =>
            line && (
              <li key={question.lineIds[index]} className="break-words">
                {line.titulo} — Compra {line.id}
              </li>
            ),
        )}
      </ul>
      <label htmlFor={`${id}-input`} className="block text-sm font-medium">
        {label}
      </label>
      {isDate ? (
        <input
          ref={(element) => {
            control.current = element;
          }}
          id={`${id}-input`}
          type="date"
          min="1900-01-01"
          max="2199-12-31"
          value={text}
          onChange={(event) => change(event.target.value)}
          disabled={blocked}
          aria-describedby={`${id}-hint`}
          className="w-full rounded-xl border border-darc-linen px-3 py-2"
        />
      ) : (
        <select
          ref={(element) => {
            control.current = element;
          }}
          id={`${id}-input`}
          value={text}
          onChange={(event) => change(event.target.value)}
          disabled={blocked}
          aria-describedby={`${id}-hint`}
          className="w-full rounded-xl border border-darc-linen px-3 py-2"
        >
          <option value="">Escolha o tipo de despesa</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
      <p id={`${id}-hint`} className="text-sm text-gray-600">
        Confira antes de guardar. Este campo atualiza somente o rascunho; não
        confirma lançamentos.
      </p>
      {text === ExpenseType.MAO_DE_OBRA && !isDate && (
        <p className="text-sm">
          A categoria de mão de obra será informada na pergunta própria.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-darc-red">
          {error}
        </p>
      )}
      {pending && (
        <p role="status" className="text-sm">
          Aguardando o estado guardado no servidor.
        </p>
      )}
      {currentPreview && (
        <div
          aria-label="Prévia da informação"
          className="space-y-2 rounded-xl bg-lifeone-surface p-3 text-sm"
        >
          <p>{label}</p>
          <p>
            {currentPreview.answer.value === null
              ? "Não sei informar"
              : currentPreview.answer.field === "firstDueDate"
                ? formatDateOnly(currentPreview.answer.value)
                : tipoLabel(currentPreview.answer.value)}
          </p>
          <p>Esta prévia ainda não foi enviada.</p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" className="min-h-11" disabled={blocked || !text}>
          Conferir informação
        </Button>
        <Button
          type="button"
          className="min-h-11"
          disabled={blocked}
          onClick={() =>
            check(
              isDate
                ? { field: "firstDueDate", value: null }
                : { field: "tipoDespesa", value: null },
            )
          }
        >
          Não sei informar
        </Button>
        <Button
          type="button"
          className="min-h-11"
          disabled={blocked || !currentPreview}
          onClick={() => {
            if (blocked || !currentPreview || sent.current || !onAnswer) return;
            sent.current = true;
            queueMicrotask(() => {
              sent.current = false;
            });
            onAnswer({
              id: question.id,
              text,
              draftAnswer: currentPreview.answer,
            });
          }}
        >
          Guardar informação
        </Button>
      </div>
    </form>
  );
}
