import * as XLSX from 'xlsx';
// fflate é dependência de runtime (transitiva) de @reformaflow/api
// (@nestjs/common → file-type → @tokenizer/inflate → fflate), portanto sempre
// presente. Usada aqui só para FABRICAR um .xlsx com a tag <dimension>
// defasada — cenário que o XLSX.write não consegue gerar (ele poda as células
// fora do !ref). É exatamente o artefato que causou o incidente real.
import { unzipSync, zipSync, strToU8 } from 'fflate';
import { parseXlsx } from '../parsers/xlsx';

const CARD_ID = 'acc-itau-cc';

/**
 * Constrói um buffer .xlsx onde o <sheetData> contém TODAS as linhas de `aoa`
 * mas a tag <dimension ref> declara um range MENOR (`staleRef`), simulando um
 * arquivo filtrado/re-salvo por uma ferramenta que não atualizou a dimensão.
 */
function makeStaleDimensionXlsx(aoa: unknown[][], staleRef: string): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Lançamentos');
  const full = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

  const files = unzipSync(new Uint8Array(full));
  const sheetPath = Object.keys(files).find((p) => /xl\/worksheets\/sheet1\.xml$/.test(p))!;
  let xml = Buffer.from(files[sheetPath]).toString('utf-8');
  xml = xml.replace(/<dimension ref="[^"]+"\/>/, `<dimension ref="${staleRef}"/>`);
  files[sheetPath] = strToU8(xml);
  return Buffer.from(zipSync(files));
}

