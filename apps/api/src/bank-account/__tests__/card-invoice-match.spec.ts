import {
  aggregateInvoiceTotals,
  pickUniqueCardMatch,
  rankCardCandidates,
  type CardWithEntries,
} from '../card-invoice-match';

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

describe('aggregateInvoiceTotals', () => {
  it('sem closingDay, agrupa pela competência (fallback do domínio)', () => {
    const totals = aggregateInvoiceTotals(
      card({
        entries: [
          { data: utc('2026-08-03'), valor: 1_000_00 },
          { data: utc('2026-08-20'), valor: 500_00 },
          { data: utc('2026-09-01'), valor: 300_00 },
        ],
      }),
    );
    expect(totals.get('2026-08')).toBe(1_500_00);
    expect(totals.get('2026-09')).toBe(300_00);
  });

  it('com closingDay/dueDay, joga a compra pós-fechamento para a fatura seguinte', () => {
    const totals = aggregateInvoiceTotals(
      card({
        last4: '5868',
        closingDay: 8,
        dueDay: 15,
        entries: [
          { data: utc('2026-07-05'), valor: 100_00 }, // antes do fechamento
          { data: utc('2026-07-20'), valor: 200_00 }, // depois do fechamento
        ],
      }),
    );
    const months = Array.from(totals.keys()).sort();
    expect(months).toHaveLength(2);
    expect(totals.get(months[0])).toBe(100_00);
    expect(totals.get(months[1])).toBe(200_00);
  });
});

describe('rankCardCandidates', () => {
  // Caso real (jul/2026): pagamento de R$ 17.655,85 em 21/07 referente à
  // fatura de AGOSTO do cartão 5572, cujo total em aberto era R$ 18.428,13.
  // O match exato falha (delta R$ 772,28) — o candidato tem que aparecer
  // mesmo assim, senão a despesa nasce com cardLast4 null e o dinheiro some.
  const cinco572 = card({
    entries: [{ data: utc('2026-08-10'), valor: 18_428_13 }],
  });
  const cincoOitoSeisOito = card({
    last4: '5868',
    nickname: 'Personalite',
    closingDay: null,
    dueDay: 15,
    entries: [{ data: utc('2026-08-04'), valor: 1_035_82 }],
  });

  it('ranqueia a fatura do mês seguinte ao pagamento (paguei em jul a fatura de ago)', () => {
    const ranked = rankCardCandidates(
      [cinco572, cincoOitoSeisOito],
      17_655_85,
      utc('2026-07-21'),
    );
    expect(ranked[0]).toMatchObject({
      cardLast4: '5572',
      dueMonth: '2026-08',
      invoiceTotalCents: 18_428_13,
      deltaCents: 772_28,
    });
  });

  it('ignora faturas fora da janela de ±1 mês do pagamento', () => {
    const distante = card({
      last4: '7259',
      entries: [{ data: utc('2026-01-10'), valor: 17_655_85 }],
    });
    const ranked = rankCardCandidates([distante], 17_655_85, utc('2026-07-21'));
    expect(ranked).toHaveLength(0);
  });
});

describe('pickUniqueCardMatch', () => {
  it('não auto-escolhe quando a diferença passa da tolerância', () => {
    const ranked = rankCardCandidates(
      [card({ entries: [{ data: utc('2026-08-10'), valor: 18_428_13 }] })],
      17_655_85,
      utc('2026-07-21'),
    );
    expect(pickUniqueCardMatch(ranked)).toBeNull();
  });

  it('auto-escolhe quando o valor bate dentro da tolerância', () => {
    const ranked = rankCardCandidates(
      [card({ entries: [{ data: utc('2026-08-10'), valor: 17_656_50 }] })],
      17_655_85,
      utc('2026-07-21'),
    );
    expect(pickUniqueCardMatch(ranked)?.cardLast4).toBe('5572');
  });

  it('não chuta quando DOIS cartões têm fatura do mesmo valor', () => {
    const ranked = rankCardCandidates(
      [
        card({ entries: [{ data: utc('2026-08-10'), valor: 17_655_85 }] }),
        card({ last4: '3541', entries: [{ data: utc('2026-08-10'), valor: 17_655_85 }] }),
      ],
      17_655_85,
      utc('2026-07-21'),
    );
    expect(pickUniqueCardMatch(ranked)).toBeNull();
  });
});
