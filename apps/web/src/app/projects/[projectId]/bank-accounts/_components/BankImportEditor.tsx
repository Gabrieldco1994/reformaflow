"use client";

import {
  hasFeature,
  isNeutralExpenseType,
  type ProjectType,
} from "@reformaflow/domain";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import { CATEGORIA_MAO_DE_OBRA_OPTIONS } from "@/lib/expense-options";
import { getExpenseOptions } from "../../expenses/_types";
import type { BankPreviewResult, BankPreviewTx } from "../_types";
import type { BankTxState } from "./ImportBankStatementModal";
import { BankPreviewTxRow } from "./BankPreviewTxRow";

export interface ImportNewTarget {
  targetProjectId: string;
  tipoDespesa: string;
  titulo?: string;
  fornecedor?: string;
  categoriaMaoDeObra?: string;
  roomId?: string;
}

export function canPrepareTarget(tx: BankPreviewTx, state: BankTxState) {
  const category = state.decision?.overrides?.category ?? tx.suggestedCategory;
  return (
    tx.inlineTargetEligible === true &&
    tx.amountCents > 0 &&
    !tx.duplicate &&
    !tx.possibleDuplicate &&
    !tx.isCardPayment &&
    state.decision?.action !== "skip" &&
    !isNeutralExpenseType(category) &&
    category !== "INVESTIMENTOS" &&
    (state.decision?.overrides?.valorCents ?? tx.amountCents) > 0
  );
}

export function validTargetDraft(
  tx: BankPreviewTx,
  state: BankTxState,
  projects: BankPreviewResult["inlineTargetProjects"],
) {
  const target = state.decision?.newTarget;
  if (!target) return true;
  const project = projects?.find((p) => p.id === target.targetProjectId);
  return (
    canPrepareTarget(tx, state) &&
    !!project &&
    hasFeature(project.type as ProjectType, "expenses") &&
    getExpenseOptions(project.type).some(
      (option) => option.value === target.tipoDespesa,
    ) &&
    state.targetReviewedAmount ===
      (state.decision?.overrides?.valorCents ?? tx.amountCents)
  );
}

export function BankImportEditor({
  tx,
  state,
  projects,
  onChange,
  onRestore,
}: {
  tx: BankPreviewTx;
  state: BankTxState;
  projects: BankPreviewResult["inlineTargetProjects"];
  onChange: (state: BankTxState) => void;
  onRestore: () => void;
}) {
  const target = state.decision?.newTarget;
  const amount =
    state.decision?.overrides?.valorCents ?? Math.abs(tx.amountCents);
  const eligible = canPrepareTarget(tx, state);
  const targetProject = projects?.find(
    (project) => project.id === target?.targetProjectId,
  );
  function updateTarget(patch: Partial<ImportNewTarget>) {
    onChange({
      ...state,
      decision: {
        ...state.decision,
        externalId: tx.externalId,
        action: "create",
        linkToExpenseId: undefined,
        linkToReceiptId: undefined,
        newTarget: {
          targetProjectId: "",
          tipoDespesa: "",
          ...target,
          ...patch,
        },
      },
    });
  }
  return (
    <div className="space-y-4">
      <BankPreviewTxRow
        tx={tx}
        state={state}
        onChange={(patch) => onChange({ ...state, ...patch })}
        onClearDecision={onRestore}
      />
      <Button variant="ghost" onClick={onRestore}>
        Restaurar dados originais e sugestões
      </Button>
      {!tx.duplicate && !tx.possibleDuplicate && (
        <section className="space-y-3 rounded-lg border border-darc-linen p-3">
          <h4 className="font-medium text-darc-velvet">
            Finalidade deste lançamento
          </h4>
          <Button
            variant="ghost"
            onClick={() =>
              onChange({
                ...state,
                decision: {
                  externalId: tx.externalId,
                  action: "create",
                  overrides: state.decision?.overrides,
                },
                targetReviewedAmount: undefined,
              })
            }
          >
            Manter na origem, sem vínculo
          </Button>
          {!!projects?.length && !target && eligible && (
            <Button
              variant="secondary"
              onClick={() =>
                onChange({
                  ...state,
                  targetReviewedAmount: amount,
                  decision: {
                    externalId: tx.externalId,
                    action: "create",
                    overrides: state.decision?.overrides,
                    newTarget: { targetProjectId: "", tipoDespesa: "" },
                  },
                })
              }
            >
              Criar em outro projeto
            </Button>
          )}
          {target && (
            <fieldset className="space-y-3" disabled={!eligible}>
              <legend className="text-sm text-gray-600">
                Novo destino · rascunho, criado somente ao confirmar o lote
              </legend>
              <p className="text-sm">
                Valor integral no destino:{" "}
                <strong>{formatCurrency(amount / 100)}</strong>. Uma única saída
                na conta de origem.
              </p>
              <label className="block text-sm">
                Projeto destino
                <select
                  className="w-full border rounded-lg px-3"
                  value={target.targetProjectId}
                  onChange={(event) =>
                    updateTarget({
                      targetProjectId: event.target.value,
                      tipoDespesa: "",
                      categoriaMaoDeObra: undefined,
                      roomId: undefined,
                    })
                  }
                >
                  <option value="">Escolha o projeto</option>
                  {projects?.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                Categoria no destino
                <select
                  className="w-full border rounded-lg px-3"
                  value={target.tipoDespesa}
                  disabled={!targetProject}
                  onChange={(event) =>
                    updateTarget({
                      tipoDespesa: event.target.value,
                      categoriaMaoDeObra: undefined,
                    })
                  }
                >
                  <option value="">Escolha a categoria</option>
                  {(targetProject
                    ? getExpenseOptions(targetProject.type)
                    : []
                  ).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              {target.tipoDespesa === "MAO_DE_OBRA" && (
                <label className="block text-sm">
                  Categoria de mão de obra
                  <select
                    className="w-full border rounded-lg px-3"
                    value={target.categoriaMaoDeObra ?? ""}
                    onChange={(event) =>
                      updateTarget({
                        categoriaMaoDeObra: event.target.value || undefined,
                      })
                    }
                  >
                    <option value="">Sem categoria</option>
                    {CATEGORIA_MAO_DE_OBRA_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="block text-sm">
                Título no destino (opcional)
                <input
                  className="w-full border rounded-lg px-3"
                  value={target.titulo ?? ""}
                  onChange={(event) =>
                    updateTarget({ titulo: event.target.value || undefined })
                  }
                />
              </label>
              <label className="block text-sm">
                Fornecedor (opcional)
                <input
                  className="w-full border rounded-lg px-3"
                  value={target.fornecedor ?? ""}
                  onChange={(event) =>
                    updateTarget({
                      fornecedor: event.target.value || undefined,
                    })
                  }
                />
              </label>
            </fieldset>
          )}
          {target && !eligible && (
            <p role="alert" className="text-sm text-red-700">
              Esta linha não permite criar destino. Mantenha na origem ou
              restaure a classificação antes de continuar.
            </p>
          )}
          {target && eligible && state.targetReviewedAmount !== amount && (
            <div role="alert" className="text-sm text-amber-800">
              <p>
                O valor da origem mudou. Confira novamente o valor integral do
                destino.
              </p>
              <Button
                variant="secondary"
                onClick={() =>
                  onChange({ ...state, targetReviewedAmount: amount })
                }
              >
                Conferi o destino de {formatCurrency(amount / 100)}
              </Button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
