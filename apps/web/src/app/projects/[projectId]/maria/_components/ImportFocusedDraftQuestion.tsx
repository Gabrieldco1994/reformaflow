"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  ExpenseType,
  type ImportSessionQuestionV1,
  type ImportSessionDraftLineV1,
} from "@reformaflow/domain";
import { useProject } from "@/contexts/project-context";
import { Button } from "@/components/ui/button";
import journeyStyles from "@/components/import/ImportJourney.module.css";
import { getExpenseOptions } from "../../expenses/_types";
import { tipoLabel } from "@/lib/expense-options";
import { formatDateOnly } from "../_lib/import-format";
import {
  FOCUSED_DRAFT_LABEL,
  validFocusedDraftAnswer,
} from "../_lib/import-focused-draft";
import type { FocusedDraftAnswer } from "../_lib/import-focused-draft-types";
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
  onOtherChoice?: () => void;
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
  onOtherChoice,
}: ImportFocusedDraftQuestionProps) {
  const { projectType } = useProject();
  const options = getExpenseOptions(projectType);
  const id = useId();
  const [local, setLocal] = useState("");
  const text = value ?? local;
  const stamp = JSON.stringify([contextKey, question, projectType]);
  const [preview, setPreview] = useState<{
    answer: FocusedDraftAnswer;
    stamp: string;
    text: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choiceStamp, setChoiceStamp] = useState<string | null>(null);
  const sent = useRef(false);
  const control = useRef<HTMLInputElement | HTMLSelectElement | null>(null);
  const wasPending = useRef(pending);
  useEffect(() => {
    setPreview(null);
    setError(null);
  }, [text, stamp, disabled]);
  useEffect(() => {
    setChoiceStamp(null);
  }, [stamp, disabled]);
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
  function fieldLabel(): string {
    switch (question.field) {
      case "firstDueDate":
        return FOCUSED_DRAFT_LABEL.firstDueDate;
      case "tipoDespesa":
        return FOCUSED_DRAFT_LABEL.tipoDespesa;
      case "decision":
        return FOCUSED_DRAFT_LABEL.decision;
      case "targets":
        return FOCUSED_DRAFT_LABEL.targets;
      default:
        return "";
    }
  }
  const label = fieldLabel();
  const choice = question.field === "decision" || question.field === "targets";
  const selectedChoice = choiceStamp === stamp;
  function change(text: string) {
    setLocal(text);
    setPreview(null);
    onTextChange?.(text);
  }
  function check(answer: FocusedDraftAnswer | null) {
    if (blocked) return;
    if (!answer || !validFocusedDraftAnswer(answer)) {
      setPreview(null);
      setError("Confira o campo antes de guardar.");
      return;
    }
    setError(null);
    setPreview({ answer, stamp, text });
  }
  function valueAnswer(): FocusedDraftAnswer | null {
    switch (question.field) {
      case "firstDueDate":
        return { field: "firstDueDate", value: text };
      case "tipoDespesa": {
        const selected = options.find((option) => option.value === text);
        return selected
          ? { field: "tipoDespesa", value: selected.value }
          : null;
      }
      case "decision":
        return selectedChoice
          ? {
              field: "decision",
              value: { kind: "CREATE", acceptNaturalDuplicate: false },
            }
          : null;
      case "targets":
        return selectedChoice ? { field: "targets", value: [] } : null;
      default:
        return null;
    }
  }
  function unknownAnswer(): FocusedDraftAnswer | null {
    switch (question.field) {
      case "firstDueDate":
        return { field: "firstDueDate", value: null };
      case "tipoDespesa":
        return { field: "tipoDespesa", value: null };
      default:
        return null;
    }
  }
  function previewLabel(answer: FocusedDraftAnswer): string | null {
    switch (answer.field) {
      case "firstDueDate":
        return answer.value === null
          ? "Não sei informar"
          : formatDateOnly(answer.value);
      case "tipoDespesa":
        return answer.value === null
          ? "Não sei informar"
          : tipoLabel(answer.value);
      case "decision":
        return FOCUSED_DRAFT_LABEL.decision;
      case "targets":
        return FOCUSED_DRAFT_LABEL.targets;
    }
  }
  function renderControl() {
    switch (question.field) {
      case "firstDueDate":
        return (
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
        );
      case "tipoDespesa":
        return (
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
        );
      case "decision":
      case "targets":
        return (
          <label className="flex min-h-11 items-center gap-3 rounded-xl border border-darc-linen p-3">
            <input
              ref={(element) => {
                control.current = element;
              }}
              id={`${id}-input`}
              type="radio"
              name={`${id}-choice`}
              checked={selectedChoice}
              disabled={blocked}
              aria-describedby={`${id}-hint`}
              onChange={() => {
                setChoiceStamp(stamp);
                change(label);
              }}
              className="h-5 w-5 shrink-0"
            />
            <span className="min-w-0 break-words text-sm">{label}</span>
          </label>
        );
      default:
        return null;
    }
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
      {!choice && (
        <label htmlFor={`${id}-input`} className="block text-sm font-medium">
          {label}
        </label>
      )}
      {renderControl()}
      <p id={`${id}-hint`} className="text-sm text-gray-600">
        Confira antes de guardar. Este campo atualiza somente o rascunho; não
        confirma lançamentos.
      </p>
      {text === ExpenseType.MAO_DE_OBRA && question.field === "tipoDespesa" && (
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
          <p>{previewLabel(currentPreview.answer)}</p>
          {choice && (
            <ul
              aria-label="Compras afetadas pela escolha"
              className="space-y-1"
            >
              {targets.map(
                (line) =>
                  line && (
                    <li key={line.id} className="break-words">
                      {line.titulo} — Compra {line.id}
                    </li>
                  ),
              )}
            </ul>
          )}
          <p>Esta prévia ainda não foi enviada.</p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          className="min-h-11"
          disabled={blocked || (choice ? !selectedChoice : !text)}
        >
          Conferir informação
        </Button>
        {!choice && (
          <Button
            type="button"
            className="min-h-11"
            disabled={blocked}
            onClick={() => check(unknownAnswer())}
          >
            Não sei informar
          </Button>
        )}
        {choice && onOtherChoice && (
          <Button
            type="button"
            className="min-h-11"
            disabled={blocked}
            onClick={onOtherChoice}
          >
            Responder outra opção pela conversa
          </Button>
        )}
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
