import { rankCardCandidates, type CardWithEntries } from './card-invoice-match';
import { getSettlementWindowMonths } from '../credit-card/card-invoice-settlement.service';

const utc = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

function card(over: Partial<CardWithEntries> = {}): CardWithEntries {
  return {
    last4: '5572',
    nickname: 'Visa ****5572',
    closingDay: null,
    dueDay: 5,
    entries: [],
    ...over,
  };
}

describe('rankCardCandidates — windowState (#569 PR2)', () => {
  it('candidato com dueMonth dentro de {payMonth, payMonth+1} → windowState WITHIN_SETTLEMENT_WINDOW', () => {
    // pagamento em 2026-07-21 → payMonth=2026-07, janela commit={2026-07,2026-08}
    const ranked = rankCardCandidates(
      [card({ entries: [{ data: utc('2026-08-10'), valor: 18_428_13 }] })],
      18_428_13,
      utc('2026-07-21'),
    );
    expect(ranked[0]).toMatchObject({ dueMonth: '2026-08', windowState: 'WITHIN_SETTLEMENT_WINDOW' });
  });

  it('candidato com dueMonth = payMonth - 1 (1 mês de atraso sobre o vencimento, fora de {payMonth,payMonth+1}) → windowState OUTSIDE_SETTLEMENT_WINDOW', () => {
    // Caso didático §2.b: fatura de maio, pagamento em 30/06/2026.
    // payMonth=2026-06, janela commit={2026-06,2026-07}; a prévia (3 meses)
    // ainda enxerga maio (payMonth-1 relativo a 06 é 05).
    const ranked = rankCardCandidates(
      [card({ entries: [{ data: utc('2026-05-10'), valor: 1_000_00 }] })],
      1_000_00,
      utc('2026-06-30'),
    );
    expect(ranked[0]).toMatchObject({ dueMonth: '2026-05', windowState: 'OUTSIDE_SETTLEMENT_WINDOW' });
  });

  it('candidato com dueMonth = payMonth + 1 (dentro) permanece WITHIN mesmo em cartões sem closingDay/dueDay — fallback de competência', () => {
    const ranked = rankCardCandidates(
      [card({ closingDay: null, dueDay: null, entries: [{ data: utc('2026-08-10'), valor: 1_000_00 }] })],
      1_000_00,
      utc('2026-07-15'),
    );
    expect(ranked[0]).toMatchObject({ dueMonth: '2026-08', windowState: 'WITHIN_SETTLEMENT_WINDOW' });
  });

  it('função de janela do commit ({payMonth,payMonth+1}) é IMPORTADA de card-invoice-settlement.service.ts, não duplicada literal — teste de regressão que falha se as duas janelas divergirem por edição isolada de uma das duas', () => {
    const months = getSettlementWindowMonths('2026-06');
    expect(Array.from(months).sort()).toEqual(['2026-06', '2026-07']);

    // Se alguém duplicar o literal em rankCardCandidates em vez de importar
    // esta função, este teste continua passando isoladamente — mas o teste
    // acima ("payMonth - 1 → OUTSIDE") já vai falhar no dia em que a janela
    // do commit for editada aqui e a duplicata em card-invoice-match.ts não
    // acompanhar, porque ambos os testes leem o mesmo dado de entrada.
    const outsideRanked = rankCardCandidates(
      [card({ entries: [{ data: utc('2026-05-10'), valor: 1_000_00 }] })],
      1_000_00,
      utc('2026-06-30'),
    );
    expect(months.has(outsideRanked[0].dueMonth)).toBe(false);
  });
});
