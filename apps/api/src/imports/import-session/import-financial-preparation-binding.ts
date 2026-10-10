import type {
  ImportSessionDraftFieldProvenanceV1,
  ImportSessionStoredDraftV1,
  ImportStoredDeclarationV1,
} from "@reformaflow/domain";
import { ImportSessionCorruptStateError } from "./import-session.errors";

type DraftLine = ImportSessionStoredDraftV1["lines"][number];

export interface ImportFinancialPreparationBindingV1 {
  readonly version: 1;
  readonly selectedLineIds: readonly string[];
  readonly selectedLines: readonly Readonly<
    Pick<
      DraftLine,
      | "id"
      | "observationIds"
      | "titulo"
      | "fornecedor"
      | "tipoDespesa"
      | "categoriaMaoDeObra"
      | "amountMeaning"
      | "amountCents"
      | "installmentCount"
      | "dataCompra"
      | "firstDueDate"
      | "targets"
      | "decision"
    >
  >[];
  readonly scope: {
    readonly observationIds: readonly string[];
    readonly references: readonly {
      readonly refId: string;
      readonly artifactId: string | null;
    }[];
  };
  readonly declarations: readonly Readonly<
    Pick<
      ImportStoredDeclarationV1,
      | "lineId"
      | "observationId"
      | "originalFingerprint"
      | "claimVersion"
      | "field"
      | "value"
      | "meaningContext"
    >
  >[];
  readonly guidedProvenance: readonly Readonly<
    Pick<ImportSessionDraftFieldProvenanceV1, "origin" | "lineId" | "field">
  >[];
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const compare = (
  left: { lineId: string; field: string; observationId?: string },
  right: { lineId: string; field: string; observationId?: string },
): number =>
  left.lineId.localeCompare(right.lineId) ||
  (left.observationId ?? "").localeCompare(right.observationId ?? "") ||
  left.field.localeCompare(right.field);

/**
 * Captures only immutable semantics that can alter financial preparation.
 * Request receipts, interpretation ledgers and their operational metadata are
 * intentionally absent; proposal/full-plan bindings remain separate.
 */
export function financialPreparationBindingOf(
  draft: ImportSessionStoredDraftV1,
  references: readonly { id: string; artifactId: string | null }[],
): ImportFinancialPreparationBindingV1 {
  const selected = new Set(draft.selectedLineIds);
  const binding: ImportFinancialPreparationBindingV1 = {
    version: 1,
    selectedLineIds: [...draft.selectedLineIds],
    selectedLines: draft.selectedLineIds.map((lineId) => {
      const line = draft.lines.find((candidate) => candidate.id === lineId);
      if (!line) throw new ImportSessionCorruptStateError("preparation");
      return {
        id: line.id,
        observationIds: [...line.observationIds],
        titulo: line.titulo,
        fornecedor: line.fornecedor,
        tipoDespesa: line.tipoDespesa,
        categoriaMaoDeObra: line.categoriaMaoDeObra,
        amountMeaning: line.amountMeaning,
        amountCents: line.amountCents,
        installmentCount: line.installmentCount,
        dataCompra: line.dataCompra,
        firstDueDate: line.firstDueDate,
        targets:
          line.targets === null
            ? null
            : line.targets.map((target) => ({ ...target })),
        decision: { ...line.decision },
      };
    }),
    scope: {
      observationIds: [...draft.scope.observationIds].sort(),
      references: references
        .map((reference) => ({
          refId: reference.id,
          artifactId: reference.artifactId,
        }))
        .sort((left, right) => left.refId.localeCompare(right.refId)),
    },
    declarations: (draft.declarations?.items ?? [])
      .map((item) => ({
        lineId: item.lineId,
        observationId: item.observationId,
        originalFingerprint: item.originalFingerprint,
        claimVersion: item.claimVersion,
        field: item.field,
        value: item.value,
        meaningContext: item.meaningContext,
      }))
      .sort(compare),
    guidedProvenance: (draft.fieldProvenance ?? [])
      .filter((item) => selected.has(item.lineId))
      .map((item) => ({
        origin: item.origin,
        lineId: item.lineId,
        field: item.field,
      }))
      .sort(compare),
  };
  return freeze(binding);
}
