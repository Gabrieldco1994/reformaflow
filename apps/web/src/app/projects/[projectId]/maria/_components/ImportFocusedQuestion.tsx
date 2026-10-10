"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  IMPORT_SESSION_LIMITS,
  IMPORT_SESSION_PRIMITIVES,
  normalizeImportDeclaration,
  parseInstallmentDateOnlyUtc,
  parseSpokenMoney,
  type ImportDeclaredFactViewV1,
  type ImportInterpretationResultV1,
  type ImportObservationQuestionV1,
  type ImportSessionGuidedReviewV1,
  type ImportSessionQuestionV1,
  type ImportTypedDraftAnswerV1,
  type ImportTypedGuidedAnswerV1,
} from "@reformaflow/domain";
import { Button } from "@/components/ui/button";
import journeyStyles from "@/components/import/ImportJourney.module.css";
import { importDeclarationContext } from "../_lib/import-session-read";
import {
  declarationFieldLabel,
  declarationValueLabel,
  importQuestionCopy,
  IMPORT_QUESTION_FIELD_LABEL,
  isGuidedDraftField,
  typedGuidedValueLabel,
  type GuidedDraftField,
} from "../_lib/import-question-copy";
import {
  ImportPurchaseStrip,
  type ImportPurchaseContext,
} from "./ImportPurchaseStrip";

export {
  declarationFieldLabel,
  declarationValueLabel,
  IMPORT_QUESTION_FIELD_LABEL,
} from "../_lib/import-question-copy";

type SaveCommand = {
  questionId: string;
  answer: ImportTypedGuidedAnswerV1 | ImportTypedDraftAnswerV1;
};

const UNAVAILABLE_DRAFT_COPY: Record<GuidedDraftField, string> = {
  decision:
    "As escolhas autorizadas para o destino desta compra não estão disponíveis. Consulte o estado guardado antes de continuar.",
  targets:
    "As finalidades autorizadas para esta compra não estão disponíveis. Consulte o estado guardado antes de continuar.",
  tipoDespesa:
    "Os tipos de despesa autorizados não estão disponíveis. Consulte o estado guardado antes de continuar.",
  categoriaMaoDeObra:
    "As categorias de mão de obra autorizadas não estão disponíveis. Consulte o estado guardado antes de continuar.",
};

type GuidedFocus = NonNullable<ImportSessionGuidedReviewV1["focus"]>;

function guidedPosition(
  focus: GuidedFocus,
  field:
    | "purchaseOrdinal"
    | "purchaseTotal"
    | "questionOrdinal"
    | "questionTotal",
) {
  return (focus as unknown as Record<typeof field, number>)[field];
}

type Props = {
  question: ImportSessionQuestionV1;
  lines: readonly ImportPurchaseContext[];
  inputLabel: string;
  inputHint: string;
  onSave?: (command: SaveCommand) => void | Promise<unknown>;
  onInterpret?: (text: string) => Promise<ImportInterpretationResultV1>;
  onVoice?: () => Promise<string>;
  /** Temporary adapter for route-local consumers migrating to typed commands. */
  onAnswer?: (answer: {
    id: ImportSessionQuestionV1["id"];
    text: string;
  }) => void;
  pending?: boolean;
  disabled?: boolean;
  declaredFacts?: readonly ImportDeclaredFactViewV1[];
  focusRequest?: number;
  guidedFocus?: GuidedFocus | null;
};

