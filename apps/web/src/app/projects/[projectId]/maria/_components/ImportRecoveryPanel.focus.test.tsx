/**
 * Keyboard focus follows an INTENTIONAL view change (G1, journey focus-gap): when the control that
 * was activated unmounts (row → detail, "Cancelar importação" → confirm, "Manter" → detail, "Voltar"
 * → list) focus must land on a meaningful target instead of <body>. A destructive confirmation must
 * not put focus on "Sim, cancelar", and a data refresh must never move focus.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiResponseError } from '@/lib/api';
import { receiptFixture, summaryFixture, viewFixture } from '../_lib/import-session-fixtures';

const listImportSessions = vi.fn();
const getImportSession = vi.fn();
const getImportResult = vi.fn();
const cancelImportSession = vi.fn();
const apiGet = vi.fn();
vi.mock('../_lib/import-session-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_lib/import-session-api')>()),
  listImportSessions: (...a: unknown[]) => listImportSessions(...a),
  getImportSession: (...a: unknown[]) => getImportSession(...a),
  getImportResult: (...a: unknown[]) => getImportResult(...a),
  cancelImportSession: (...a: unknown[]) => cancelImportSession(...a),
}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: { get: (...a: unknown[]) => apiGet(...a) },
}));
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ user: { id: 'user-a' } }),
}));

import { ImportRecoveryPanel } from './ImportRecoveryPanel';

let client: QueryClient;
const page = (items: unknown[]) => ({
  page: { items, nextCursor: null },
  entry: {
    kind: 'VALID',
    value: { version: 1, kind: 'UNAVAILABLE', reason: 'NOT_ENABLED' },
  },
});
const active = () => document.activeElement as HTMLElement;
const button = (name: string) => screen.getByRole('button', { name });

beforeEach(() => {
  client = new QueryClient();
  for (const fn of [listImportSessions, getImportSession, getImportResult, cancelImportSession, apiGet]) fn.mockReset();
  apiGet.mockResolvedValue([]);
});

async function openDetailByKeyboard(user: ReturnType<typeof userEvent.setup>, view = viewFixture()) {
  listImportSessions.mockResolvedValue(page([summaryFixture()]));
  getImportSession.mockResolvedValue(view);
  const utils = render(
    <QueryClientProvider client={client}>
      <ImportRecoveryPanel />
    </QueryClientProvider>,
  );
  const row = await screen.findByTestId('import-session-row');
  row.focus();
  await user.keyboard('{Enter}');
  await screen.findByRole('heading', { name: /Rascunho guardado/ });
  return utils;
}

/** A REAL re-render of the owner (Panel), with no new focus request: the parent renders again. */
const rerenderPanel = (utils: ReturnType<typeof render>) =>
  utils.rerender(
    <QueryClientProvider client={client}>
      <ImportRecoveryPanel />
    </QueryClientProvider>,
  );

