/**
 * #569 — Chave RESERVADA de pagamento manual de fatura (namespace versionado).
 *
 * Um pagamento manual de fatura feito pelo cockpit (`MonthlyOverviewService.payInvoice`)
 * grava sua identidade em `Expense.settlesInvoiceKey` no formato SERVIDOR-OWNED
 * `m1:{cardId}:{cardLast4}:{dueMonth}`. A `cardId` é o id ESTÁVEL do cartão
 * efetivamente liquidado — o que permite ao undo do cockpit casar o pagamento
 * pela IDENTIDADE do cartão (não pelo `last4`, que pode colidir em dados legados).
 *
 * A chave LEGADA de 2 partes `{cardLast4}:{dueMonth}` continua sendo o vínculo de
 * "cartão paga cartão"/PIX (declaração geral de quitação de OUTRO cartão) e NÃO é
 * elegível ao undo manual — só o namespace `m1`, cunhado exclusivamente pelo
 * `payInvoice`, é.
 *
 * PROVENIÊNCIA é do servidor: o parser é ESTRITO (fail-closed). Um descritor `m1`
 * malformado/forjado NÃO vira null-silencioso permissivo — `parseManualInvoiceKey`
 * devolve `null`, e todo caller trata `null` como "não é pagamento manual" (sem
 * permissão de mutar/desfazer). Nenhuma rota que não seja o `payInvoice` cunha `m1`.
 */

export const MANUAL_INVOICE_KEY_VERSION = 'm1';

/** `dueMonth` no formato YYYY-MM com mês 01–12. */
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
/** `cardLast4`: exatamente 4 dígitos. */
const LAST4_RE = /^\d{4}$/;

export interface ManualInvoiceKey {
  cardId: string;
  last4: string;
  dueMonth: string;
}

/**
 * Cunha a chave reservada. `cardId` é um cuid (sem `:`), `last4` 4 dígitos,
 * `dueMonth` YYYY-MM — garantidos pelo caller (dados do próprio cartão resolvido).
 */
export function buildManualInvoiceKey(
  cardId: string,
  last4: string,
  dueMonth: string,
): string {
  return `${MANUAL_INVOICE_KEY_VERSION}:${cardId}:${last4}:${dueMonth}`;
}

/**
 * Parser ESTRITO do namespace `m1` (fail-closed). Exige EXATAMENTE 4 segmentos,
 * versão `m1`, `cardId` não-vazio, `last4` de 4 dígitos e `dueMonth` YYYY-MM
 * válido. Qualquer desvio (chave legada de 2 partes, forjada, truncada,
 * mês/last4 inválidos) devolve `null` — nunca uma identidade parcial.
 */
export function parseManualInvoiceKey(
  stored: string | null | undefined,
): ManualInvoiceKey | null {
  if (!stored) return null;
  const parts = stored.split(':');
  if (parts.length !== 4) return null;
  const [version, cardId, last4, dueMonth] = parts;
  if (version !== MANUAL_INVOICE_KEY_VERSION) return null;
  if (!cardId) return null;
  if (!LAST4_RE.test(last4)) return null;
  if (!MONTH_RE.test(dueMonth)) return null;
  return { cardId, last4, dueMonth };
}

/** `true` sse `stored` é uma chave manual `m1` válida (proveniência do servidor). */
export function isManualInvoiceKey(stored: string | null | undefined): boolean {
  return parseManualInvoiceKey(stored) !== null;
}
