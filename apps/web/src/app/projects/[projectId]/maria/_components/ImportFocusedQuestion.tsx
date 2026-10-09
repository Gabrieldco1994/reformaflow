"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  IMPORT_SESSION_LIMITS as L,
  IMPORT_SESSION_PRIMITIVES as P,
  encodeImportDeclaration,
  normalizeImportDeclaration,
  type ImportDeclarationAnswerV1,
  type ImportDeclarationUiInputV1,
  type ImportDeclaredFactViewV1,
  type ImportObservationQuestionV1,
  type ImportSessionDraftLineV1,
  type ImportSessionQuestionV1,
} from "@reformaflow/domain";
import { moneyDetail } from "@/lib/money";
import { formatDateOnly } from "../_lib/import-format";
import { importDeclarationContext } from "../_lib/import-session-read";
import { Button } from "@/components/ui/button";
import journeyStyles from "@/components/import/ImportJourney.module.css";

type ImportFocusedQuestionProps = {
  question: ImportSessionQuestionV1;
  lines: readonly Pick<ImportSessionDraftLineV1, "id" | "titulo">[];
  inputLabel: string;
  inputHint: string;
  /** Local literal answer, not a normalized draft mutation or a transport callback. */
  onAnswer?: (answer: {
    id: ImportSessionQuestionV1["id"];
    text: string;
  }) => void;
  pending?: boolean;
  disabled?: boolean;
  value?: string;
  onTextChange?: (text: string) => void;
  contextKey?: string;
  declaredFacts?: readonly ImportDeclaredFactViewV1[];
  relatedQuestions?: readonly ImportObservationQuestionV1[];
  guided?: boolean;
  onStartGuided?: () => void;
  onChooseQuestion?: (id: string) => void;
};

export const IMPORT_QUESTION_FIELD_LABEL: Record<
  ImportSessionQuestionV1["field"],
  string
> = {
  amountMeaning: "Significado do valor",
  amountCents: "Valor da compra",
  installmentCount: "Quantidade de parcelas",
  dataCompra: "Data da compra",
  firstDueDate: "Primeiro vencimento",
  targets: "Finalidade da compra",
  decision: "Criar compra ou manter existente",
  tipoDespesa: "Tipo de despesa",
  categoriaMaoDeObra: "Categoria de mão de obra",
  merchant: "Nome do estabelecimento",
  installmentIndex: "Número desta parcela",
};

export function declarationFieldLabel(
  answer: ImportDeclarationAnswerV1,
): string {
  return answer.field === "amountCents"
    ? answer.meaningContext === "TOTAL_PURCHASE"
      ? "Total da compra"
      : "Valor da parcela"
    : IMPORT_QUESTION_FIELD_LABEL[answer.field];
}

export function declarationValueLabel(
  answer: ImportDeclarationAnswerV1,
): string {
  if (answer.value === null) return "Não sei informar";
  if (answer.field === "amountCents") return moneyDetail(answer.value);
  if (answer.field === "dataCompra")
    return formatDateOnly(answer.value) ?? "Data inválida";
  if (answer.field === "amountMeaning")
    return answer.value === "TOTAL_PURCHASE"
      ? "Total da compra"
      : "Valor da parcela";
  return String(answer.value);
}

