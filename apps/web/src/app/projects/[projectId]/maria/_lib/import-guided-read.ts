import {
  IMPORT_SESSION_LIMITS as L,
  IMPORT_SESSION_PRIMITIVES as P,
  isInvoiceDueMonth,
  parseExpenseSchedule,
  parseInstallmentDateOnlyUtc,
  type ImportCurrentLotV1,
  type ImportDocumentaryCommandReceiptV1,
  type ImportInterpretationResultV1,
  type ImportTypedGuidedAnswerV1,
} from "@reformaflow/domain";
import {
  hasExactImportKeys,
  isImportRequestId,
  isImportRevision,
} from "./import-session-workflow-read";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const matches = (value: unknown, pattern: string): value is string =>
  typeof value === "string" && new RegExp(pattern).test(value);
const text = (
  value: unknown,
  maximum: number = P.maxTitleLength,
): value is string =>
  typeof value === "string" &&
  value.normalize("NFC") === value &&
  value.length > 0 &&
  value.length <= maximum;
const integer = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= minimum &&
  value <= P.maxCents;
const cents = (value: unknown): value is number => integer(value, P.minCents);
const date = (value: unknown): value is string =>
  typeof value === "string" && parseInstallmentDateOnlyUtc(value) !== null;

function schedule(value: unknown, totalCents: number): boolean {
  try {
    const parsed = parseExpenseSchedule(value);
    return (
      parsed.occurrences.length <= L.installmentsPerPurchase &&
      parsed.occurrences.every(
        (item) =>
          cents(item.valor) &&
          date(item.data) &&
          (item.invoiceDueMonth === null ||
            isInvoiceDueMonth(item.invoiceDueMonth)),
      ) &&
      parsed.occurrences.reduce((sum, item) => sum + item.valor, 0) ===
        totalCents
    );
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

function typedAnswer(value: unknown): value is ImportTypedGuidedAnswerV1 {
  if (!record(value) || typeof value.kind !== "string") return false;
  if (value.kind === "UNKNOWN" || value.kind === "REMOVE")
    return hasExactImportKeys(value, ["kind"]);
  return (
    value.kind === "KNOWN" &&
    hasExactImportKeys(value, ["kind", "value"]) &&
    ((typeof value.value === "string" && value.value.length > 0) ||
      Number.isSafeInteger(value.value))
  );
}

export function readDocumentaryCommandReceipt(
  value: unknown,
  expectedRequestId: string,
  expectedOperation: ImportDocumentaryCommandReceiptV1["operation"],
): ImportDocumentaryCommandReceiptV1 {
  if (
    !record(value) ||
    !hasExactImportKeys(value, [
      "version",
      "requestId",
      "operation",
      "outcome",
      "revision",
    ]) ||
    value.version !== 1 ||
    value.requestId !== expectedRequestId ||
    !isImportRequestId(value.requestId) ||
    value.operation !== expectedOperation ||
    !["APPLIED", "NO_CHANGE", "NEEDS_INPUT", "CURRENT_LOT_READY"].includes(
      String(value.outcome),
    ) ||
    !isImportRevision(value.revision)
  )
    throw new Error("Unexpected import command response");
  return value as unknown as ImportDocumentaryCommandReceiptV1;
}

export function readContinueAnsweringReceipt(
  value: unknown,
  expectedRequestId: string,
) {
  const receipt = readDocumentaryCommandReceipt(
    value,
    expectedRequestId,
    "CONTINUE_ANSWERING",
  );
  if (receipt.outcome !== "NEEDS_INPUT")
    throw new Error("Unexpected import command response");
  return receipt as ImportDocumentaryCommandReceiptV1 & {
    operation: "CONTINUE_ANSWERING";
    outcome: "NEEDS_INPUT";
  };
}

export function readImportInterpretation(
  value: unknown,
  expectedRequestId: string,
): ImportInterpretationResultV1 {
  if (
    !record(value) ||
    value.version !== 1 ||
    value.requestId !== expectedRequestId ||
    !isImportRequestId(value.requestId) ||
    !["CANDIDATE", "CLARIFY"].includes(String(value.outcome))
  )
    throw new Error("Unexpected import interpretation response");
  if (
    value.outcome === "CLARIFY" &&
    hasExactImportKeys(value, ["version", "requestId", "outcome"])
  )
    return value as unknown as ImportInterpretationResultV1;
  if (
    value.outcome === "CANDIDATE" &&
    hasExactImportKeys(value, [
      "version",
      "requestId",
      "outcome",
      "candidate",
    ]) &&
    typedAnswer(value.candidate)
  )
    return value as unknown as ImportInterpretationResultV1;
  throw new Error("Unexpected import interpretation response");
}

export function readImportCurrentLot(value: unknown): ImportCurrentLotV1 {
  if (
    !record(value) ||
    !hasExactImportKeys(value, [
      "version",
      "state",
      "revision",
      "confirmationHash",
      "purchases",
      "createdEconomicTotalCents",
      "bankCashDeltaCents",
      "invoiceDeltas",
      "hasRemainingWork",
      "actions",
    ]) ||
    value.version !== 1 ||
    !["READY", "READY_WITH_PENDING", "CONFIRMED"].includes(
      String(value.state),
    ) ||
    !isImportRevision(value.revision) ||
    !matches(value.confirmationHash, P.hashPattern) ||
    !Array.isArray(value.purchases) ||
    value.purchases.length > L.selectedLines ||
    !cents(value.createdEconomicTotalCents) ||
    value.bankCashDeltaCents !== 0 ||
    !Array.isArray(value.invoiceDeltas) ||
    typeof value.hasRemainingWork !== "boolean" ||
    !Array.isArray(value.actions) ||
    !value.actions.every(
      (action) => action === "CONFIRM" || action === "EXECUTE",
    ) ||
    new Set(value.actions).size !== value.actions.length ||
    !(
      (value.state === "READY" &&
        value.hasRemainingWork === false &&
        value.actions.length === 1 &&
        value.actions[0] === "CONFIRM") ||
      (value.state === "READY_WITH_PENDING" &&
        value.hasRemainingWork === true &&
        value.actions.length === 1 &&
        value.actions[0] === "CONFIRM") ||
      (value.state === "CONFIRMED" &&
        value.actions.length === 1 &&
        value.actions[0] === "EXECUTE")
    )
  )
    throw new Error("Unexpected current lot response");

  const purchasesValid = value.purchases.every(
    (purchase) =>
      record(purchase) &&
      hasExactImportKeys(purchase, [
        "title",
        "merchant",
        "purchaseDate",
        "totalCents",
        "installmentIndex",
        "installmentCount",
        "schedule",
        "targets",
        "disposition",
      ]) &&
      text(purchase.title, P.maxTitleLength) &&
      (purchase.merchant === null ||
        text(purchase.merchant, P.maxSupplierLength)) &&
      date(purchase.purchaseDate) &&
      cents(purchase.totalCents) &&
      (purchase.installmentIndex === null ||
        integer(purchase.installmentIndex, 1)) &&
      (purchase.installmentCount === null ||
        integer(purchase.installmentCount, 1)) &&
      schedule(purchase.schedule, purchase.totalCents) &&
      Array.isArray(purchase.targets) &&
      purchase.targets.every(
        (target) =>
          record(target) &&
          hasExactImportKeys(target, [
            "projectLabel",
            "roomLabel",
            "amountCents",
            "schedule",
          ]) &&
          text(target.projectLabel, P.maxTitleLength) &&
          (target.roomLabel === null ||
            text(target.roomLabel, P.maxTitleLength)) &&
          cents(target.amountCents) &&
          schedule(target.schedule, target.amountCents),
      ) &&
      (purchase.disposition === "CREATE" ||
        purchase.disposition === "KEEP_EXISTING"),
  );
  const deltasValid = value.invoiceDeltas.every(
    (delta) =>
      record(delta) &&
      hasExactImportKeys(delta, ["invoiceDueMonth", "amountCents"]) &&
      isInvoiceDueMonth(delta.invoiceDueMonth) &&
      cents(delta.amountCents),
  );
  if (!purchasesValid || !deltasValid)
    throw new Error("Unexpected current lot response");
  return value as unknown as ImportCurrentLotV1;
}
