/**
 * #704 visual-only correction: signed financial numbers stay untouched; only the
 * bar GEOMETRY (magnitude over max magnitude) and the share label (omitted when
 * the denominator is not positive) change.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import CategoriasBarras from './CategoriasBarras';
import { categoriaBarrasDoAno, type CategoriaBarra } from './derive';
import { sharePct } from './spend-tree';

const cats = (...pairs: Array<[string, number]>) => pairs.map(([categoria, valor]) => ({ categoria, valor, media: 0 }));

describe('categoriaBarrasDoAno (YearView geometry)', () => {
  it('all-negative: keeps signed values, sizes bars by magnitude', () => {
    const bars = categoriaBarrasDoAno(cats(['Crédito', -40_000], ['Estorno', -10_000]));
    expect(bars.map((b) => b.valor)).toEqual([-40_000, -10_000]);
    expect(bars.map((b) => b.pct)).toEqual([1, 0.25]);
  });
  it('mixed: denominator is the max magnitude, never the signed max', () => {
    const bars = categoriaBarrasDoAno(cats(['Material', 80_000], ['Crédito', -40_000]));
    expect(bars.map((b) => [b.valor, b.pct])).toEqual([
      [80_000, 1],
      [-40_000, 0.5],
    ]);
  });
  it('mixed where the credit dominates', () => {
    const bars = categoriaBarrasDoAno(cats(['Material', 10_000], ['Crédito', -40_000]));
    expect(bars.map((b) => b.pct)).toEqual([0.25, 1]);
  });
  it('zero-net or empty input never yields NaN/negative geometry', () => {
    expect(categoriaBarrasDoAno([])).toEqual([]);
    const zero = categoriaBarrasDoAno(cats(['A', 0]));
    expect(zero[0].pct).toBe(0);
    for (const b of categoriaBarrasDoAno(cats(['A', -5], ['B', 5]))) {
      expect(b.pct).toBeGreaterThanOrEqual(0);
      expect(b.pct).toBeLessThanOrEqual(1);
    }
  });
  it('preserves media and colour per category', () => {
    const [bar] = categoriaBarrasDoAno([{ categoria: 'Crédito', valor: -1, media: -3 }]);
    expect(bar.media).toBe(-3);
    expect(bar.cor).toBeTruthy();
  });
});

describe('sharePct (ArvoreGastos label)', () => {
  it('omits the label when the denominator is zero or negative', () => {
    expect(sharePct(-40_000, 0)).toBeNull();
    expect(sharePct(-40_000, -40_000)).toBeNull();
    expect(sharePct(0, 0)).toBeNull();
  });
  it('keeps Math.round(part/total*100), including negative parts', () => {
    expect(sharePct(50, 200)).toBe(25);
    expect(sharePct(-80_000, 40_000)).toBe(-200);
    expect(sharePct(1, 3)).toBe(33);
  });
});

describe('CategoriasBarras with credit categories', () => {
  const bar = (over: Partial<CategoriaBarra>): CategoriaBarra => ({
    categoria: 'Crédito',
    valor: -40_000,
    cor: '#123456',
    pct: 1,
    ...over,
  });
  function widthOf(label: string) {
    const row = screen.getByText(label).closest('div')!.parentElement!;
    const fill = row.querySelector<HTMLElement>('[style*="width"]')!;
    return parseFloat(fill.style.width);
  }
  it('renders a signed value with a positive magnitude bar and no share label when the sum is <= 0', () => {
    render(<CategoriasBarras categorias={[bar({ pct: 1 }), bar({ categoria: 'Estorno', valor: -10_000, pct: 0.25 })]} />);
    expect(widthOf('Crédito')).toBe(100);
    expect(widthOf('Estorno')).toBe(25);
    expect(screen.queryByText(/%\)/)).toBeNull();
  });
  it('keeps the 2% floor for tiny magnitudes and never a negative width', () => {
    render(<CategoriasBarras categorias={[bar({ pct: 0 })]} />);
    expect(widthOf('Crédito')).toBe(2);
  });
});