function FocusedQuestion({
  question,
  lines,
  inputLabel,
  inputHint,
  onAnswer,
  pending = false,
  disabled = false,
  value,
  onTextChange,
  contextKey = "",
  declaredFacts,
  relatedQuestions,
  guided = false,
  onStartGuided,
  onChooseQuestion,
}: ImportFocusedQuestionProps) {
  const id = useId();
  const [localText, setText] = useState("");
  const [rawMode, setRawMode] = useState(false);
  const text = value ?? localText;
  const documentary = "subject" in question ? question : null;
  const context = documentary
    ? importDeclarationContext(documentary, declaredFacts ?? null)
    : null;
  const stamp = JSON.stringify([contextKey, question, context]);
  const [preview, setPreview] = useState<{
    text: string;
    stamp: string;
    input: ImportDeclarationUiInputV1;
    answer: ImportDeclarationAnswerV1;
  } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
  }, [text, stamp, disabled]);
  const currentPreview =
    preview?.text === text && preview.stamp === stamp ? preview : null;
  const normalized = context
    ? normalizeImportDeclaration(context, { kind: "VALUE", text })
    : null;
  const numeric =
    documentary?.field === "installmentCount" ||
    documentary?.field === "installmentIndex";
  const date = documentary?.field === "dataCompra";
  const meaning = documentary?.field === "amountMeaning";
  const structured = numeric || date || meaning;
  const fieldLabel =
    documentary && documentary.field !== "amountCents"
      ? IMPORT_QUESTION_FIELD_LABEL[documentary.field]
      : inputLabel;
  const controlValue =
    !rawMode && (numeric || date)
      ? normalized?.kind === "VALID" && normalized.answer.value !== null
        ? String(normalized.answer.value)
        : ""
      : text;
  const changeText = (value: string) => {
    setText(value);
    setPreview(null);
    onTextChange?.(value);
  };
  const sent = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const wasPending = useRef(pending);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending) {
      restoreFocus.current = true;
    }
    wasPending.current = pending;
    if (restoreFocus.current && !pending && !disabled) {
      restoreFocus.current = false;
      input.current?.focus();
    }
  }, [pending, disabled]);
  const targets = question.lineIds.map((lineId) =>
    lines.find((line) => line.id === lineId),
  );
  const complete =
    Boolean(IMPORT_QUESTION_FIELD_LABEL[question.field]) &&
    targets.length > 0 &&
    targets.every(Boolean);
  const blocked = pending || disabled || !complete;
  const previewInput = (input: ImportDeclarationUiInputV1) => {
    if (!context || blocked) return;
    const result = normalizeImportDeclaration(context, input);
    setPreview(
      result.kind === "VALID"
        ? { text, stamp, input, answer: result.answer }
        : null,
    );
  };

  return (
    <form
      aria-labelledby={`${id}-question`}
      aria-busy={pending}
      className={`${journeyStyles.journey} space-y-3 rounded-xl border border-darc-linen bg-white p-4`}
      onSubmit={(event) => {
        event.preventDefault();
        if (blocked || sent.current || !onAnswer || !text.trim()) return;
        if (documentary) {
          previewInput({ kind: "VALUE", text });
          return;
        }
        sent.current = true;
        // Coalesce same-tick intents; only the caller owns the pending gate.
        queueMicrotask(() => {
          sent.current = false;
        });
        onAnswer({ id: question.id, text });
      }}
    >
      <h3
        id={`${id}-question`}
        className="break-words text-base font-semibold text-darc-velvet"
      >
        {question.text}
      </h3>
      <ul
        aria-label="Compras desta pergunta"
        className="space-y-1 text-sm text-darc-velvet"
      >
        {targets.map(
          (line, index) =>
            line && (
              <li key={question.lineIds[index]} className="break-words">
                {line.titulo}{" "}
                <span className="text-gray-600">— Compra {line.id}</span>
              </li>
            ),
        )}
      </ul>
      <p className="text-sm font-medium text-darc-velvet">
        {documentary?.field === "amountCents"
          ? documentary.subject.meaningContext === "INSTALLMENT_CHARGE"
            ? "Valor da parcela"
            : "Total da compra"
          : IMPORT_QUESTION_FIELD_LABEL[question.field]}
      </p>
      {!complete && (
        <p role="alert" className="text-sm text-darc-red">
          A pergunta completa e suas compras são necessárias para responder.
          Retome quando esses dados estiverem disponíveis.
        </p>
      )}
      {meaning && !rawMode ? (
        <fieldset
          disabled={blocked}
          aria-describedby={`${id}-hint`}
          className="space-y-2"
        >
          <legend className="text-sm font-medium">{fieldLabel}</legend>
          {[
            {
              value: "TOTAL_PURCHASE",
              label: "Total da compra",
              text: "total da compra",
            },
            {
              value: "INSTALLMENT_CHARGE",
              label: "Valor da parcela",
              text: "valor da parcela",
            },
          ].map((option, index) => (
            <label
              key={option.value}
              className="flex min-h-11 items-center gap-3 rounded-lg border px-3"
            >
              <input
                ref={index === 0 ? input : undefined}
                type="radio"
                name={id}
                value={option.value}
                checked={
                  normalized?.kind === "VALID" &&
                  normalized.answer.value === option.value
                }
                onChange={() => changeText(option.text)}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
      ) : (
        <>
          <label
            htmlFor={id}
            className="block text-sm font-medium text-darc-velvet"
          >
            {fieldLabel}
          </label>
          <input
            key={rawMode ? "raw-text" : question.field}
            ref={input}
            id={id}
            type={
              !rawMode && date
                ? "date"
                : !rawMode && numeric
                  ? "number"
                  : "text"
            }
            inputMode={
              rawMode
                ? "text"
                : numeric
                  ? "numeric"
                  : documentary?.field === "amountCents"
                    ? "decimal"
                    : undefined
            }
            min={
              !rawMode && date
                ? `${P.minYear}-01-01`
                : numeric && !rawMode
                  ? 1
                  : undefined
            }
            max={
              !rawMode && date
                ? `${P.maxYear}-12-31`
                : numeric && !rawMode
                  ? documentary?.field === "installmentIndex"
                    ? (context?.effectiveInstallmentCount ??
                      L.installmentsPerPurchase)
                    : L.installmentsPerPurchase
                  : undefined
            }
            step={numeric && !rawMode ? 1 : undefined}
            placeholder={
              documentary?.field === "amountCents"
                ? "R$ 100,00"
                : documentary?.field === "merchant"
                  ? "Nome do estabelecimento"
                  : undefined
            }
            autoFocus={!blocked}
            autoComplete="off"
            disabled={blocked}
            aria-describedby={`${id}-hint`}
            value={controlValue}
            onChange={(event) => changeText(event.currentTarget.value)}
            className="block min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 text-base text-darc-velvet focus-visible:outline focus-visible:outline-2 focus-visible:outline-darc-red"
          />
        </>
      )}
      <p id={`${id}-hint`} className="text-sm text-gray-600">
        {inputHint}
        {date && " Exemplo: 08/10/2026."}
        {numeric && " Informe um número inteiro para este campo."}
      </p>
      {structured && (
        <Button
          type="button"
          disabled={blocked || !onAnswer}
          className="min-h-11"
          onClick={() => {
            setRawMode(!rawMode);
            setPreview(null);
          }}
        >
          {rawMode ? "Usar campo guiado" : "Responder com texto"}
        </Button>
      )}
      {structured &&
        !rawMode &&
        text.trim() &&
        normalized?.kind === "CLARIFY" && (
          <div className="space-y-1 break-words text-sm">
            <p>Resposta recebida:</p>
            <p>{text}</p>
          </div>
        )}
      {!onAnswer && (
        <p className="text-sm text-gray-600">
          Resposta indisponível nesta etapa.
        </p>
      )}
      {pending && (
        <p role="status" className="text-sm text-gray-600">
          Aguardando resposta do servidor. Nenhuma alteração financeira foi
          confirmada aqui.
        </p>
      )}
      {documentary && text.trim() && normalized?.kind === "CLARIFY" && (
        <p role="status" className="text-sm text-darc-velvet">
          {question.field === "amountCents"
            ? "Essa frase não informa o valor de forma inequívoca. Informe somente o valor solicitado."
            : question.field === "installmentCount"
              ? "Se você informou a parcela e a quantidade, informe somente a quantidade total de parcelas, por exemplo 3."
              : "Informe somente este campo para conferir a informação antes de guardar."}
        </p>
      )}
      {documentary &&
        text.trim() &&
        normalized?.kind === "CLARIFY" &&
        Boolean(relatedQuestions?.length) &&
        onStartGuided && (
          <Button
            type="button"
            disabled={blocked || !onAnswer}
            className="min-h-11"
            onClick={() => {
              setRawMode(false);
              setPreview(null);
              onStartGuided();
            }}
          >
            Responder campo por campo
          </Button>
        )}
      {guided && relatedQuestions && onChooseQuestion && (
        <div
          aria-label="Campos desta observação"
          className="flex flex-wrap gap-2"
        >
          {relatedQuestions.map((related) => (
            <Button
              key={related.id}
              type="button"
              disabled={blocked || !onAnswer}
              className="min-h-11"
              onClick={() => {
                setRawMode(false);
                setPreview(null);
                onChooseQuestion(related.id);
              }}
            >
              Informar {IMPORT_QUESTION_FIELD_LABEL[related.field]}
            </Button>
          ))}
        </div>
      )}
      {previewError && (
        <p role="alert" className="text-sm text-darc-red">
          {previewError}
        </p>
      )}
      {documentary && currentPreview && (
        <div
          aria-label="Prévia da informação"
          className="space-y-2 rounded-xl bg-lifeone-surface p-3 text-sm"
        >
          <p>
            Observação {documentary.subject.observationId} · Compra{" "}
            {documentary.lineIds[0]}
          </p>
          <p>{declarationFieldLabel(currentPreview.answer)}</p>
          <p>
            <span
              className={
                currentPreview.answer.field === "amountCents"
                  ? "whitespace-nowrap tabular-nums"
                  : "break-words"
              }
            >
              {declarationValueLabel(currentPreview.answer)}
            </span>
          </p>
          <p>
            {currentPreview.input.kind === "REMOVE"
              ? "Remover esta informação guardada."
              : "Confira antes de guardar. Esta prévia ainda não foi enviada."}
          </p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          className="min-h-11"
          disabled={blocked || !onAnswer || !text.trim()}
        >
          {documentary ? "Conferir informação" : "Responder à pergunta"}
        </Button>
        {documentary && (
          <>
            <Button
              type="button"
              className="min-h-11"
              disabled={blocked || !onAnswer}
              onClick={() => previewInput({ kind: "UNKNOWN" })}
            >
              Não sei informar
            </Button>
            <Button
              type="button"
              className="min-h-11"
              disabled={blocked || !onAnswer}
              onClick={() => previewInput({ kind: "REMOVE" })}
            >
              Remover informação
            </Button>
            <Button
              type="button"
              className="min-h-11"
              disabled={blocked || !onAnswer || !currentPreview}
              onClick={() => {
                if (
                  !context ||
                  !currentPreview ||
                  blocked ||
                  sent.current ||
                  !onAnswer
                )
                  return;
                const encoded = encodeImportDeclaration(
                  context,
                  currentPreview.input,
                );
                if (encoded.kind !== "ENCODED") {
                  setPreview(null);
                  setPreviewError(
                    "Informação inválida. Confira novamente antes de guardar.",
                  );
                  return;
                }
                sent.current = true;
                queueMicrotask(() => {
                  sent.current = false;
                });
                onAnswer({ id: question.id, text: encoded.literalAnswer });
              }}
            >
              Guardar informação
            </Button>
          </>
        )}
      </div>
    </form>
  );
}

/** Mount only when the user opens the active question; refreshes keep text and keyboard focus. */
export function ImportFocusedQuestion(props: ImportFocusedQuestionProps) {
  return <FocusedQuestion key={props.question.id} {...props} />;
}
