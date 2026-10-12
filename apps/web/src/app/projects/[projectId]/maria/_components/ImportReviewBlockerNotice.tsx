"use client";

import { useEffect, useId, useRef } from "react";
import type {
  ImportSessionViewV1,
  ImportDeclaredFactViewV1,
} from "@reformaflow/domain";
import {
  declarationFieldLabel,
  declarationValueLabel,
} from "./ImportFocusedQuestion";
import {
  formatImportPurchaseContext,
  type ImportPurchaseContextLine,
} from "./ImportFocusedDraftQuestion";
import journeyStyles from "@/components/import/ImportJourney.module.css";

const FACT_LABEL: Record<ImportDeclaredFactViewV1["status"], string> = {
  CURRENT: "Informado por você",
  UNKNOWN: "Informado por você",
  CONTEXT_CHANGED: "Informação anterior",
};

export function ImportDeclaredFacts({
  line,
  lineId,
  facts,
}: {
  line?: ImportPurchaseContextLine;
  lineId?: string;
  facts: readonly ImportDeclaredFactViewV1[];
}) {
  const matchingLineId = line?.id ?? lineId;
  if (!matchingLineId) return null;
  const purchaseContext = line ? formatImportPurchaseContext(line) : "Compra";
  return facts
    .filter((fact) => fact.lineId === matchingLineId)
    .map((fact) => (
      <div
        key={`${fact.questionId}:${fact.field}:${fact.meaningContext}`}
        role="group"
        aria-label={`${declarationFieldLabel(fact)} · ${purchaseContext}`}
        className="min-w-0 space-y-1 rounded-xl bg-lifeone-surface p-3 text-sm"
      >
        <p>
          {declarationFieldLabel(fact)} · {purchaseContext}
        </p>
        <p>{FACT_LABEL[fact.status]}</p>
        <p className="break-words">
          <span
            data-workflow-money={
              fact.field === "amountCents" && fact.value !== null
                ? true
                : undefined
            }
            className={
              fact.field === "amountCents" && fact.value !== null
                ? journeyStyles.money
                : undefined
            }
          >
            {declarationValueLabel(fact)}
          </span>
          {fact.status === "CONTEXT_CHANGED"
            ? ` · ${declarationFieldLabel(fact).toLocaleLowerCase("pt-BR")}`
            : ""}
        </p>
        <p>No documento: não identificado</p>
        <p>Isso não altera o documento original.</p>
        {fact.status === "CONTEXT_CHANGED" && (
          <p>Informação não utilizada no contexto atual.</p>
        )}
      </div>
    ));
}

const DETAIL: Record<
  ImportSessionViewV1["reviewBlockers"][number]["code"],
  string
> = {
  ORIGINAL_IDENTITY_INCOMPLETE:
    "Faltam dados originais necessários à identificação da compra.",
  ORIGINAL_OCCURRENCE_INCOMPLETE:
    "Faltam dados originais necessários à correspondência desta cobrança com a compra ou parcela.",
};

export function ImportReviewBlockerNotice({
  line,
  blockers,
  selected,
  showLine = false,
  onInclude,
  onRemove,
  pending = false,
  hasQuestion = false,
}: {
  line: ImportPurchaseContextLine;
  blockers: ImportSessionViewV1["reviewBlockers"];
  selected: boolean;
  showLine?: boolean;
  onInclude?: (lineId: string) => void;
  onRemove?: (lineId: string) => void;
  pending?: boolean;
  hasQuestion?: boolean;
}) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const wasSelected = useRef(selected);
  const codes = [
    ...new Set(
      blockers
        .filter(
          (b) => b.lineId === line.id && b.resolution !== "RESOLVED_BY_USER",
        )
        .map((b) => b.code),
    ),
  ];
  const needsDeclaration = blockers.some(
    (blocker) =>
      blocker.lineId === line.id && blocker.resolution === "NEEDS_DECLARATION",
  );
  const visible = codes.length > 0;
  useEffect(() => {
    if (visible && wasSelected.current && !selected) heading.current?.focus();
    wasSelected.current = selected;
  }, [selected, visible]);
  if (!visible && !showLine && !onInclude && !onRemove) return null;
  const purchaseContext = formatImportPurchaseContext(line);
  return (
    <article
      aria-labelledby={`${id}-line`}
      className="min-w-0 space-y-2 break-words rounded-xl border border-darc-linen bg-lifeone-surface p-3 text-sm text-lifeone-ink"
    >
      <h4 id={`${id}-line`} className="font-semibold">
        {purchaseContext}
      </h4>
      {visible && (
        <>
          <h5
            ref={heading}
            id={`${id}-blocker`}
            tabIndex={-1}
            className="font-semibold focus-visible:outline focus-visible:outline-2"
          >
            Verificação documental pendente
          </h5>
          <p>
            {needsDeclaration
              ? "Informe os dados ausentes na pergunta desta compra e confira antes de guardar. A informação guardada não altera o documento original."
              : "O documento não contém informações suficientes para verificar esta compra com segurança. Corrigir o rascunho, por si só, não resolve esta pendência no fluxo atual."}
          </p>
          {codes.map((code) => (
            <p key={code}>{DETAIL[code]}</p>
          ))}
          <p>
            {selected
              ? "Esta seleção contém uma compra com verificação pendente. Retire-a da seleção para preparar as demais."
              : "Fora deste lote · verificação pendente"}
          </p>
          {hasQuestion && (
            <p>
              Esta resposta atualiza o rascunho; a verificação documental
              continua pendente.
            </p>
          )}
        </>
      )}
      {!visible && (
        <p>{selected ? "Selecionada para revisão." : "Fora da seleção."}</p>
      )}
      {!visible && onInclude && (
        <p>Incluir escolhe o que será revisado; nada será lançado ainda.</p>
      )}
      {selected && onRemove && (
        <button
          type="button"
          disabled={pending}
          aria-label={`Retirar compra ${purchaseContext} da seleção`}
          onClick={() => onRemove(line.id)}
          className="min-h-11 rounded-xl border px-3 focus-visible:outline focus-visible:outline-2"
        >
          Retirar da seleção
        </button>
      )}
      {!selected && onInclude && (
        <button
          type="button"
          disabled={pending}
          aria-label={`Incluir compra ${purchaseContext} na revisão`}
          onClick={() => onInclude(line.id)}
          className="min-h-11 rounded-xl border px-3 focus-visible:outline focus-visible:outline-2"
        >
          Incluir na revisão
        </button>
      )}
    </article>
  );
}
