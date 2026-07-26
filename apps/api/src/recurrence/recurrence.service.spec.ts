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
