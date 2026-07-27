import { RecurrenceService } from './recurrence.service';

/**
 * A regra que não pode quebrar: editar ou excluir uma recorrência toca APENAS
 * as ocorrências futuras. Reescrever o passado pago falsearia o caixa.
 */
describe('RecurrenceService — passado imutável', () => {
  const cutoff = new Date(Date.UTC(2026, 6, 26));
  type Occ = { status: string; dataPagamento: Date | null; dataCompra: Date | null };
  const impl = RecurrenceService as unknown as {
    isFuture: (e: Occ, c: Date) => boolean;
  };
  const isFuture = (e: Occ) => impl.isFuture(e, cutoff);

  const occ = (status: string, data: Date | null) => ({
    status,
    dataPagamento: data,
    dataCompra: null,
  });

  it('ocorrência PAGA no passado nunca é futura', () => {
    expect(isFuture(occ('PAGO', new Date(Date.UTC(2026, 5, 15))))).toBe(false);
  });

  it('ocorrência PAGA com data futura também não é tocada (pagamento adiantado)', () => {
    expect(isFuture(occ('PAGO', new Date(Date.UTC(2026, 8, 15))))).toBe(false);
  });

  it('ocorrência PLANEJADO no passado (atrasada) não é tocada', () => {
    expect(isFuture(occ('PLANEJADO', new Date(Date.UTC(2026, 4, 15))))).toBe(false);
  });

  it('ocorrência PLANEJADO no futuro é editável', () => {
    expect(isFuture(occ('PLANEJADO', new Date(Date.UTC(2026, 7, 15))))).toBe(true);
  });

  it('hoje conta como futuro (fronteira inclusiva)', () => {
    expect(isFuture(occ('PLANEJADO', cutoff))).toBe(true);
  });

  it('sem data não é editável (não dá para saber de que lado está)', () => {
    expect(isFuture(occ('PLANEJADO', null))).toBe(false);
  });
});

describe('RecurrenceService — chave da série na URL', () => {
  it('sobrevive a merchant com caracteres que quebram URL', () => {
    const key = 'ifd*ifood club / são paulo';
    const encoded = RecurrenceService.encodeKey(key);
    expect(encoded).not.toContain('/');
    expect(RecurrenceService.decodeKey(encoded)).toBe(key);
  });
});

describe('RecurrenceService.seriesKey — data colada no nome', () => {
  it('agrupa PIX TRANSF LUCIANA de meses diferentes na MESMA série', () => {
    const keys = new Set(
      ['PIX TRANSF LUCIANA13/03', 'PIX TRANSF LUCIANA15/04', 'PIX TRANSF LUCIANA19/02'].map((t) =>
        RecurrenceService.seriesKey(t),
      ),
    );
    expect(keys.size).toBe(1);
  });

  it('não colapsa merchants diferentes', () => {
    expect(RecurrenceService.seriesKey('Aninha')).not.toBe(
      RecurrenceService.seriesKey('Luciana'),
    );
    expect(RecurrenceService.seriesKey('Financiamento Casa')).toBe('financiamento casa');
  });
});

describe('RecurrenceService — carimbo vence heurística', () => {
  it('série carimbada com 2 ocorrências aparece (heurística exigiria 3 meses)', () => {
    const impl = RecurrenceService as unknown as {
      toDetectorRows: (rows: unknown[]) => { detector: { key: string }[] };
    };
    const rows = [
      { id: 'a', titulo: 'Aninha', tipoDespesa: 'AJUDA', valorTotal: 35000,
        dataPagamento: new Date(Date.UTC(2026, 7, 15)), dataCompra: null,
        status: 'PLANEJADO', createdAt: new Date(), linkedExpenseId: null,
        recurrenceKey: 'rec_abc' },
      { id: 'b', titulo: 'Aninha (renomeada)', tipoDespesa: 'AJUDA', valorTotal: 35000,
        dataPagamento: new Date(Date.UTC(2026, 8, 15)), dataCompra: null,
        status: 'PLANEJADO', createdAt: new Date(), linkedExpenseId: null,
        recurrenceKey: 'rec_abc' },
    ];
    const { detector } = impl.toDetectorRows(rows);
    // Título diferente entre as duas, mas o carimbo as mantém na MESMA série.
    expect(new Set(detector.map((d) => d.key))).toEqual(new Set(['rec_abc']));
  });
});

describe('RecurrenceService.isParcela — parcelamento não é recorrência', () => {
  it.each([
    'Reisman Aliancas - Parcela 7/10',
    'Sodimac - Parcela 3/3',
    'WWW-CASASBAHIA-COM (6/10)',
    'PEX SETIMO OFICIAL - Parcela 2/4',
  ])('rejeita %s', (t) => expect(RecurrenceService.isParcela(t)).toBe(true));

  it.each(['Aninha', 'EBN*SPOTIFY', 'NETFLIX ENTRETENIMENTO', 'DA ELETROPAULO'])(
    'mantém %s',
    (t) => expect(RecurrenceService.isParcela(t)).toBe(false),
  );
});

/**
 * A tela mostra o que o USUÁRIO criou, não o que o extrato parece repetir.
 * Detectar assinatura no extrato trazia 64 séries de ruído em produção.
 */
describe('RecurrenceService.manualBatchIds — só o que foi criado pelo app', () => {
  const impl = RecurrenceService as unknown as {
    manualBatchIds: (rows: unknown[]) => Set<string>;
  };
  const row = (
    id: string,
    titulo: string,
    valorTotal: number,
    atMs: number,
    extra: Record<string, unknown> = {},
  ) => ({ id, titulo, valorTotal, createdAt: new Date(atMs), importId: null, recurrenceKey: null, ...extra });

  const t0 = Date.UTC(2026, 5, 1, 10, 0, 0);

  it('pega as N ocorrências gravadas no mesmo instante', () => {
    const ids = impl.manualBatchIds([
      row('a', 'Aninha', 35000, t0),
      row('b', 'Aninha', 35000, t0 + 300),
      row('c', 'Aninha', 35000, t0 + 700),
    ]);
    expect([...ids].sort()).toEqual(['a', 'b', 'c']);
  });

  it('ignora linhas de extrato importadas, mesmo gravadas em lote', () => {
    const ids = impl.manualBatchIds([
      row('a', 'IFD*IFOOD CLUB', 795, t0, { importId: 'imp1' }),
      row('b', 'IFD*IFOOD CLUB', 795, t0 + 100, { importId: 'imp1' }),
      row('c', 'IFD*IFOOD CLUB', 795, t0 + 200, { importId: 'imp1' }),
    ]);
    expect(ids.size).toBe(0);
  });

  it('ignora despesas iguais digitadas em dias diferentes (não é uma recorrência)', () => {
    const ids = impl.manualBatchIds([
      row('a', 'Pizza', 5000, t0),
      row('b', 'Pizza', 5000, t0 + 86_400_000),
    ]);
    expect(ids.size).toBe(0);
  });

  it('ignora despesa avulsa única', () => {
    expect(impl.manualBatchIds([row('a', 'Alimentação', 5000, t0)]).size).toBe(0);
  });

  it('ignora parcelamento digitado à mão', () => {
    const ids = impl.manualBatchIds([
      row('a', 'Sodimac - Parcela 1/3', 22284, t0),
      row('b', 'Sodimac - Parcela 1/3', 22284, t0 + 100),
    ]);
    expect(ids.size).toBe(0);
  });
});
