import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ComprometimentoFuturo from './ComprometimentoFuturo';
import type { ComprometimentoMes } from './derive';

const ROWS: ComprometimentoMes[] = [
  {
    mes: '2026-08',
    total: 350_000,
    itens: [
      { descricao: 'Notebook', parcela: '3/10', valor: 200_000, cardLast4: '1234' },
      { descricao: 'Curso', parcela: null, valor: 150_000, cardLast4: '9999' },
    ],
  },
  {
    mes: '2026-09',
    total: 200_000,
    itens: [
      { descricao: 'Notebook', parcela: '4/10', valor: 200_000, cardLast4: '1234' },
    ],
  },
];

describe('ComprometimentoFuturo', () => {
  it('filtra os valores por cartão quando o usuário seleciona um cartão específico', () => {
    render(<ComprometimentoFuturo rows={ROWS} />);

    fireEvent.click(screen.getByRole('button', { name: '••9999' }));

    expect(screen.getAllByText(/R\$ 1\.500/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Notebook/)).not.toBeInTheDocument();
    expect(screen.getByText(/Curso/)).toBeInTheDocument();
  });
});
