import { extractBankTransactionsFromText } from '../parsers/pdf';

/**
 * Regressões de perda silenciosa no parser de EXTRATO bancário em PDF.
 *
 * Reproduz o incidente real (extrato Itaú, 25/06–10/08/2026): lançamentos
 * reais sumiam sem virar transação — não é dedup, é o REGEX de linha do parser
 * que não casava e a linha era descartada silenciosamente (sem virar Expense/
 * Receipt e sem contar como "duplicada").
 *
 * As 12 linhas do incidente (data | descrição | valor impresso no extrato).
 */
const REAL_LINES: Array<[string, string, string]> = [
  ['27/07/2026', 'REND PAGO APLIC AUT MAIS', '1,52'],
  ['29/07/2026', 'SISPAG CARE PLUS', '-830,00'],
  ['29/07/2026', 'BO CASHBACK SEG RESID', '100,00'],
  ['30/07/2026', 'REMUNERACAO/SALARIO', '9.990,28'],
  ['30/07/2026', 'REND PAGO APLIC AUT MAIS', '0,58'],
  ['31/07/2026', 'ESTORNO PAY IFD I', '56,58'],
  ['31/07/2026', 'REND PAGO APLIC AUT MAIS', '0,25'],
  ['03/08/2026', 'REND PAGO APLIC AUT MAIS', '0,08'],
  ['04/08/2026', 'REND PAGO APLIC AUT MAIS', '0,21'],
  ['05/08/2026', 'REND PAGO APLIC AUT MAIS', '0,04'],
  ['06/08/2026', 'REND PAGO APLIC AUT MAIS', '0,11'],
  ['07/08/2026', 'REND PAGO APLIC AUT APR', '0,01'],
];

describe('extractBankTransactionsFromText — não descarta lançamento real', () => {
  it('valor >= R$1000 SEM separador de milhar (9990,28) não some (salário)', () => {
    // pdf-parse às vezes extrai o valor sem o ponto de milhar. A linha tem que
    // continuar virando transação — antes o regex exigia milhar agrupado e o
    // salário inteiro era descartado.
    const text = REAL_LINES.map((r) => `${r[0]} ${r[1]} ${r[2].replace(/\./g, '')}`).join('\n');
    const txs = extractBankTransactionsFromText(text, 2026);

    expect(txs).toHaveLength(REAL_LINES.length);
    const salary = txs.find((t) => /REMUNERACAO/.test(t.merchant));
    expect(salary).toBeDefined();
    // crédito (receita) → normalizado para negativo
    expect(salary!.amountCents).toBe(-999028);
  });

  it('valor >= R$1000 COM separador de milhar (9.990,28) continua funcionando', () => {
    const text = REAL_LINES.map((r) => `${r[0]} ${r[1]} ${r[2]}`).join('\n');
    const txs = extractBankTransactionsFromText(text, 2026);
    expect(txs).toHaveLength(REAL_LINES.length);
    const salary = txs.find((t) => /REMUNERACAO/.test(t.merchant));
    expect(salary!.amountCents).toBe(-999028);
  });

  it('linha com coluna SALDO (valor + saldo do dia) usa o VALOR, não o saldo', () => {
    // Layout típico Itaú: "DATA HISTORICO VALOR SALDO". O parser tem que pegar o
    // primeiro número (o lançamento), não o saldo corrente que vem depois.
    const withSaldo = [
      '27/07/2026 REND PAGO APLIC AUT MAIS 1,52 15.001,52',
      '30/07/2026 REMUNERACAO/SALARIO 9.990,28 24.261,80',
      '29/07/2026 SISPAG CARE PLUS -830,00 14.171,52',
    ].join('\n');
    const txs = extractBankTransactionsFromText(withSaldo, 2026);
    expect(txs).toHaveLength(3);

    const salary = txs.find((t) => /REMUNERACAO/.test(t.merchant))!;
    expect(salary.merchant).toBe('REMUNERACAO/SALARIO'); // descrição não engole o valor
    expect(salary.amountCents).toBe(-999028);            // valor, não 24.261,80

    const rend = txs.find((t) => /REND PAGO/.test(t.merchant))!;
    expect(rend.amountCents).toBe(-152); // 1,52 crédito, não 15.001,52
  });

  it('linha SEM coluna saldo (valor único) continua funcionando (regressão)', () => {
    const txs = extractBankTransactionsFromText('02/01/2026 PAY 54624 -32,99', 2026);
    expect(txs).toHaveLength(1);
    expect(txs[0].amountCents).toBe(3299); // débito -32,99 → despesa positiva
  });
});