describe('focus follows an intentional transition', () => {
  it('Enter on a row → detail: focus lands in the new view, not on <body>', async () => {
    const user = userEvent.setup();
    await openDetailByKeyboard(user);
    expect(active()).not.toBe(document.body);
    expect(active()).toBe(button('Voltar'));
  });

  it('Enter on Cancelar → confirm: focus goes to the confirmation, NEVER to "Sim, cancelar"', async () => {
    const user = userEvent.setup();
    await openDetailByKeyboard(user);
    button('Cancelar importação').focus();
    await user.keyboard('{Enter}');
    expect(active()).not.toBe(document.body);
    expect(active()).not.toBe(button('Sim, cancelar'));
    expect(active().textContent).toMatch(/não cria lançamentos/);
    await user.tab();
    expect(active()).toBe(button('Manter importação'));
  });

  it('Enter on Manter → detail: focus returns to the control that opened the confirmation', async () => {
    const user = userEvent.setup();
    await openDetailByKeyboard(user);
    button('Cancelar importação').focus();
    await user.keyboard('{Enter}');
    button('Manter importação').focus();
    await user.keyboard('{Enter}');
    expect(active()).toBe(button('Cancelar importação'));
    expect(cancelImportSession).not.toHaveBeenCalled();
  });

  it('Voltar → list: focus returns to the row that was opened', async () => {
    const user = userEvent.setup();
    await openDetailByKeyboard(user);
    button('Voltar').focus();
    await user.keyboard('{Enter}');
    await screen.findByTestId('import-session-row');
    expect(active()).toBe(screen.getByTestId('import-session-row'));
  });

  it('a confirmed cancel announces the outcome and keeps focus inside the panel', async () => {
    const user = userEvent.setup();
    await openDetailByKeyboard(user);
    button('Cancelar importação').focus();
    await user.keyboard('{Enter}');
    cancelImportSession.mockResolvedValue({
      ...viewFixture({ state: 'CANCELLED', actions: [], expiresAt: null }),
      receipt: null,
    });
    getImportSession.mockResolvedValue(viewFixture({ state: 'CANCELLED', actions: [], expiresAt: null }));
    button('Sim, cancelar').focus();
    await user.keyboard('{Enter}');
    await screen.findByText('Importação cancelada.');
    await waitFor(() => expect(active()).not.toBe(document.body));
    expect(active().textContent).toContain('Importação cancelada.');
  });

  it('a failed cancel keeps focus on the visible failure, not on <body>', async () => {
    const user = userEvent.setup();
    await openDetailByKeyboard(user);
    button('Cancelar importação').focus();
    await user.keyboard('{Enter}');
    cancelImportSession.mockRejectedValueOnce(new ApiResponseError('HTTP 500', 500, { statusCode: 500, message: 'x' }));
    button('Sim, cancelar').focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('alert');
    expect(active()).not.toBe(document.body);
    expect(screen.getByRole('alert').closest('[data-focus-key]')).toBe(active());
  });

  it('Ver comprovante → receipt and back: focus never falls to <body>', async () => {
    const user = userEvent.setup();
    listImportSessions.mockResolvedValue(
      page([
        summaryFixture({
          id: 'done',
          state: 'APPLIED',
          actions: ['READ_RESULT'],
          appliedAt: '2026-09-20T02:30:00.000Z',
          expiresAt: null,
        }),
      ]),
    );
    getImportResult.mockResolvedValue(receiptFixture());
    render(
      <QueryClientProvider client={client}>
        <ImportRecoveryPanel />
      </QueryClientProvider>,
    );
    await user.click(await screen.findByRole('button', { name: 'Concluídas' }));
    const row = await screen.findByTestId('import-session-row');
    row.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(getImportResult).toHaveBeenCalled());
    expect(active()).toBe(button('Voltar'));
    await user.keyboard('{Enter}');
    await screen.findByTestId('import-session-row');
    expect(active()).toBe(screen.getByTestId('import-session-row'));
  });
});

describe('a data refresh never steals focus', () => {
  it('refetching the detail while the user sits on a control leaves focus where it was', async () => {
    const user = userEvent.setup();
    await openDetailByKeyboard(user);
    const cancel = button('Cancelar importação');
    cancel.focus();
    await act(async () => {
      await client.invalidateQueries();
    });
    await waitFor(() => expect(getImportSession.mock.calls.length).toBeGreaterThan(1));
    expect(active()).toBe(cancel);
  });

  it('refetching the list while the user sits on a filter leaves focus on that filter', async () => {
    listImportSessions.mockResolvedValue(page([summaryFixture()]));
    render(
      <QueryClientProvider client={client}>
        <ImportRecoveryPanel />
      </QueryClientProvider>,
    );
    await screen.findByTestId('import-session-row');
    const filter = screen.getByRole('button', { name: 'Concluídas' });
    filter.focus();
    await act(async () => {
      await client.invalidateQueries();
    });
    expect(active()).toBe(filter);
  });

  it('a real Panel re-render after the user moved on does not pull focus back to Voltar', async () => {
    const user = userEvent.setup();
    const utils = await openDetailByKeyboard(user);
    const cancel = button('Cancelar importação');
    cancel.focus();
    rerenderPanel(utils);
    await act(async () => {
      await client.invalidateQueries();
    });
    rerenderPanel(utils);
    expect(active()).toBe(cancel);
  });

  it('a real Panel re-render after returning to the list does not pull focus back to the row', async () => {
    const user = userEvent.setup();
    const utils = await openDetailByKeyboard(user);
    button('Voltar').focus();
    await user.keyboard('{Enter}');
    await screen.findByTestId('import-session-row');
    expect(active()).toBe(screen.getByTestId('import-session-row'));
    const filter = screen.getByRole('button', { name: 'Concluídas' });
    filter.focus();
    rerenderPanel(utils);
    expect(active()).toBe(filter);
  });
});
