export const CARD_IMPORT_LINE_POLICY_VERSION = 1 as const;

export const CARD_IMPORT_LINE_CLASSIFICATION = {
  PURCHASE: "PURCHASE",
  IGNORE_INVOICE_PAYMENT: "IGNORE_INVOICE_PAYMENT",
  IGNORE_CARD_PAYS_CARD: "IGNORE_CARD_PAYS_CARD",
} as const;
export type CardImportLineClassification =
  (typeof CARD_IMPORT_LINE_CLASSIFICATION)[keyof typeof CARD_IMPORT_LINE_CLASSIFICATION];

export interface CardImportLinePolicyInput {
  documentaryText: string;
  canonicalType?: string | null;
  settlesInvoiceKey?: string | null;
}

const INVOICE_PAYMENT_LINE_PATTERN =
  /PAGAMENTO\s+EFETUADO|PAGAMENTO\s+PIX|PGTO\s+FAT|FATURA\s+PAG|PAGAMENTO\s+CART(?:A|Ã)O/i;

/** Classifies immutable documentary facts before any user-editable projection. */
export function classifyCardImportLine(
  input: CardImportLinePolicyInput,
): CardImportLineClassification {
  if (
    input.canonicalType === "CARD_PAYS_CARD" &&
    typeof input.settlesInvoiceKey === "string" &&
    input.settlesInvoiceKey.length > 0
  )
    return CARD_IMPORT_LINE_CLASSIFICATION.IGNORE_CARD_PAYS_CARD;
  return INVOICE_PAYMENT_LINE_PATTERN.test(input.documentaryText)
    ? CARD_IMPORT_LINE_CLASSIFICATION.IGNORE_INVOICE_PAYMENT
    : CARD_IMPORT_LINE_CLASSIFICATION.PURCHASE;
}
