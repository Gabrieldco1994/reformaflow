import { CARD_IMPORT_IGNORED_REASON } from "@reformaflow/domain";

/** Documentary description only — never a user-editable draft title. */
export const INVOICE_PAYMENT_LINE_PATTERN =
  /PAGAMENTO\s+EFETUADO|PAGAMENTO\s+PIX|PAGAMENTO\s+DE\s+FATURA\b|PGTO\s+FAT|FATURA\s+PAG/i;

export function invoicePaymentIgnoredReason(
  description: string | null,
): typeof CARD_IMPORT_IGNORED_REASON.INVOICE_PAYMENT | null {
  return description !== null && INVOICE_PAYMENT_LINE_PATTERN.test(description)
    ? CARD_IMPORT_IGNORED_REASON.INVOICE_PAYMENT
    : null;
}
