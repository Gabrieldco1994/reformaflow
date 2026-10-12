"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  ExpenseType,
  hasFeature,
  IMPORT_SESSION_LIMITS,
  IMPORT_SESSION_PRIMITIVES,
  ImportSessionAmountMeaning,
  ProjectType,
  type LaborCategory,
  type ImportSessionCandidateV1,
  type ImportSessionDraftLineV1,
  type ImportSessionQuestionV1,
} from "@reformaflow/domain";
import { useProject } from "@/contexts/project-context";
import { Button } from "@/components/ui/button";
import journeyStyles from "@/components/import/ImportJourney.module.css";
import { getExpenseOptions } from "../../expenses/_types";
import {
  CATEGORIA_MAO_DE_OBRA_OPTIONS,
  catMaoLabel,
  tipoLabel,
} from "@/lib/expense-options";
import { moneyDetail } from "@/lib/money";
import { formatDateOnly } from "../_lib/import-format";
import {
  FOCUSED_DRAFT_LABEL,
  validFocusedDraftAnswer,
} from "../_lib/import-focused-draft";
import {
  deterministicVoiceAnswer,
  strictDraftAnswer,
} from "../_lib/import-manual-answer";
import type { FocusedDraftAnswer } from "../_lib/import-focused-draft-types";
import type { ImportQuestionAnswerInput } from "../_lib/import-session-api";

export interface ImportTargetProjectOption {
  id: string;
  name: string;
  projectType: ProjectType;
  eligible: boolean;
  active: boolean;
  deletedAt: string | null;
  rooms: readonly { id: string; name: string }[];
}

export interface ImportVoiceCapture {
  id: number;
  text: string;
  questionId: string;
  revision: number;
}

export interface ImportFocusedDraftQuestionProps {
  question: ImportSessionQuestionV1;
  lines: readonly ImportPurchaseContextLine[];
  onAnswer?: (answer: ImportQuestionAnswerInput) => void;
  pending?: boolean;
  disabled?: boolean;
  value?: string;
  onTextChange?: (text: string) => void;
  contextKey?: string;
  ownerProjectId?: string;
  candidates?: readonly ImportSessionCandidateV1[];
  targetProjects?: readonly ImportTargetProjectOption[];
  optionsPending?: boolean;
  optionsError?: string | null;
  voiceCapture?: ImportVoiceCapture | null;
  revision?: number;
  onVoiceGuidance?: (message: string) => void;
}

export type ImportPurchaseContextLine = Pick<
  ImportSessionDraftLineV1,
  "id" | "titulo"
> &
  Partial<
    Pick<
      ImportSessionDraftLineV1,
      | "fornecedor"
      | "amountMeaning"
      | "amountCents"
      | "dataCompra"
      | "installmentCount"
    >
  >;

const AMOUNT_MEANING_LABELS: Record<ImportSessionAmountMeaning, string> = {
  [ImportSessionAmountMeaning.TOTAL_PURCHASE]: "Total",
  [ImportSessionAmountMeaning.INSTALLMENT_CHARGE]: "Parcela",
  [ImportSessionAmountMeaning.UNKNOWN]: "Valor",
};

export function formatImportPurchaseContext(
  line: ImportPurchaseContextLine,
): string {
  const merchant = line.fornecedor?.trim() ?? "";
  const title = line.titulo.trim();
  const identity = merchant
    ? title && title !== merchant
      ? `${merchant} — ${title}`
      : merchant
    : title || "Compra";
  const details = [identity];
  const date = formatDateOnly(line.dataCompra);
  if (date) details.push(date);
  if (line.amountCents !== null && line.amountCents !== undefined) {
    const meaning = line.amountMeaning
      ? (AMOUNT_MEANING_LABELS[line.amountMeaning] ?? "Valor")
      : "Valor";
    details.push(`${moneyDetail(line.amountCents)} · ${meaning}`);
  }
  if (line.installmentCount !== null && line.installmentCount !== undefined) {
    details.push(
      `${line.installmentCount} ${
        line.installmentCount === 1 ? "parcela" : "parcelas"
      }`,
    );
  }
  return details.join(" · ");
}

