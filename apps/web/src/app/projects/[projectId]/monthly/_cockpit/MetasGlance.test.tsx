import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MetasGlance } from './MetasGlance';
import type { MetaProgress } from '../../metas/_components/MetaCategoriaCard';

function progress(pct: number, tipo: string): MetaProgress {
  return { tipoDespesa: tipo, limiteCents: 100_000, gastoCents: Math.round(1000 * pct), pct };
}

describe('MetasGlance', () => {
  it('conjunto VAZIO mostra call-to-action pra criar metas, não um grid em branco', () => {
    render(<MetasGlance progress={[]} projectId="p1" />);
    expect(screen.getByText(/nenhuma meta definida/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /criar metas|ver metas/i })).toHaveAttribute(
      'href', '/projects/p1/metas',
    );
  });

  it('mostra até 4 categorias sem indicador de "+N mais"', () => {
    const four = ['A', 'B', 'C', 'D'].map((t, i) => progress(50 + i, t));
    render(<MetasGlance progress={four} projectId="p1" />);
    expect(screen.queryByText(/\+\d+/)).not.toBeInTheDocument();
  });

  it('com 5 categorias, mostra "+1" indicando o restante', () => {
    const five = ['A', 'B', 'C', 'D', 'E'].map((t, i) => progress(50 + i, t));
    render(<MetasGlance progress={five} projectId="p1" />);
    expect(screen.getByText('+1')).toBeInTheDocument();
  });

  it('link "ver metas" aponta pra /metas do projeto', () => {
    render(<MetasGlance progress={[progress(50, 'A')]} projectId="proj-x" />);
    expect(screen.getByRole('link', { name: /ver metas/i })).toHaveAttribute(
      'href', '/projects/proj-x/metas',
    );
  });
});
