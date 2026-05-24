import {
  detectInstallment,
  inferPeriodLabel,
  makeExternalId,
  parseBrlMoney,
  type NormalizedTx,
  type ParseResult,
} from './types';

/**
 * Parser OFX (SGML-like). Funciona para os dialetos mais comuns:
 *  - Itaú extrato cartão (.ofx)
 *  - Nubank fatura cartão (.ofx)
 *  - Inter, BB, Bradesco etc.
 *
 * Não usamos dependência externa: extraímos via regex blocos <STMTTRN>...</STMTTRN>
 * porque OFX 2.x já é XML válido e OFX 1.x é SGML mas o subset que importa é
 * o mesmo formato de tags simples.
 */
export function parseOfx(content: string, cardId: string): ParseResult {
  // Normaliza CRLF e remove BOM
  const text = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

  const transactions: NormalizedTx[] = [];
  let totalAmountCents = 0;

  // Captura blocos de transação
  const stmtRe = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  let match: RegExpExecArray | null;
  while ((match = stmtRe.exec(text)) !== null) {
    const block = match[1];

    const dtPosted = pick(block, 'DTPOSTED');
    const trnAmt = pick(block, 'TRNAMT');
    const fitId = pick(block, 'FITID');
    const memo = pick(block, 'MEMO') ?? pick(block, 'NAME') ?? '';

    const date = parseOfxDate(dtPosted);
    if (!date) continue;

    // OFX convenção: valor negativo = débito. Para cartão de crédito (fatura),
    // a despesa vem como negativa. Convertemos para POSITIVO (despesa positiva).
    const amountRaw = parseBrlMoney(trnAmt ?? '0');
    const amountCents = -amountRaw; // inverte sinal: despesa fica positiva
    if (amountCents === 0) continue;

    const { current, total, cleanMerchant } = detectInstallment(memo);
    const externalId = makeExternalId({
      cardId,
      date,
      merchant: cleanMerchant,
      amountCents,
      bankRef: fitId ?? undefined,
    });

    transactions.push({
      externalId,
      date,
      merchant: cleanMerchant || 'Lançamento',
      amountCents,
      installmentCurrent: current,
      installmentTotal: total,
    });
    totalAmountCents += amountCents;
  }

  return {
    source: 'OFX',
    transactions,
    totalAmountCents,
    periodLabel: inferPeriodLabel(transactions),
  };
}

function pick(block: string, tag: string): string | undefined {
  // OFX 1.x: <TAG>value (sem fechamento explícito); OFX 2.x: <TAG>value</TAG>
  const re = new RegExp(`<${tag}>([^<\\n\\r]*)`, 'i');
  const m = block.match(re);
  if (!m) return undefined;
  return m[1].trim();
}

function parseOfxDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  // OFX usa YYYYMMDD[HHMMSS[.SSS]][ZONE]
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10) - 1;
  const d = parseInt(m[3], 10);
  return new Date(Date.UTC(y, mo, d));
}
