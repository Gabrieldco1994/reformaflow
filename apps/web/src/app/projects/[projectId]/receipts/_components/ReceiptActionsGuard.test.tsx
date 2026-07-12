import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MobileReceiptList } from './MobileReceiptList';

const grouped = [{
  tipo: 'ALOCACAO_ORCAMENTO',
  label: 'Alocação de Orçamento',
  items: [{ id: 'alloc-xyz', valor: 50_000, data: '2026-07-01', status: 'EM_CAIXA' }],
  total: 50_000, totalEmCaixa: 50_000, totalPrevisto: 0,
}];

describe('MobileReceiptList — alloc-* read-only gate', () => {
  it('never renders Editar/Excluir for synthetic alloc-* rows', () => {
    render(
      <MobileReceiptList
        grouped={grouped as any}
        collapsedTipos={new Set()}
        toggleTipo={vi.fn()}
        openEdit={vi.fn()}
        onDelete={vi.fn()}
        emptyMsg=""
      />,
    );
    expect(screen.queryByRole('button', { name: 'Editar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Excluir' })).not.toBeInTheDocument();
  });

  it('still renders Editar/Excluir for real receipt rows (non-alloc)', () => {
    const realGrouped = [{ ...grouped[0], items: [{ id: 'real-1', valor: 1000, data: '2026-07-01', status: 'PREVISTO' }] }];
    render(
      <MobileReceiptList grouped={realGrouped as any} collapsedTipos={new Set()} toggleTipo={vi.fn()} openEdit={vi.fn()} onDelete={vi.fn()} emptyMsg="" />,
    );
    expect(screen.getByRole('button', { name: 'Editar' })).toBeInTheDocument();
  });
});
