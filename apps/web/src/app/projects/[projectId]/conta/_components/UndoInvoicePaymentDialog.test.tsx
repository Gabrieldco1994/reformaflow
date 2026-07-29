import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { UndoInvoicePaymentDialog } from './UndoInvoicePaymentDialog';
import type { AccountViewCardSummary } from '../_types';

const { apiPost, MockApiResponseError } = vi.hoisted(() => {
  class MockApiResponseError extends Error {
    constructor(message: string, public readonly status: number, public readonly body?: unknown) {
      super(message);
      this.name = 'ApiResponseError';
    }
  }
  return { apiPost: vi.fn(), MockApiResponseError };
});

vi.mock('@/lib/api', () => ({
  api: {
    post: (...args: unknown[]) => apiPost(...args),
  },
  ApiResponseError: MockApiResponseError,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function makeCard(overrides: Partial<AccountViewCardSummary> = {}): AccountViewCardSummary {
  return {
    nickname: 'Nubank',
    last4: '1234',
    faturaAtual: 100_00,
    faturaPendente: 0,
    faturaPaga: 100_00,
    residualDeclarado: 0,
    possuiIntervencaoManual: false,
    ajusteManualTotal: 0,
    dueMonth: '2026-07',
    vencimento: '2026-07-20',
    status: 'paga',
    limiteUsadoPct: null,
    limiteUsado: null,
    limiteTotal: null,
    ...overrides,
  };
}

function renderDialog(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <UndoInvoicePaymentDialog projectId="p1" card={makeCard()} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { ...utils, onClose };
}

describe('UndoInvoicePaymentDialog — diálogo destrutivo', () => {
  it('expõe role="dialog" modal rotulado pelo título', () => {
    renderDialog();

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Desfazer pagamento');
  });

  it('dá foco inicial à ação segura (Cancelar), nunca à destrutiva', () => {
    renderDialog();

    expect(screen.getByRole('button', { name: 'Cancelar' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Desfazer pagamento' })).not.toHaveFocus();
  });

  it('fecha com Escape sem disparar a mutação', () => {
    const { onClose } = renderDialog();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('prende o Tab dentro do diálogo (não vaza para a página atrás)', () => {
    renderDialog();

    const dialog = screen.getByRole('dialog');
    const fechar = screen.getByRole('button', { name: 'Fechar' });
    const desfazer = screen.getByRole('button', { name: 'Desfazer pagamento' });

    // Tab no último foco volta para o primeiro.
    desfazer.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(fechar).toHaveFocus();

    // Shift+Tab no primeiro foco vai para o último.
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(desfazer).toHaveFocus();
  });

  it('devolve o foco ao gatilho quando o diálogo fecha', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Desfazer';
    document.body.appendChild(trigger);
    trigger.focus();
    expect(trigger).toHaveFocus();

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = render(
      <QueryClientProvider client={client}>
        <UndoInvoicePaymentDialog projectId="p1" card={makeCard()} onClose={vi.fn()} />
      </QueryClientProvider>,
    );
    expect(trigger).not.toHaveFocus();

    unmount();

    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it('num 400 de ambiguidade, mostra os pagamentos casados (data+valor) em vez de um beco sem saída', async () => {
    apiPost.mockRejectedValueOnce(
      new MockApiResponseError('Há mais de um pagamento para essa fatura', 400, {
        message: 'Há mais de um pagamento para essa fatura',
        payments: [
          { id: 'pay-1', amountCents: 5_000, data: '2026-05-20T00:00:00.000Z' },
          { id: 'pay-2', amountCents: 3_000, data: '2026-05-22T00:00:00.000Z' },
        ],
      }),
    );
    renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Desfazer pagamento' }));

    expect(await screen.findByText('R$ 50,00')).toBeInTheDocument();
    expect(screen.getByText('R$ 30,00')).toBeInTheDocument();
    // A ação automática some — o usuário só pode fechar e agir manualmente.
    expect(screen.queryByRole('button', { name: 'Desfazer pagamento' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Entendi' })).toBeInTheDocument();
  });
});