/** Buffer .xlsx normal (dimensão íntegra). */
function makeXlsx(aoa: unknown[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Lançamentos');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

// Layout REAL do extrato Itaú (conta corrente), por assinatura de colunas:
//   col 0 = data | col 1 = lançamento | col 2 = ag./origem
//   col 3 = VALOR DO MOVIMENTO (D)     | col 4 = SALDO DO DIA (E, checkpoint)
// Preâmbulo antes do header; datas como texto dd/mm/aaaa; valores numéricos
// com ponto decimal (9990.28), sem separador de milhar.
const HEADER = ['data', 'lançamento', 'ag./origem', 'valor (R$)', 'saldos (R$)'];

function realLayout(): unknown[][] {
  return [
    ['Itaú Unibanco S.A.', '', '', '', ''],
    ['Extrato de conta corrente', '', '', '', ''],
    ['Período: 25/06/2026 a 10/08/2026', '', '', '', ''],
    HEADER,
    ['25/06/2026', 'SALDO ANTERIOR', '', '', 6218.29],          // saldo (E) → NÃO é movimento
    ['26/06/2026', 'PAY MO OC 26/06', '', -17.8, ''],           // débito (D)
    ['22/07/2026', 'SISPAG CARE PLUS', '', -720, ''],
    ['23/07/2026', 'PIX RECEBIDO', '', 500.0, ''],              // último dia que "entrava" no bug
    ['24/07/2026', 'TED RECEBIDA', '', 1234.56, ''],            // 1ª linha do trecho perdido
    ['27/07/2026', 'REND PAGO APLIC AUT MAIS', '', 1.52, ''],
    ['29/07/2026', 'SISPAG CARE PLUS', '', 830.0, ''],
    ['30/07/2026', 'REMUNERACAO/SALARIO', '', 9990.28, ''],     // SALÁRIO: 4 dígitos, ponto decimal
    ['31/07/2026', 'SALDO TOTAL DISPONÍVEL DIA', '', '', 12345.67], // saldo (E)
    ['05/08/2026', 'LANCAMENTO SEM VALOR', '', '', ''],         // dated+desc, sem valor → unparsed
    ['10/08/2026', 'REND PAGO APLIC AUT APR', '', 0.01, ''],
  ];
}

describe('parseXlsx — extrato Itaú (layout real)', () => {
  it('importa TODOS os movimentos (D), sem transformar SALDO (E) em lançamento', () => {
    const res = parseXlsx(makeXlsx(realLayout()), CARD_ID);
    const descrs = res.transactions.map((t) => t.merchant);

    // Movimentos presentes (débitos e créditos)
    expect(descrs).toEqual(expect.arrayContaining([
      'PAY MO OC 26/06',
      'SISPAG CARE PLUS',
      'PIX RECEBIDO',
      'TED RECEBIDA',
      'REND PAGO APLIC AUT MAIS',
      'REMUNERACAO/SALARIO',
      'REND PAGO APLIC AUT APR',
    ]));

    // Nenhuma linha de saldo virou transação (dinheiro fantasma)
    expect(descrs.some((d) => /saldo/i.test(d))).toBe(false);
    // 8 movimentos: PAY, SISPAG(720), SISPAG(830), PIX, TED, REND(1.52),
    // SALARIO, REND(0.01). Fora: 2 saldos (E) + 1 linha sem valor.
    expect(res.transactions).toHaveLength(8);
  });

  it('lê valor de 4 dígitos com ponto decimal (9990.28) como 999028 centavos', () => {
    const res = parseXlsx(makeXlsx(realLayout()), CARD_ID);
    const salario = res.transactions.find((t) => t.merchant === 'REMUNERACAO/SALARIO');
    expect(salario).toBeDefined();
    // crédito no extrato → amountCents negativo (vira Receipt no commit)
    expect(salario!.amountCents).toBe(-999028);
  });

  it('gera externalId distinto para a MESMA descrição em datas diferentes (SISPAG 22/07 vs 29/07)', () => {
    const res = parseXlsx(makeXlsx(realLayout()), CARD_ID);
    const sispag = res.transactions.filter((t) => t.merchant === 'SISPAG CARE PLUS');
    expect(sispag).toHaveLength(2);
    expect(sispag[0].externalId).not.toBe(sispag[1].externalId);
  });

  it('reporta linhas com data+descrição mas sem valor legível em unparsedRows (não some sem rastro)', () => {
    const res = parseXlsx(makeXlsx(realLayout()), CARD_ID);
    expect(res.unparsedRows).toBeDefined();
    expect(res.unparsedRows!.some((r) => r.description === 'LANCAMENTO SEM VALOR')).toBe(true);
    // saldo NÃO é reportado como unparsed (é ignorado de propósito)
    expect(res.unparsedRows!.some((r) => /saldo/i.test(r.description))).toBe(false);
  });

  it('ignora saldo mesmo com mojibake de encoding, mas NÃO descarta movimento que só mencione "saldo" no meio', () => {
    const aoa = [
      HEADER,
      ['25/06/2026', 'SALDO ANTERIOR', '', '', 6218.29],
      ['30/07/2026', 'SALDO TOTAL DISPONÃ\x8dVEL DIA', '', '', 12345.67], // mojibake real
      ['30/07/2026', 'TRANSF PARA SALDO POUPANCA', '', -200, ''],          // movimento real com "saldo" no meio
    ];
    const res = parseXlsx(makeXlsx(aoa), CARD_ID);
    const descrs = res.transactions.map((t) => t.merchant);
    // os 2 saldos (início "SALDO") ficam fora
    expect(descrs.filter((d) => /^saldo/i.test(d))).toHaveLength(0);
    // o movimento com "saldo" no meio ENTRA
    expect(descrs).toContain('TRANSF PARA SALDO POUPANCA');
    expect(res.transactions).toHaveLength(1);
  });
});

describe('parseXlsx — <dimension> defasada (causa-raiz do corte contíguo)', () => {
  it('SEM o fix, o SheetJS truncaria; COM o fix, recupera todas as linhas incl. o salário', () => {
    // <dimension> declara só até a linha do 23/07 (A1:E8 = header na linha 4 +
    // 4 linhas de dado). Tudo de 24/07 em diante ("REMUNERACAO/SALARIO" e
    // posteriores) fica FORA do range declarado → seria truncado sem o fix.
    const buffer = makeStaleDimensionXlsx(realLayout(), 'A1:E8');
    const res = parseXlsx(buffer, CARD_ID);
    const descrs = res.transactions.map((t) => t.merchant);

    // O salário e todo o trecho pós-24/07 DEVEM entrar
    expect(descrs).toContain('REMUNERACAO/SALARIO');
    expect(descrs).toContain('TED RECEBIDA');
    expect(descrs).toContain('REND PAGO APLIC AUT MAIS');
    expect(descrs).toContain('REND PAGO APLIC AUT APR');

    const salario = res.transactions.find((t) => t.merchant === 'REMUNERACAO/SALARIO');
    expect(salario!.amountCents).toBe(-999028);

    // e saldo continua fora
    expect(descrs.some((d) => /saldo/i.test(d))).toBe(false);
  });

  it('demonstra a truncagem crua do SheetJS quando o !ref está defasado (documenta o bug)', () => {
    // Prova de que o mecanismo é real: lendo com o !ref defasado, sheet_to_json
    // devolve MENOS linhas do que as células realmente presentes.
    const buffer = makeStaleDimensionXlsx(realLayout(), 'A1:E8');
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const declaredRef = sheet['!ref'];
    const rowsWithStaleRef = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];
    // 16 linhas no arquivo, mas o !ref defasado corta em 8
    expect(declaredRef).toBe('A1:E8');
    expect(rowsWithStaleRef.length).toBe(8);
    // as células do salário CONTINUAM no objeto sheet (só o !ref as esconde)
    expect(sheet['B12']).toBeDefined();
    expect((sheet['B12'] as XLSX.CellObject).v).toBe('REMUNERACAO/SALARIO');
  });
});