const MEANING_OPTIONS = [
  {
    value: ImportSessionAmountMeaning.TOTAL_PURCHASE,
    label: "Total da compra",
  },
  {
    value: ImportSessionAmountMeaning.INSTALLMENT_CHARGE,
    label: "Valor da parcela",
  },
] as const;

const DECISION_CREATE = "CREATE";
const DECISION_WAIVER = "CREATE_ACCEPT_NATURAL_DUPLICATE";
const TARGET_NONE = "NO_TARGETS";
const TARGET_INTEGRAL = "target";

type DecisionAnswer = Extract<
  FocusedDraftAnswer,
  { field: "decision" }
>["value"];

interface DecisionChoice {
  value: string;
  label: string;
  answer: DecisionAnswer;
}

function keepExistingChoice(
  candidate: ImportSessionCandidateV1 & { kind: "EXPENSE" },
): DecisionChoice {
  return {
    value: candidate.id,
    label: `Manter compra existente: ${candidate.description} · ${moneyDetail(candidate.amountCents)}`,
    answer: { kind: "KEEP_EXISTING", expenseId: candidate.id },
  };
}

function supportedDecisionChoices(
  candidates: readonly ImportSessionCandidateV1[],
  lineIds: readonly string[],
): DecisionChoice[] {
  if (candidates.length === 0)
    return [
      {
        value: DECISION_CREATE,
        label: "Criar nova compra",
        answer: { kind: "CREATE", acceptNaturalDuplicate: false },
      },
    ];

  const visible = candidates.filter((candidate) =>
    lineIds.includes(candidate.lineId),
  );
  const strong = visible.filter(
    (candidate) => candidate.reason === "STRONG_IDENTITY",
  );
  if (strong.length > 0) {
    if (
      strong.some(
        (candidate) =>
          candidate.kind !== "EXPENSE" || !candidate.canKeepExisting,
      )
    )
      return [];
    return strong
      .filter(
        (
          candidate,
        ): candidate is ImportSessionCandidateV1 & { kind: "EXPENSE" } =>
          candidate.kind === "EXPENSE",
      )
      .map(keepExistingChoice);
  }

  const choices: DecisionChoice[] = [];
  if (visible.some((candidate) => candidate.reason === "NATURAL_MATCH"))
    choices.push({
      value: DECISION_WAIVER,
      label: "Criar outra compra — são compras distintas",
      answer: { kind: "CREATE", acceptNaturalDuplicate: true },
    });
  choices.push(
    ...visible
      .filter(
        (
          candidate,
        ): candidate is ImportSessionCandidateV1 & { kind: "EXPENSE" } =>
          candidate.kind === "EXPENSE" && candidate.canKeepExisting,
      )
      .map(keepExistingChoice),
  );
  return choices;
}

