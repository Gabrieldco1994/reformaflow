import { parseStatement } from '../parsers';
import { parseBrlMoney, detectInstallment, makeExternalId } from '../parsers/types';

describe('credit-card parsers', () => {
  describe('parseBrlMoney', () => {
    it('parses BRL 1.234,56 to 123456', () => {
      expect(parseBrlMoney('1.234,56')).toBe(123456);
    });

    it('parses BRL 89,90 to 8990', () => {
      expect(parseBrlMoney('89,90')).toBe(8990);
    });

    it('parses US format 89.90 to 8990', () => {
      expect(parseBrlMoney('89.90')).toBe(8990);
    });

    it('parses negative BRL -89,90 to -8990', () => {
      expect(parseBrlMoney('-89,90')).toBe(-8990);
    });

    it('parses with R$ prefix', () => {
      expect(parseBrlMoney('R$ 1.234,56')).toBe(123456);
    });

    it('parses empty string to 0', () => {
      expect(parseBrlMoney('')).toBe(0);
    });
  });

  describe('detectInstallment', () => {
    it('detects PARC pattern with 02/12', () => {
      const inst = detectInstallment('NETFLIX PARC 02/12');
      expect(inst.current).toBe(2);
      expect(inst.total).toBe(12);
    });

    it('returns clean merchant without installment pattern', () => {
      const inst = detectInstallment('NETFLIX PARC 02/12');
      expect(inst.cleanMerchant).toBe('NETFLIX');
    });

    it('detects parenthesis pattern with (3/10)', () => {
      const inst = detectInstallment('CASAS BAHIA (3/10)');
      expect(inst.current).toBe(3);
      expect(inst.total).toBe(10);
    });

    it('returns undefined for non-installment text', () => {
      const inst = detectInstallment('IFOOD RESTAURANTE');
      expect(inst.current).toBeUndefined();
    });

    it('distinguishes date (03/07 = 3 julho) from parcel (3/7) - date pattern', () => {
      const inst = detectInstallment('COMPRA 03/07');
      expect(inst.current).toBeUndefined();
      expect(inst.total).toBeUndefined();
    });

    it('preserves merchant text when no installment detected', () => {
      const inst = detectInstallment('COMPRA 03/07');
      expect(inst.cleanMerchant).toBe('COMPRA 03/07');
    });
  });

  describe('makeExternalId', () => {
    it('generates deterministic ID for same inputs', () => {
      const id1 = makeExternalId({
        cardId: 'c1',
        date: new Date(Date.UTC(2026, 4, 12)),
        merchant: 'iFood',
        amountCents: 8990,
      });
      const id2 = makeExternalId({
        cardId: 'c1',
        date: new Date(Date.UTC(2026, 4, 12)),
        merchant: 'iFood',
        amountCents: 8990,
      });
      expect(id1).toBe(id2);
    });

    it('generates ID with 32 characters', () => {
      const id = makeExternalId({
        cardId: 'c1',
        date: new Date(Date.UTC(2026, 4, 12)),
        merchant: 'iFood',
        amountCents: 8990,
      });
      expect(id).toHaveLength(32);
    });
  });

  describe('CSV Nubank parser', () => {
    it('parses 3 transactions from Nubank CSV', () => {
      const nubankCsv = `date,title,amount
2026-05-12,IFOOD *RESTAURANTE,89.90
2026-05-13,UBER TRIP,32.40
2026-05-14,NETFLIX PARC 2/12,55.90
`;
      const result = parseStatement(nubankCsv, 'card-1', 'CSV_NUBANK');
      expect(result.transactions).toHaveLength(3);
    });

    it('parses Nubank currency R$ 89.90 to 8990 cents', () => {
      const nubankCsv = `date,title,amount
2026-05-12,IFOOD *RESTAURANTE,89.90
2026-05-13,UBER TRIP,32.40
2026-05-14,NETFLIX PARC 2/12,55.90
`;
      const result = parseStatement(nubankCsv, 'card-1', 'CSV_NUBANK');
      expect(result.transactions[0].amountCents).toBe(8990);
    });

    it('detects installment with PARC pattern in Nubank', () => {
      const nubankCsv = `date,title,amount
2026-05-12,IFOOD *RESTAURANTE,89.90
2026-05-13,UBER TRIP,32.40
2026-05-14,NETFLIX PARC 2/12,55.90
`;
      const result = parseStatement(nubankCsv, 'card-1', 'CSV_NUBANK');
      expect(result.transactions[2].installmentCurrent).toBe(2);
      expect(result.transactions[2].installmentTotal).toBe(12);
    });

    it('extracts period label from Nubank dates', () => {
      const nubankCsv = `date,title,amount
2026-05-12,IFOOD *RESTAURANTE,89.90
2026-05-13,UBER TRIP,32.40
2026-05-14,NETFLIX PARC 2/12,55.90
`;
      const result = parseStatement(nubankCsv, 'card-1', 'CSV_NUBANK');
      expect(result.periodLabel).toBe('2026-05');
    });

    it('sums amounts correctly from Nubank CSV', () => {
      const nubankCsv = `date,title,amount
2026-05-12,IFOOD *RESTAURANTE,89.90
2026-05-13,UBER TRIP,32.40
2026-05-14,NETFLIX PARC 2/12,55.90
`;
      const result = parseStatement(nubankCsv, 'card-1', 'CSV_NUBANK');
      expect(result.totalAmountCents).toBe(8990 + 3240 + 5590);
    });
  });

  describe('CSV Itaú parser', () => {
    it('parses 2 transactions from Itaú CSV', () => {
      const itauCsv = `data;descricao;valor
12/05/2026;IFOOD ESTABELECIMENTO;R$ 89,90
13/05/2026;UBER DO BRASIL;32,40
`;
      const result = parseStatement(itauCsv, 'card-2', 'CSV_ITAU');
      expect(result.transactions).toHaveLength(2);
    });

    it('parses Itaú currency R$ 89,90 to 8990 cents', () => {
      const itauCsv = `data;descricao;valor
12/05/2026;IFOOD ESTABELECIMENTO;R$ 89,90
13/05/2026;UBER DO BRASIL;32,40
`;
      const result = parseStatement(itauCsv, 'card-2', 'CSV_ITAU');
      expect(result.transactions[0].amountCents).toBe(8990);
    });
  });

  describe('OFX parser', () => {
    it('detects OFX source format', () => {
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
      const result = parseStatement(ofx, 'card-3', 'OFX');
      expect(result.source).toBe('OFX');
    });

    it('parses 3 transactions from OFX', () => {
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
      const result = parseStatement(ofx, 'card-3', 'OFX');
      expect(result.transactions).toHaveLength(3);
    });

    it('converts OFX debit (negative) amounts to positive', () => {
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
      const result = parseStatement(ofx, 'card-3', 'OFX');
      expect(result.transactions[0].amountCents).toBe(8990);
    });

    it('converts OFX refund (credit) amounts to negative', () => {
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
      const result = parseStatement(ofx, 'card-3', 'OFX');
      expect(result.transactions[2].amountCents).toBe(-2000);
    });
  });

  describe('AUTO detect parser', () => {
    it('auto-detects OFX format by content', () => {
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
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>
`;
      const result = parseStatement(ofx, 'card-4', 'AUTO', 'fatura.ofx');
      expect(result.source).toBe('OFX');
    });

    it('auto-detects Nubank CSV by filename', () => {
      const nubankCsv = `date,title,amount
2026-05-12,IFOOD *RESTAURANTE,89.90
2026-05-13,UBER TRIP,32.40
2026-05-14,NETFLIX PARC 2/12,55.90
`;
      const result = parseStatement(nubankCsv, 'card-5', 'AUTO', 'nubank-fatura.csv');
      expect(result.source).toBe('CSV_NUBANK');
    });
  });

  describe('P1: coluna "lançamento" reconhecida como merchant', () => {
    it('recognizes "lançamento" column as merchant, not as date fallback', () => {
      const csvWithLancamento = `lançamento;data;valor
IFOOD RESTAURANTE;12/05/2026;R$ 89,90
UBER DO BRASIL;13/05/2026;32,40
`;
      const result = parseStatement(csvWithLancamento, 'card-p1', 'CSV_GENERIC');
      expect(result.transactions).toHaveLength(2);
    });

    it('parses first transaction merchant correctly from "lançamento" column', () => {
      const csvWithLancamento = `lançamento;data;valor
IFOOD RESTAURANTE;12/05/2026;R$ 89,90
UBER DO BRASIL;13/05/2026;32,40
`;
      const result = parseStatement(csvWithLancamento, 'card-p1', 'CSV_GENERIC');
      expect(result.transactions[0].merchant).toBe('IFOOD RESTAURANTE');
    });

    it('parses second transaction merchant correctly from "lançamento" column', () => {
      const csvWithLancamento = `lançamento;data;valor
IFOOD RESTAURANTE;12/05/2026;R$ 89,90
UBER DO BRASIL;13/05/2026;32,40
`;
      const result = parseStatement(csvWithLancamento, 'card-p1', 'CSV_GENERIC');
      expect(result.transactions[1].merchant).toBe('UBER DO BRASIL');
    });
  });

  describe('P2: regex distinguishes date (03/07 = 3 julho) from installment (3/7)', () => {
    it('does not confuse date 03/07 with installment 03/07', () => {
      const inst = detectInstallment('COMPRA 03/07');
      expect(inst.current).toBeUndefined();
      expect(inst.total).toBeUndefined();
    });

    it('preserves merchant text when pattern looks like date', () => {
      const inst = detectInstallment('COMPRA 03/07');
      expect(inst.cleanMerchant).toBe('COMPRA 03/07');
    });

    it('correctly handles date pattern in CSV parser', () => {
      const csvWithDatePattern = `data;descricao;valor
12/05/2026;COMPRA 03/07;R$ 89,90
`;
      const result = parseStatement(csvWithDatePattern, 'card-p2', 'CSV_GENERIC');
      expect(result.transactions[0].merchant).toBe('COMPRA 03/07');
    });

    it('does not set installmentTotal when pattern is a date', () => {
      const csvWithDatePattern = `data;descricao;valor
12/05/2026;COMPRA 03/07;R$ 89,90
`;
      const result = parseStatement(csvWithDatePattern, 'card-p2', 'CSV_GENERIC');
      expect(result.transactions[0].installmentTotal).toBeUndefined();
    });
  });
});
