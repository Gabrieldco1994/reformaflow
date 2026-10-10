import {
  IMPORT_SESSION_PROTOCOL_VERSION,
  type ImportCurrentLotV1,
  type ImportSessionProposalV1,
  type ImportSessionStoredDraftV1,
} from "@reformaflow/domain";
import { confirmationHashOf } from "./import-confirmation-binding";

const RESUMABLE_NO_WRITE_OUTCOME: NonNullable<
  ImportSessionProposalV1["noWriteRows"]
>[number]["outcome"] = "DEFERRED";

export interface CurrentLotDisplayContext {
  readonly title: string;
  readonly merchant: string | null;
  readonly purchaseDate: string;
  readonly installmentIndex: number | null;
  readonly installmentCount: number | null;
}

export interface CurrentLotLabels {
  readonly projects: ReadonlyMap<string, string>;
  readonly rooms: ReadonlyMap<string, string>;
  readonly lines?: ReadonlyMap<string, CurrentLotDisplayContext>;
}

const emptyLabels = (): CurrentLotLabels => ({
  projects: new Map(),
  rooms: new Map(),
});

/** Only sealed work that can move into a continuation keeps the lot pending. */
export function hasResumableProposalWork(
  proposal: ImportSessionProposalV1,
): boolean {
  return (
    proposal.deferredObservationIds.length > 0 ||
    proposal.deferredAttachmentIds.length > 0 ||
    (proposal.noWriteRows?.some(
      (row) => row.outcome === RESUMABLE_NO_WRITE_OUTCOME,
    ) ??
      false)
  );
}

/**
 * Ready-only allowlist. Hidden/no-write scope is reduced to one boolean before projection;
 * no hidden identifier, amount, count or subtractable total crosses this boundary.
 */
export function projectCurrentLot(
  state: "READY" | "CONFIRMED",
  proposal: ImportSessionProposalV1,
  draft: ImportSessionStoredDraftV1,
  labels: CurrentLotLabels | ReadonlyMap<string, unknown> = emptyLabels(),
): ImportCurrentLotV1 {
  const context: CurrentLotLabels =
    labels instanceof Map ? emptyLabels() : (labels as CurrentLotLabels);
  const lines = new Map(draft.lines.map((line) => [line.id, line]));
  const purchases = proposal.lines.map((planned) => {
    const source = lines.get(planned.lineId);
    const display = context.lines?.get(planned.lineId);
    if (planned.kind === "CREATE") {
      return {
        title: planned.titulo,
        merchant: planned.fornecedor,
        purchaseDate: planned.dataCompra,
        totalCents: planned.totalCents,
        installmentIndex: display?.installmentIndex ?? null,
        installmentCount: source?.installmentCount ?? null,
        schedule: planned.schedule,
        targets: planned.targets.map((target) => ({
          projectLabel:
            context.projects.get(target.projectId) ?? "Projeto autorizado",
          roomLabel:
            target.roomId === null
              ? null
              : (context.rooms.get(target.roomId) ?? "Ambiente autorizado"),
          amountCents: target.amountCents,
          schedule: target.schedule,
        })),
        disposition: "CREATE" as const,
      };
    }
    if (!display) throw new Error("Missing server purchase display context");
    return {
      title: display.title,
      merchant: display.merchant,
      purchaseDate: display.purchaseDate,
      totalCents: planned.totalCents,
      installmentIndex: display.installmentIndex,
      installmentCount: display.installmentCount,
      schedule: planned.schedule,
      targets: [],
      disposition: "KEEP_EXISTING" as const,
    };
  });
  const hasRemainingWork = hasResumableProposalWork(proposal);
  const visible = {
    purchases,
    createdEconomicTotalCents: proposal.createdEconomicTotalCents,
    bankCashDeltaCents: 0 as const,
    invoiceDeltas: proposal.invoiceDeltas.map((delta) => ({ ...delta })),
  };
  return {
    version: IMPORT_SESSION_PROTOCOL_VERSION,
    state: state === "READY" && hasRemainingWork ? "READY_WITH_PENDING" : state,
    revision: proposal.revision,
    confirmationHash: confirmationHashOf(visible),
    ...visible,
    hasRemainingWork,
    actions: state === "READY" ? ["CONFIRM"] : ["EXECUTE"],
  };
}
