import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DocumentedSchedule } from './DocumentedSchedule';

// Rode com `TZ=UTC` e `TZ=America/Sao_Paulo`: o dia-calendário financeiro é a
// data YYYY-MM-DD do cronograma e não pode depender do fuso do navegador.
describe('DocumentedSchedule — dia-calendário independente do fuso (#701)', () => {
  const expense = {
    valorTotal: 30_000,
    formaPagamento: 'PARCELADO',
    quantidadeParcela: 3,
    dataPagamento: null,
    dataInicioParcela: '2026-09-01',
    installmentDateOverrides: '{"1":"2026-10-31"}',
    schedule: {
      version: 1 as const,
      occurrences: [
        { index: 0, parcela: '1/3', valor: 10_001, data: '2026-09-20', invoiceDueMonth: '2026-10' },
        { index: 1, parcela: '2/3', valor: 10_000, data: '2026-10-01', invoiceDueMonth: null },
        { index: 2, parcela: '3/3', valor: 9_999, data: '2027-01-01', invoiceDueMonth: null },
      ],
    },
  };

  it('mostra 20/09 para 2026-09-20 (não 19/09 em BRT), com override, virada de ano e centavos', () => {
    render(<DocumentedSchedule expense={expense} />);
    expect(screen.getByText(/Parcela 1\/3 · 20\/09\/2026/)).toBeInTheDocument();
    expect(screen.getByText(/Parcela 2\/3 · 31\/10\/2026/)).toBeInTheDocument();
    expect(screen.getByText(/Parcela 3\/3 · 01\/01\/2027/)).toBeInTheDocument();
    expect(screen.getByText('Fatura 2026-10')).toBeInTheDocument();
    expect(screen.getByText(/R\$\s*100,01/)).toBeInTheDocument();
    expect(screen.getByText(/R\$\s*99,99/)).toBeInTheDocument();
  });
});