export function ImportFocusedQuestion({
  question,
  lines,
  inputLabel,
  inputHint,
  onSave,
  onInterpret,
  onVoice,
  onAnswer,
  pending = false,
  disabled = false,
  declaredFacts,
  focusRequest,
  guidedFocus,
}: Props) {
  const id = useId();
  const line = lines.find((candidate) =>
    question.lineIds.includes(candidate.id),
  );
  const ordinal = line
    ? Math.max(1, lines.findIndex((candidate) => candidate.id === line.id) + 1)
    : 1;
  const documentary: ImportObservationQuestionV1 | null =
    "subject" in question ? question : null;
  const context = documentary
    ? importDeclarationContext(documentary, declaredFacts ?? null)
    : null;
  const [structuredText, setStructuredText] = useState("");
  const [preview, setPreview] = useState<
    ImportTypedGuidedAnswerV1 | ImportTypedDraftAnswerV1 | null
  >(null);
  const [previewLabel, setPreviewLabel] = useState("");
  const [structuredError, setStructuredError] = useState("");
  const [freeOpen, setFreeOpen] = useState(false);
  const [freeText, setFreeText] = useState("");
  const [interpreting, setInterpreting] = useState(false);
  const [interpretationError, setInterpretationError] = useState("");
  const [restoreFreeInputFocus, setRestoreFreeInputFocus] = useState(false);
  const [candidate, setCandidate] = useState<ImportTypedGuidedAnswerV1 | null>(
    null,
  );
  const structuredInput = useRef<HTMLInputElement>(null);
  const freeInput = useRef<HTMLInputElement>(null);
  const voiceInput = useRef<HTMLButtonElement>(null);
  const container = useRef<HTMLElement>(null);
  const validationError = useRef<HTMLParagraphElement>(null);
  const lastFocusRequest = useRef<number | undefined>(undefined);
  const blocked = pending || disabled || !line;
  const numeric =
    question.field === "installmentCount" ||
    question.field === "installmentIndex";
  const date =
    question.field === "dataCompra" || question.field === "firstDueDate";
  const meaning = question.field === "amountMeaning";
  const guidedDraftField =
    !documentary && isGuidedDraftField(question.field) ? question.field : null;
  const authoritativeFocus =
    guidedFocus?.questionId === question.id && guidedFocus.lineId === line?.id
      ? guidedFocus
      : null;
  const guidedUnavailable = Boolean(guidedDraftField && !authoritativeFocus);
  const guidedOptions = authoritativeFocus?.options ?? [];
  const normalized =
    context && structuredText.trim()
      ? normalizeImportDeclaration(context, {
          kind: "VALUE",
          text: structuredText,
        })
      : null;

  useEffect(() => {
    setPreview(null);
    setPreviewLabel("");
    setStructuredError("");
  }, [structuredText, question.id]);
  useEffect(() => {
    setStructuredText("");
    setPreview(null);
    setPreviewLabel("");
    setStructuredError("");
  }, [question.id]);
  useEffect(() => {
    if (
      blocked ||
      focusRequest === undefined ||
      focusRequest === lastFocusRequest.current
    )
      return;
    lastFocusRequest.current = focusRequest;
    if (typeof container.current?.scrollIntoView === "function")
      container.current.scrollIntoView({ block: "nearest" });
    structuredInput.current?.focus();
  }, [blocked, focusRequest, question.id]);
  useEffect(() => {
    if (!interpreting && restoreFreeInputFocus) {
      freeInput.current?.focus();
      setRestoreFreeInputFocus(false);
    }
  }, [interpreting, restoreFreeInputFocus]);

  const typedStructuredAnswer = ():
    | ImportTypedGuidedAnswerV1
    | ImportTypedDraftAnswerV1
    | null => {
    if (documentary) {
      if (normalized?.kind !== "VALID") return null;
      return normalized.answer.value === null
        ? { kind: "UNKNOWN" }
        : { kind: "KNOWN", value: normalized.answer.value };
    }
    const value = structuredText.trim();
    if (!value) return null;
    if (authoritativeFocus) {
      const option = guidedOptions[Number(value)];
      return option?.answer ?? null;
    }
    if (question.field === "amountCents") {
      const reais = parseSpokenMoney(value);
      const cents = reais === null ? null : Math.round(reais * 100);
      return cents === null ||
        !Number.isSafeInteger(cents) ||
        cents < IMPORT_SESSION_PRIMITIVES.minPurchaseCents ||
        cents > IMPORT_SESSION_PRIMITIVES.maxCents
        ? null
        : { kind: "CENTS", value: cents };
    }
    if (numeric) {
      const number = Number(value);
      return Number.isSafeInteger(number) &&
        number >= 1 &&
        number <= IMPORT_SESSION_LIMITS.installmentsPerPurchase
        ? { kind: "POSITIVE_INTEGER", value: number }
        : null;
    }
    if (date) {
      const parsed = parseInstallmentDateOnlyUtc(value);
      return parsed &&
        parsed.getUTCFullYear() >= IMPORT_SESSION_PRIMITIVES.minYear &&
        parsed.getUTCFullYear() <= IMPORT_SESSION_PRIMITIVES.maxYear
        ? { kind: "DATE", value }
        : null;
    }
    if (meaning)
      return {
        kind: "AMOUNT_MEANING",
        value:
          value === "total da compra" ? "TOTAL_PURCHASE" : "INSTALLMENT_CHARGE",
      };
    return question.field === "merchant" ? { kind: "TEXT", value } : null;
  };

  const save = async (
    answer: ImportTypedGuidedAnswerV1 | ImportTypedDraftAnswerV1,
    legacyText = structuredText,
  ) => {
    if (blocked) return;
    if (onSave) await onSave({ questionId: question.id, answer });
    else onAnswer?.({ id: question.id, text: legacyText });
  };

  return (
    <section
      ref={container}
      aria-labelledby={`${id}-heading`}
      aria-busy={pending || interpreting}
      className={`${journeyStyles.journey} min-w-0 space-y-4 rounded-2xl border border-darc-linen bg-white p-4 pb-6`}
    >
      <p className="text-sm font-semibold text-darc-red">
        Só falta uma informação
      </p>
      <ImportPurchaseStrip
        line={
          authoritativeFocus
            ? {
                id: authoritativeFocus.lineId,
                titulo: authoritativeFocus.context.title,
                fornecedor: authoritativeFocus.context.merchant ?? undefined,
                amountCents:
                  authoritativeFocus.context.amountCents ?? undefined,
                dataCompra:
                  authoritativeFocus.context.purchaseDate ?? undefined,
              }
            : (line ?? lines[0])
        }
        ordinal={
          authoritativeFocus
            ? guidedPosition(authoritativeFocus, "purchaseOrdinal")
            : ordinal
        }
        total={
          authoritativeFocus
            ? guidedPosition(authoritativeFocus, "purchaseTotal")
            : lines.length
        }
      />
      {authoritativeFocus && (
        <p className="text-sm font-medium text-lifeone-ink-2">
          Pergunta {guidedPosition(authoritativeFocus, "questionOrdinal")} de{" "}
          {guidedPosition(authoritativeFocus, "questionTotal")} desta compra
        </p>
      )}
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          const answer = typedStructuredAnswer();
          if (answer) {
            setStructuredError("");
            setPreview(answer);
            if (authoritativeFocus) {
              const option = guidedOptions[Number(structuredText)];
              setPreviewLabel(option?.label ?? "");
            }
          } else {
            setStructuredError("Confira a informação e tente novamente.");
            queueMicrotask(() => validationError.current?.focus());
          }
        }}
      >
        <h3
          id={`${id}-heading`}
          className="break-words text-lg font-semibold text-darc-velvet"
        >
          {authoritativeFocus?.prompt ?? importQuestionCopy(question)}
        </h3>
        {!line && (
          <p role="alert" className="text-sm text-darc-red">
            Não foi possível mostrar o contexto desta compra. Consulte o estado
            guardado antes de continuar.
          </p>
        )}

        {guidedUnavailable && guidedDraftField ? (
          <p role="alert" className="text-sm text-darc-red">
            {UNAVAILABLE_DRAFT_COPY[guidedDraftField]}
          </p>
        ) : authoritativeFocus ? (
          <fieldset disabled={blocked} className="space-y-2">
            <legend className="sr-only">{authoritativeFocus.prompt}</legend>
            {guidedOptions.map((option, index) => {
              return (
                <label
                  key={`${option.label}:${index}`}
                  className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-darc-linen px-3 focus-within:outline focus-within:outline-2 focus-within:outline-darc-red"
                >
                  <input
                    ref={index === 0 ? structuredInput : undefined}
                    type="radio"
                    name={`${id}-guided`}
                    checked={structuredText === String(index)}
                    onChange={() => setStructuredText(String(index))}
                  />
                  {option.label}
                </label>
              );
            })}
          </fieldset>
        ) : meaning ? (
          <fieldset disabled={blocked} className="space-y-2">
            <legend className="sr-only">{importQuestionCopy(question)}</legend>
            {[
              {
                value: "TOTAL_PURCHASE",
                text: "total da compra",
                label: "É o total da compra",
              },
              {
                value: "INSTALLMENT_CHARGE",
                text: "valor da parcela",
                label: "É o valor de uma parcela",
              },
            ].map((option, index) => (
              <label
                key={option.value}
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-darc-linen px-3 focus-within:outline focus-within:outline-2 focus-within:outline-darc-red"
              >
                <input
                  ref={index === 0 ? structuredInput : undefined}
                  type="radio"
                  name={`${id}-meaning`}
                  checked={structuredText === option.text}
                  onChange={() => setStructuredText(option.text)}
                />
                {option.label}
              </label>
            ))}
          </fieldset>
        ) : (
          <label className="block text-sm font-medium text-darc-velvet">
            <span>
              {inputLabel || IMPORT_QUESTION_FIELD_LABEL[question.field]}
            </span>
            <input
              ref={structuredInput}
              type={date ? "date" : numeric ? "number" : "text"}
              inputMode={
                numeric
                  ? "numeric"
                  : question.field === "amountCents"
                    ? "decimal"
                    : undefined
              }
              min={
                date
                  ? `${IMPORT_SESSION_PRIMITIVES.minYear}-01-01`
                  : numeric
                    ? 1
                    : undefined
              }
              max={
                date
                  ? `${IMPORT_SESSION_PRIMITIVES.maxYear}-12-31`
                  : numeric
                    ? IMPORT_SESSION_LIMITS.installmentsPerPurchase
                    : undefined
              }
              placeholder={
                question.field === "amountCents"
                  ? "R$ 100,00"
                  : question.field === "merchant"
                    ? "Nome do estabelecimento"
                    : undefined
              }
              autoComplete="off"
              disabled={blocked}
              value={structuredText}
              onChange={(event) => setStructuredText(event.currentTarget.value)}
              className="mt-1 block min-h-11 w-full min-w-0 rounded-xl border border-darc-linen px-3 text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-darc-red"
            />
          </label>
        )}
        <p className="text-sm text-lifeone-ink-2">
          {inputHint}
          {date && " Exemplo: 08/10/2026."}
        </p>
        {structuredError && (
          <p
            ref={validationError}
            role="alert"
            tabIndex={-1}
            className="text-sm text-darc-red"
          >
            {structuredError}
          </p>
        )}
        <Button
          type="submit"
          className="min-h-11 w-full sm:w-auto"
          disabled={blocked || guidedUnavailable || !structuredText.trim()}
        >
          Conferir informação
        </Button>
      </form>

      {preview && (
        <section
          aria-label={
            authoritativeFocus
              ? "Confira antes de guardar"
              : "Prévia da informação"
          }
          className="space-y-2 rounded-xl bg-lifeone-surface p-3 text-sm"
        >
          {authoritativeFocus && (
            <>
              <p className="font-semibold">Confira antes de guardar</p>
              <p>
                Compra {guidedPosition(authoritativeFocus, "purchaseOrdinal")}{" "}
                de {guidedPosition(authoritativeFocus, "purchaseTotal")}
              </p>
              <p className="break-words">{authoritativeFocus.context.title}</p>
              <p>
                Pergunta {guidedPosition(authoritativeFocus, "questionOrdinal")}{" "}
                de {guidedPosition(authoritativeFocus, "questionTotal")} desta
                compra
              </p>
            </>
          )}
          <p className="font-semibold">
            {authoritativeFocus?.prompt ??
              IMPORT_QUESTION_FIELD_LABEL[question.field]}
          </p>
          <p className="break-words">
            {authoritativeFocus
              ? previewLabel
              : typedGuidedValueLabel(question.field, preview)}
          </p>
          {!authoritativeFocus && (
            <p>Confira antes de guardar. Esta prévia ainda não foi enviada.</p>
          )}
          <Button
            type="button"
            className="min-h-11 w-full sm:w-auto"
            disabled={blocked}
            onClick={() => void save(preview)}
          >
            {pending && authoritativeFocus
              ? "Guardando resposta…"
              : authoritativeFocus || documentary
                ? "Guardar e continuar"
                : "Guardar informação"}
          </Button>
        </section>
      )}

      {documentary && (
        <div className="border-t border-darc-linen pt-3">
          <Button
            type="button"
            variant="ghost"
            className="min-h-11"
            aria-expanded={freeOpen}
            aria-controls={`${id}-free-answer`}
            disabled={blocked}
            onClick={() => {
              setFreeOpen((open) => !open);
              setInterpretationError("");
              queueMicrotask(() => freeInput.current?.focus());
            }}
          >
            Prefiro digitar
          </Button>
          {onVoice && (
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              aria-expanded={freeOpen}
              aria-controls={`${id}-free-answer`}
              disabled={blocked}
              onClick={() => {
                setFreeOpen(true);
                setInterpretationError("");
                queueMicrotask(() => voiceInput.current?.focus());
              }}
            >
              Prefiro falar
            </Button>
          )}
        </div>
      )}

      {documentary && freeOpen && (
        <section id={`${id}-free-answer`} className="space-y-3">
          <p className="text-sm text-lifeone-ink-2">
            Seu texto será enviado ao provedor de IA apenas para interpretar
            esta resposta. Nenhuma compra será alterada até você conferir e
            guardar.
          </p>
          <label className="block text-sm font-medium">
            Sua resposta em texto
            <input
              ref={freeInput}
              value={freeText}
              disabled={blocked || interpreting}
              onChange={(event) => {
                setFreeText(event.currentTarget.value);
                setCandidate(null);
                setInterpretationError("");
              }}
              className="mt-1 block min-h-11 w-full min-w-0 rounded-xl border border-darc-linen px-3 text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-darc-red"
            />
          </label>
          <Button
            type="button"
            variant="secondary"
            className="min-h-11 w-full sm:w-auto"
            disabled={
              blocked || interpreting || !freeText.trim() || !onInterpret
            }
            onClick={async () => {
              if (!onInterpret) return;
              setInterpreting(true);
              setRestoreFreeInputFocus(false);
              setInterpretationError("");
              setCandidate(null);
              try {
                const outcome = await onInterpret(freeText);
                if (
                  outcome.outcome === "CANDIDATE" &&
                  outcome.candidate !== undefined
                )
                  setCandidate(outcome.candidate);
                else
                  setInterpretationError(
                    "Não foi possível entender com segurança. Use os controles acima ou ajuste o texto.",
                  );
              } catch {
                setInterpretationError(
                  "Não foi possível interpretar agora. Seu texto foi mantido; tente novamente ou use os controles acima.",
                );
                setRestoreFreeInputFocus(true);
              } finally {
                setInterpreting(false);
              }
            }}
          >
            {interpreting ? "Interpretando…" : "Interpretar resposta"}
          </Button>
          {onVoice && (
            <Button
              ref={voiceInput}
              type="button"
              variant="ghost"
              className="min-h-11 w-full sm:w-auto"
              disabled={blocked || interpreting}
              onClick={async () => {
                setInterpretationError("");
                try {
                  const transcript = await onVoice();
                  setFreeText(transcript);
                  setCandidate(null);
                  queueMicrotask(() => freeInput.current?.focus());
                } catch {
                  setInterpretationError(
                    "Não foi possível usar o microfone. Você pode responder pelos botões ou por texto.",
                  );
                  queueMicrotask(() => freeInput.current?.focus());
                }
              }}
            >
              Usar microfone
            </Button>
          )}
          {interpretationError && (
            <p role="alert" className="text-sm text-darc-red">
              {interpretationError}
            </p>
          )}
          {candidate && (
            <section
              aria-label="Prévia da resposta interpretada"
              className="space-y-2 rounded-xl bg-lifeone-surface p-3 text-sm"
            >
              <p className="font-semibold">Confira a interpretação</p>
              <p>{typedGuidedValueLabel(question.field, candidate)}</p>
              <Button
                type="button"
                className="min-h-11 w-full sm:w-auto"
                disabled={blocked}
                onClick={() => void save(candidate)}
              >
                Guardar informação
              </Button>
            </section>
          )}
        </section>
      )}

      {pending && (
        <p role="status" className="text-sm text-lifeone-ink-2">
          Guardando sua escolha…
        </p>
      )}
    </section>
  );
}
