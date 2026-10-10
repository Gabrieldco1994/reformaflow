import { createHash } from "node:crypto";
import type {
  ImportCurrentLotV1,
  ImportSessionConfirmationHash,
  ImportSessionFullPlanDigest,
  ImportSessionProposalV1,
} from "@reformaflow/domain";
import { canonical } from "../../common/canonical";

const CONFIRMATION_PURPOSE = "CONFIRM_CARD_PURCHASE_IMPORT" as const;

const sha256 = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");

/**
 * Hash only what the user can see and approve. Operational state, identifiers,
 * continuation work and private plan metadata are deliberately absent.
 */
export function confirmationHashOf(
  lot: Pick<
    ImportCurrentLotV1,
    | "purchases"
    | "createdEconomicTotalCents"
    | "bankCashDeltaCents"
    | "invoiceDeltas"
  >,
): ImportSessionConfirmationHash {
  return sha256({
    purpose: CONFIRMATION_PURPOSE,
    purchases: lot.purchases.map((purchase) => ({
      title: purchase.title,
      merchant: purchase.merchant,
      purchaseDate: purchase.purchaseDate,
      totalCents: purchase.totalCents,
      installmentIndex: purchase.installmentIndex,
      installmentCount: purchase.installmentCount,
      schedule: purchase.schedule,
      targets: purchase.targets.map((target) => ({
        projectLabel: target.projectLabel,
        roomLabel: target.roomLabel,
        amountCents: target.amountCents,
        schedule: target.schedule,
      })),
      disposition: purchase.disposition,
    })),
    createdEconomicTotalCents: lot.createdEconomicTotalCents,
    bankCashDeltaCents: lot.bankCashDeltaCents,
    invoiceDeltas: lot.invoiceDeltas,
  });
}

/** Recomputable digest of the complete stored executable proposal. */
export function fullPlanDigestOf(
  proposal: ImportSessionProposalV1,
  continuation: unknown,
  declarations?: unknown,
): ImportSessionFullPlanDigest {
  const { proposalHash: _legacyKey, ...fullPlan } = proposal;
  return sha256({
    proposal: fullPlan,
    continuation,
    ...(declarations === undefined ? {} : { declarations }),
  });
}