export function ImportFocusedDraftQuestion({
  question,
  lines,
  onAnswer,
  pending = false,
  disabled = false,
  value,
  onTextChange,
  contextKey = "",
  ownerProjectId: suppliedOwnerProjectId,
  candidates = [],
  targetProjects = [],
  optionsPending = false,
  optionsError = null,
  voiceCapture = null,
  revision,
  onVoiceGuidance,
}: ImportFocusedDraftQuestionProps) {
  const { projectId: contextProjectId, projectType } = useProject();
  const ownerProjectId = suppliedOwnerProjectId ?? contextProjectId;
  const expenseOptions = getExpenseOptions(projectType);
  const id = useId();
  const [local, setLocal] = useState("");
  const text = value ?? local;
  const stamp = JSON.stringify([
    contextKey,
    question,
    projectType,
    ownerProjectId,
    candidates,
    targetProjects,
  ]);
  const [preview, setPreview] = useState<{
    answer: FocusedDraftAnswer;
    stamp: string;
    text: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState("");
  const [roomId, setRoomId] = useState("");
  const sent = useRef(false);
  const control = useRef<
    HTMLInputElement | HTMLSelectElement | HTMLButtonElement | null
  >(null);
  const handledVoice = useRef<number | null>(null);
  const wasPending = useRef(pending);
  const targets = question.lineIds.map((lineId) =>
    lines.find((line) => line.id === lineId),
  );
  const targetLine = targets.length === 1 ? targets[0] : null;
  const targetAmount = targetLine?.amountCents ?? null;
  const eligibleTargetProjects = targetProjects.filter(
    (project) =>
      project.id !== ownerProjectId &&
      project.active &&
      project.deletedAt === null &&
      project.eligible &&
      project.projectType === ProjectType.REFORMA &&
      hasFeature(project.projectType, "expenses"),
  );
  const selectedProject = eligibleTargetProjects.find(
    (project) => project.id === projectId,
  );
  const decisionChoices = supportedDecisionChoices(
    candidates,
    question.lineIds,
  );
  const decisionRecovery =
    question.field === "decision" &&
    !optionsPending &&
    !optionsError &&
    decisionChoices.length === 0;
  const requiresOptions =
    question.field === "decision" || question.field === "targets";
  const complete =
    targets.length > 0 &&
    targets.every(Boolean) &&
    (!requiresOptions || (!optionsPending && !optionsError)) &&
    !decisionRecovery;
  const blocked = pending || disabled || !complete || !onAnswer;
  const currentPreview =
    preview?.stamp === stamp && preview.text === text ? preview : null;

  useEffect(() => {
    setPreview(null);
    setError(null);
  }, [text, stamp, disabled]);
  useEffect(() => {
    setProjectId("");
    setRoomId("");
  }, [stamp]);
  useEffect(() => {
    if (wasPending.current && !pending && !disabled) control.current?.focus();
    wasPending.current = pending;
  }, [pending, disabled]);
  function change(next: string) {
    setLocal(next);
    setPreview(null);
    setError(null);
    onTextChange?.(next);
  }

  function answerForCurrentValue(): FocusedDraftAnswer | null {
    if ("subject" in question) return null;
    if (question.field === "decision") {
      const choice = decisionChoices.find((option) => option.value === text);
      return choice ? { field: "decision", value: choice.answer } : null;
    }
    if (question.field === "tipoDespesa") {
      const selected = expenseOptions.find((option) => option.value === text);
      return selected ? { field: "tipoDespesa", value: selected.value } : null;
    }
    if (question.field === "categoriaMaoDeObra") {
      const selected = CATEGORIA_MAO_DE_OBRA_OPTIONS.find(
        (option) => option.value === text,
      );
      return selected
        ? {
            field: "categoriaMaoDeObra",
            value: selected.value as LaborCategory,
          }
        : null;
    }
    return strictDraftAnswer(question.field, text, {
      amountCents: targetAmount,
      projectId: selectedProject?.id ?? null,
      roomId:
        selectedProject?.rooms.some((room) => room.id === roomId) && roomId
          ? roomId
          : null,
    });
  }

  function check(answer: FocusedDraftAnswer | null) {
    if (blocked) return;
    if (!answer || !validFocusedDraftAnswer(answer)) {
      setPreview(null);
      setError("Confira somente o campo solicitado antes de guardar.");
      control.current?.focus();
      return;
    }
    setError(null);
    setPreview({ answer, stamp, text });
  }

  useEffect(() => {
    if (
      !voiceCapture ||
      handledVoice.current === voiceCapture.id ||
      voiceCapture.questionId !== question.id ||
      voiceCapture.revision !== revision ||
      voiceCapture.text !== text ||
      blocked ||
      "subject" in question
    )
      return;
    handledVoice.current = voiceCapture.id;
    const answer = deterministicVoiceAnswer(question.field, voiceCapture.text);
    if (answer && validFocusedDraftAnswer(answer)) {
      setError(null);
      setPreview({ answer, stamp, text });
      return;
    }
    const guidance = "Confira este campo manualmente; nada foi enviado.";
    setPreview(null);
    setError(guidance);
    onVoiceGuidance?.(guidance);
    control.current?.focus();
  }, [blocked, onVoiceGuidance, question, stamp, text, voiceCapture]);

  function unknownAnswer(): FocusedDraftAnswer | null {
    if ("subject" in question) return null;
    switch (question.field) {
      case "amountCents":
      case "installmentCount":
      case "dataCompra":
      case "firstDueDate":
      case "tipoDespesa":
      case "categoriaMaoDeObra":
        return { field: question.field, value: null } as FocusedDraftAnswer;
      default:
        return null;
    }
  }

  function previewLabel(answer: FocusedDraftAnswer): string {
    switch (answer.field) {
      case "amountMeaning":
        return answer.value === ImportSessionAmountMeaning.TOTAL_PURCHASE
          ? "Total da compra"
          : "Valor da parcela";
      case "amountCents":
        return answer.value === null
          ? "Não sei informar"
          : moneyDetail(answer.value);
      case "installmentCount":
        return answer.value === null
          ? "Não sei informar"
          : `${answer.value} parcelas`;
      case "dataCompra":
      case "firstDueDate":
        return answer.value === null
          ? "Não sei informar"
          : (formatDateOnly(answer.value) ?? "Data inválida");
      case "tipoDespesa":
        return answer.value === null
          ? "Não sei informar"
          : tipoLabel(answer.value);
      case "categoriaMaoDeObra":
        return answer.value === null
          ? "Não sei informar"
          : catMaoLabel(answer.value);
      case "decision":
        if (answer.value.kind === "KEEP_EXISTING") {
          const expenseId = answer.value.expenseId;
          return `Manter compra existente: ${
            candidates.find((candidate) => candidate.id === expenseId)
              ?.description ?? expenseId
          }`;
        }
        return answer.value.acceptNaturalDuplicate
          ? "Criar outra compra e confirmar que são compras distintas"
          : "Criar nova compra";
      case "targets":
        if (!answer.value.length)
          return "Sem rateio — manter no projeto proprietário";
        return `${selectedProject?.name ?? answer.value[0].projectId}${
          roomId
            ? ` · ${
                selectedProject?.rooms.find((room) => room.id === roomId)
                  ?.name ?? roomId
              }`
            : ""
        } · ${moneyDetail(answer.value[0].amountCents)}`;
    }
  }

  function renderControl() {
    if ("subject" in question) return null;
    const describedBy = `${id}-hint`;
    const common =
      "block min-h-11 w-full min-w-0 rounded-xl border border-darc-linen bg-white px-3 text-base text-darc-velvet focus-visible:outline focus-visible:outline-2 focus-visible:outline-darc-red";
    switch (question.field) {
      case "amountCents":
        return (
          <input
            ref={control as React.RefObject<HTMLInputElement>}
            id={`${id}-input`}
            type="text"
            inputMode="decimal"
            placeholder="R$ 100,00"
            value={text}
            onChange={(event) => change(event.currentTarget.value)}
            disabled={blocked}
            aria-describedby={describedBy}
            className={common}
          />
        );
      case "installmentCount":
        return (
          <input
            ref={control as React.RefObject<HTMLInputElement>}
            id={`${id}-input`}
            type="number"
            inputMode="numeric"
            min={1}
            max={IMPORT_SESSION_LIMITS.installmentsPerPurchase}
            step={1}
            value={text}
            onChange={(event) => change(event.currentTarget.value)}
            disabled={blocked}
            aria-describedby={describedBy}
            className={common}
          />
        );
      case "dataCompra":
      case "firstDueDate":
        return (
          <input
            ref={control as React.RefObject<HTMLInputElement>}
            id={`${id}-input`}
            type="date"
            min={`${IMPORT_SESSION_PRIMITIVES.minYear}-01-01`}
            max={`${IMPORT_SESSION_PRIMITIVES.maxYear}-12-31`}
            value={text}
            onChange={(event) => change(event.currentTarget.value)}
            disabled={blocked}
            aria-describedby={describedBy}
            className={common}
          />
        );
      case "amountMeaning":
        return (
          <fieldset
            disabled={blocked}
            aria-describedby={describedBy}
            className="space-y-2"
          >
            <legend className="sr-only">
              {FOCUSED_DRAFT_LABEL.amountMeaning}
            </legend>
            {MEANING_OPTIONS.map((option, index) => (
              <label
                key={option.value}
                htmlFor={`${id}-meaning-${index}`}
                className="flex min-h-11 items-center gap-3 rounded-xl border border-darc-linen p-3"
              >
                <input
                  ref={
                    index === 0
                      ? (control as React.RefObject<HTMLInputElement>)
                      : undefined
                  }
                  id={`${id}-meaning-${index}`}
                  type="radio"
                  name={`${id}-meaning`}
                  value={option.value}
                  checked={text === option.value}
                  onChange={(event) => change(event.currentTarget.value)}
                  className="h-5 w-5 shrink-0"
                />
                {option.label}
              </label>
            ))}
          </fieldset>
        );
      case "tipoDespesa":
      case "categoriaMaoDeObra": {
        const options =
          question.field === "tipoDespesa"
            ? expenseOptions
            : CATEGORIA_MAO_DE_OBRA_OPTIONS;
        return (
          <select
            ref={control as React.RefObject<HTMLSelectElement>}
            id={`${id}-input`}
            value={text}
            onChange={(event) => change(event.currentTarget.value)}
            disabled={blocked}
            aria-describedby={describedBy}
            className={common}
          >
            <option value="">
              {question.field === "tipoDespesa"
                ? "Escolha o tipo de despesa"
                : "Escolha a categoria de mão de obra"}
            </option>
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        );
      }
      case "decision": {
        if (decisionRecovery)
          return (
            <p role="alert" className="text-sm text-darc-red">
              Não há uma decisão segura disponível para este conflito. Revise a
              compra manualmente; nada foi enviado.
            </p>
          );
        return (
          <fieldset
            disabled={blocked}
            aria-describedby={describedBy}
            className="space-y-2"
          >
            <legend className="sr-only">{FOCUSED_DRAFT_LABEL.decision}</legend>
            {decisionChoices.map((choice, index) => (
              <label
                key={choice.value}
                htmlFor={`${id}-decision-${index}`}
                data-testid={`decision-choice-label-${choice.value}`}
                className="flex min-h-11 min-w-0 items-center gap-3 rounded-xl border border-darc-linen p-3"
              >
                <input
                  ref={
                    index === 0
                      ? (control as React.RefObject<HTMLInputElement>)
                      : undefined
                  }
                  id={`${id}-decision-${index}`}
                  type="radio"
                  name={`${id}-decision`}
                  value={choice.value}
                  checked={text === choice.value}
                  onChange={(event) => change(event.currentTarget.value)}
                  className="h-5 w-5 shrink-0"
                />
                <span className="min-w-0 break-words">{choice.label}</span>
              </label>
            ))}
          </fieldset>
        );
      }
      case "targets":
        return (
          <fieldset
            disabled={blocked}
            aria-describedby={describedBy}
            className="min-w-0 space-y-3"
          >
            <legend className="sr-only">{FOCUSED_DRAFT_LABEL.targets}</legend>
            {[
              {
                value: TARGET_NONE,
                label: "Sem rateio — manter no projeto proprietário",
              },
              {
                value: TARGET_INTEGRAL,
                label: "Enviar o valor integral para outro projeto",
              },
            ].map((choice, index) => (
              <label
                key={choice.value}
                htmlFor={`${id}-target-${index}`}
                className="flex min-h-11 min-w-0 items-center gap-3 rounded-xl border border-darc-linen p-3"
              >
                <input
                  ref={
                    index === 0
                      ? (control as React.RefObject<HTMLInputElement>)
                      : undefined
                  }
                  id={`${id}-target-${index}`}
                  type="radio"
                  name={`${id}-targets`}
                  value={choice.value}
                  checked={text === choice.value}
                  onChange={(event) => change(event.currentTarget.value)}
                  className="h-5 w-5 shrink-0"
                />
                <span className="min-w-0 break-words">{choice.label}</span>
              </label>
            ))}
            {text === TARGET_INTEGRAL && (
              <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                <label className="min-w-0 text-sm">
                  Projeto de destino
                  <select
                    value={projectId}
                    onChange={(event) => {
                      setProjectId(event.currentTarget.value);
                      setRoomId("");
                      setPreview(null);
                    }}
                    className={`${common} mt-1`}
                  >
                    <option value="">Escolha o projeto</option>
                    {eligibleTargetProjects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="min-w-0 text-sm">
                  Cômodo (opcional)
                  <select
                    value={roomId}
                    disabled={!selectedProject}
                    onChange={(event) => {
                      setRoomId(event.currentTarget.value);
                      setPreview(null);
                    }}
                    className={`${common} mt-1`}
                  >
                    <option value="">Sem cômodo</option>
                    {selectedProject?.rooms.map((room) => (
                      <option key={room.id} value={room.id}>
                        {room.name}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="min-w-0 text-sm sm:col-span-2">
                  Valor integral:{" "}
                  <span data-workflow-money className={journeyStyles.money}>
                    {targetAmount === null
                      ? "Valor indisponível"
                      : moneyDetail(targetAmount)}
                  </span>
                </p>
              </div>
            )}
          </fieldset>
        );
    }
  }

  if ("subject" in question) return null;
  const label = FOCUSED_DRAFT_LABEL[question.field];
  return (
    <form
      aria-labelledby={`${id}-question`}
      aria-busy={pending}
      className={`${journeyStyles.journey} min-w-0 space-y-3 rounded-xl border border-darc-linen bg-white p-4`}
      onSubmit={(event) => {
        event.preventDefault();
        check(answerForCurrentValue());
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
                {formatImportPurchaseContext(line)}
              </li>
            ),
        )}
      </ul>
      {!["amountMeaning", "decision", "targets"].includes(question.field) && (
        <label htmlFor={`${id}-input`} className="block text-sm font-medium">
          {label}
        </label>
      )}
      {renderControl()}
      <p id={`${id}-hint`} className="text-sm text-gray-600">
        Confira antes de guardar. Este campo atualiza somente o rascunho; não
        confirma lançamentos.
      </p>
      {voiceCapture?.text === text && text.trim() && (
        <div className="min-w-0 space-y-1 text-sm">
          <p className="font-medium">Transcrição preservada</p>
          <p className="break-words">{text}</p>
        </div>
      )}
      {!complete && !decisionRecovery && (
        <p role="alert" className="text-sm text-darc-red">
          {optionsError ??
            (optionsPending
              ? "Consultando opções autorizadas…"
              : "A pergunta e a compra completas são necessárias para responder.")}
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
          className="min-w-0 space-y-2 rounded-xl bg-lifeone-surface p-3 text-sm"
        >
          <p>{label}</p>
          <p
            className={
              currentPreview.answer.field === "amountCents" ||
              currentPreview.answer.field === "targets"
                ? journeyStyles.money
                : "break-words"
            }
          >
            {previewLabel(currentPreview.answer)}
          </p>
          <p>Esta prévia ainda não foi enviada.</p>
        </div>
      )}
      <div
        data-import-question-actions
        className="flex min-w-0 flex-wrap gap-2"
      >
        <Button type="submit" className="min-h-11" disabled={blocked || !text}>
          Conferir informação
        </Button>
        {unknownAnswer() && (
          <Button
            type="button"
            className="min-h-11"
            disabled={blocked}
            onClick={() => {
              onTextChange?.(text);
              check(unknownAnswer());
            }}
          >
            Não sei informar
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
