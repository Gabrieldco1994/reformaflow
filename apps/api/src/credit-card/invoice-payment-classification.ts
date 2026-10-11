import { CARD_IMPORT_IGNORED_REASON } from "@reformaflow/domain";

/** Documentary description only — never a user-editable draft title. */
export const INVOICE_PAYMENT_LINE_PATTERN =
  /\b(?:PAGAMENTO\s+EFETUADO|PAGAMENTO\s+PIX|PAGAMENTO\s+DE\s+FATURA|PGTO\s+FAT|FATURA\s+PAGA)\b/i;

export function invoicePaymentIgnoredReason(
  description: string | null,
): typeof CARD_IMPORT_IGNORED_REASON.INVOICE_PAYMENT | null {
  return description !== null && INVOICE_PAYMENT_LINE_PATTERN.test(description)
    ? CARD_IMPORT_IGNORED_REASON.INVOICE_PAYMENT
    : null;
}
