/* eslint-disable @typescript-eslint/no-explicit-any */
import { parseStatement } from '../parsers';
import { parseBrlMoney, detectInstallment, makeExternalId } from '../parsers/types';

let failures = 0;
let passed = 0;

function assert(cond: any, msg: string) {
  if (cond) { passed++; return; }
  failures++;
  console.error(`✗ ${msg}`);
}

// ─── parseBrlMoney ────────────────────────────────────────
assert(parseBrlMoney('1.234,56') === 123456, 'BRL 1.234,56 -> 123456');
assert(parseBrlMoney('89,90') === 8990, 'BRL 89,90 -> 8990');
assert(parseBrlMoney('89.90') === 8990, 'US 89.90 -> 8990');
assert(parseBrlMoney('-89,90') === -8990, 'BRL -89,90 -> -8990');
assert(parseBrlMoney('R$ 1.234,56') === 123456, 'com prefixo R$ -> 123456');
assert(parseBrlMoney('') === 0, 'vazio -> 0');

// ─── detectInstallment ────────────────────────────────────
let inst = detectInstallment('NETFLIX PARC 02/12');
assert(inst.current === 2 && inst.total === 12, 'PARC 02/12');
assert(inst.cleanMerchant === 'NETFLIX', 'merchant limpo');

inst = detectInstallment('CASAS BAHIA (3/10)');
assert(inst.current === 3 && inst.total === 10, '(3/10)');

inst = detectInstallment('IFOOD RESTAURANTE');
assert(inst.current === undefined, 'sem parcela');

// ─── makeExternalId determinístico ────────────────────────
const id1 = makeExternalId({ cardId: 'c1', date: new Date(Date.UTC(2026,4,12)), merchant: 'iFood', amountCents: 8990 });
const id2 = makeExternalId({ cardId: 'c1', date: new Date(Date.UTC(2026,4,12)), merchant: 'iFood', amountCents: 8990 });
assert(id1 === id2, 'externalId determinístico');
assert(id1.length === 32, 'externalId 32 chars');

// ─── parser CSV Nubank ────────────────────────────────────
const nubankCsv = `date,title,amount
2026-05-12,IFOOD *RESTAURANTE,89.90
2026-05-13,UBER TRIP,32.40
2026-05-14,NETFLIX 2/12,55.90
`;
const rNu = parseStatement(nubankCsv, 'card-1', 'CSV_NUBANK');
assert(rNu.transactions.length === 3, 'Nubank 3 tx');
assert(rNu.transactions[0].amountCents === 8990, 'Nubank R$ 89.90');
assert(rNu.transactions[2].installmentCurrent === 2 && rNu.transactions[2].installmentTotal === 12, 'Nubank parcela');
assert(rNu.periodLabel === '2026-05', 'periodLabel');
assert(rNu.totalAmountCents === 8990 + 3240 + 5590, 'soma Nubank');

// ─── parser CSV Itaú ───────────────────────────────────────
const itauCsv = `data;descricao;valor
12/05/2026;IFOOD ESTABELECIMENTO;R$ 89,90
13/05/2026;UBER DO BRASIL;32,40
`;
const rIt = parseStatement(itauCsv, 'card-2', 'CSV_ITAU');
assert(rIt.transactions.length === 2, 'Itaú 2 tx');
assert(rIt.transactions[0].amountCents === 8990, 'Itaú R$ 89,90');

// ─── parser OFX ────────────────────────────────────────────
const ofx = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260512
<TRNAMT>-89.90
<FITID>itau-1234
<MEMO>IFOOD RESTAURANTE
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260513
<TRNAMT>-32.40
<FITID>itau-1235
<MEMO>UBER TRIP
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260514
<TRNAMT>20.00
<FITID>itau-1236
<MEMO>ESTORNO IFOOD
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>
`;
const rOfx = parseStatement(ofx, 'card-3', 'OFX');
assert(rOfx.source === 'OFX', 'fonte OFX detectada');
assert(rOfx.transactions.length === 3, 'OFX 3 tx');
// despesas em OFX vêm negativas; convertemos para positivo
assert(rOfx.transactions[0].amountCents === 8990, 'OFX despesa positivada');
// estorno (crédito original) vira negativo (= devolução)
assert(rOfx.transactions[2].amountCents === -2000, 'OFX estorno -2000');

// ─── auto-detect ───────────────────────────────────────────
const rAuto = parseStatement(ofx, 'card-4', 'AUTO', 'fatura.ofx');
assert(rAuto.source === 'OFX', 'AUTO detecta OFX');

const rAutoCsv = parseStatement(nubankCsv, 'card-5', 'AUTO', 'nubank-fatura.csv');
assert(rAutoCsv.source === 'CSV_NUBANK', 'AUTO detecta Nubank pelo nome');

console.log(`\n${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
