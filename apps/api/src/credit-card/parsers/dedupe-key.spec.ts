/**
 * #659 — RED unit spec dos helpers de chave de dedupe cross-origin.
 *
 * Target de produção (a materializar pelo implementer):
 *   apps/api/src/credit-card/parsers/dedupe-key.ts
 *     export function fileContentHash(buffers: Buffer[]): string
 *     export function dedupeKeyStrong(p: {
 *       tenantId; projectId; date: Date; merchant: string; amountCents: number;
 *       ordinal: number; fitId?: string; fileContentHash?: string;
 *     }): string | null
 *     export function dedupeKeyNatural(p: {
 *       tenantId; projectId; date: Date; merchant: string; amountCents: number; ordinal: number;
 *     }): string
 *
 * Fórmulas: docs/659-cross-origin-dedupe-design.md §5.
 * Contra o baseline 19633f12 o módulo não existe → RED. GREEN quando criado.
 */
import {
  fileContentHash,
  dedupeKeyStrong,
  dedupeKeyNatural,
} from './dedupe-key';

const base = {
  tenantId: 't1',
  projectId: 'p1',
  date: new Date('2026-04-10T12:00:00.000Z'),
  merchant: 'Cafeteria Bourbon',
  amountCents: 1200,
  ordinal: 0,
};

describe('#659 dedupeKeyNatural', () => {
  it('independe de seed/canal — é (tenant,project,date,merchant,amount,ordinal)', () => {
    expect(dedupeKeyNatural(base)).toBe(dedupeKeyNatural({ ...base }));
  });

  it('normaliza merchant igual a makeExternalId (lower + trim)', () => {
    expect(dedupeKeyNatural({ ...base, merchant: '  CAFETERIA bourbon ' })).toBe(
      dedupeKeyNatural(base),
    );
  });

  it('ordinal 0 e 1 produzem chaves distintas (2 idênticas no mesmo arquivo)', () => {
    expect(dedupeKeyNatural({ ...base, ordinal: 1 })).not.toBe(dedupeKeyNatural(base));
  });

  it('tenant e project fazem parte da chave (scope)', () => {
    expect(dedupeKeyNatural({ ...base, tenantId: 't2' })).not.toBe(dedupeKeyNatural(base));
    expect(dedupeKeyNatural({ ...base, projectId: 'p2' })).not.toBe(dedupeKeyNatural(base));
  });

  it('bordas de valor: 0, 1, -1 são todas distintas', () => {
    const k0 = dedupeKeyNatural({ ...base, amountCents: 0 });
    const k1 = dedupeKeyNatural({ ...base, amountCents: 1 });
    const kNeg = dedupeKeyNatural({ ...base, amountCents: -1 });
    expect(new Set([k0, k1, kNeg]).size).toBe(3);
  });

  it('hash de 32 hex chars', () => {
    expect(dedupeKeyNatural(base)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('#659 dedupeKeyStrong', () => {
  it('com FITID: determinístico e independente de fileContentHash', () => {
    const a = dedupeKeyStrong({ ...base, fitId: 'FIT-1', fileContentHash: 'AAA' });
    const b = dedupeKeyStrong({ ...base, fitId: 'FIT-1', fileContentHash: 'BBB' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it('com FITID: FITs diferentes → chaves diferentes; scope aplicado', () => {
    expect(dedupeKeyStrong({ ...base, fitId: 'FIT-1' })).not.toBe(
      dedupeKeyStrong({ ...base, fitId: 'FIT-2' }),
    );
    expect(dedupeKeyStrong({ ...base, fitId: 'FIT-1', tenantId: 't2' })).not.toBe(
      dedupeKeyStrong({ ...base, fitId: 'FIT-1' }),
    );
  });

  it('sem FITID: usa a variante file-hash; hashes diferentes → chaves diferentes', () => {
    const a = dedupeKeyStrong({ ...base, fileContentHash: 'AAA' });
    const b = dedupeKeyStrong({ ...base, fileContentHash: 'BBB' });
    expect(a).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it('sem FITID e sem fileContentHash → null (linha de backfill)', () => {
    expect(dedupeKeyStrong({ ...base })).toBeNull();
  });

  it('FITID tem precedência sobre file-hash', () => {
    const withFit = dedupeKeyStrong({ ...base, fitId: 'FIT-1', fileContentHash: 'AAA' });
    const fileOnly = dedupeKeyStrong({ ...base, fileContentHash: 'AAA' });
    expect(withFit).not.toBe(fileOnly);
  });

  it('SEC-1: MESMO fitId + data/valor/merchant diferentes → chaves diferentes (FITID sequencial entre contas)', () => {
    const contaA = dedupeKeyStrong({
      ...base,
      fitId: '1001',
      date: new Date('2026-04-10T00:00:00.000Z'),
      amountCents: 20000,
      merchant: 'Loja A',
    });
    const contaB = dedupeKeyStrong({
      ...base,
      fitId: '1001',
      date: new Date('2026-05-22T00:00:00.000Z'),
      amountCents: 5400,
      merchant: 'Loja B',
    });
    expect(contaA).not.toBe(contaB);
  });

  it('SEC-1: MESMO fitId + MESMA assinatura (mesmo arquivo por 2 canais) → chave idêntica', () => {
    const sig = {
      ...base,
      fitId: '1001',
      date: new Date('2026-04-10T00:00:00.000Z'),
      amountCents: 20000,
      merchant: 'Loja A',
    };
    expect(dedupeKeyStrong(sig)).toBe(dedupeKeyStrong({ ...sig }));
  });
});

describe('#659 equivalência cross-canal (o ponto do fix)', () => {
  it('bank/card/receipts-import geram a MESMA chave para o mesmo arquivo', () => {
    // os 3 canais chamam o helper com os MESMOS args (seed nunca entra)
    const fromBank = dedupeKeyNatural(base);
    const fromCard = dedupeKeyNatural({ ...base });
    const fromReceipts = dedupeKeyNatural({ ...base });
    expect(new Set([fromBank, fromCard, fromReceipts]).size).toBe(1);

    const fh = fileContentHash([Buffer.from('same bytes')]);
    const s1 = dedupeKeyStrong({ ...base, fileContentHash: fh });
    const s2 = dedupeKeyStrong({ ...base, fileContentHash: fh });
    expect(s1).toBe(s2);
  });
});

describe('#659 fileContentHash', () => {
  it('estável e ordem-independente entre buffers', () => {
    const a = fileContentHash([Buffer.from('one'), Buffer.from('two')]);
    const b = fileContentHash([Buffer.from('two'), Buffer.from('one')]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it('bytes diferentes → hash diferente', () => {
    expect(fileContentHash([Buffer.from('one')])).not.toBe(
      fileContentHash([Buffer.from('two')]),
    );
  });
});
