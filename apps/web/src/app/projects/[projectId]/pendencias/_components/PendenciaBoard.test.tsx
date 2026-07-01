import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PendenciaBoard } from './PendenciaBoard';

const mocks = vi.hoisted(() => ({
  usePendenciasQuery: vi.fn(),
  useRoomsQuery: vi.fn(() => ({ data: [] })),
  useScheduleTasksQuery: vi.fn(() => ({ data: [] })),
  useCreatePendencia: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useUpdatePendencia: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useDeletePendencia: vi.fn(() => ({ mutate: vi.fn() })),
  useMovePendencia: vi.fn(() => ({ mutate: vi.fn() })),
}));

vi.mock('../_hooks/usePendencias', () => mocks);
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe('PendenciaBoard', () => {
  beforeEach(() => {
    mocks.usePendenciasQuery.mockReturnValue({ data: [], isLoading: false, error: null });
  });

  it('renders all 4 Kanban columns with PT-BR labels', () => {
    render(<PendenciaBoard projectId="p1" />);
    for (const label of ['Pendente', 'Em andamento', 'Parado', 'Concluído']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('renders the "Nova pendência" button', () => {
    render(<PendenciaBoard projectId="p1" />);
    expect(screen.getByText('Nova pendência')).toBeInTheDocument();
  });

  it('shows a card title when there are pendências', () => {
    mocks.usePendenciasQuery.mockReturnValue({
      data: [
        {
          id: 'a',
          projectId: 'p1',
          title: 'Comprar tinta',
          description: null,
          status: 'ANDAMENTO',
          dueDate: null,
          owner: 'João',
          roomId: null,
          roomName: null,
          scheduleTaskId: null,
          scheduleTaskNome: null,
          scheduleTaskNumero: null,
          order: 0,
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01',
        },
      ],
      isLoading: false,
      error: null,
    });
    render(<PendenciaBoard projectId="p1" />);
    expect(screen.getByText('Comprar tinta')).toBeInTheDocument();
    expect(screen.getByText('João')).toBeInTheDocument();
  });
});
