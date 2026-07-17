import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EditAlertModal } from './EditAlertModal';

// Mock API
vi.mock('@/lib/api', () => ({
  api: {
    patch: vi.fn(),
  },
}));

const mockItem = {
  id: 'item-1',
  title: 'Geladeira',
  productUrl: 'https://example.com',
  targetPriceCents: 250000,
  diasMonitoramento: 30,
  notes: 'Teste',
};

describe('EditAlertModal', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.clearAllMocks();
  });

  it('renders modal with form fields', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <EditAlertModal
          open={true}
          onClose={() => {}}
          item={mockItem}
          projectId="test-project"
        />
      </QueryClientProvider>
    );

    expect(screen.getByLabelText(/título do produto/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/url do produto/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/preço-alvo/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/dias de monitoramento/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/notas/i)).toBeInTheDocument();
  });

  it('initializes form with item data', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <EditAlertModal
          open={true}
          onClose={() => {}}
          item={mockItem}
          projectId="test-project"
        />
      </QueryClientProvider>
    );

    await waitFor(() => {
      const titleInput = screen.getByDisplayValue('Geladeira') as HTMLInputElement;
      expect(titleInput).toBeInTheDocument();
    });
  });

  it('calls PATCH endpoint on save', async () => {
    const { api } = await import('@/lib/api');
    vi.mocked(api.patch).mockResolvedValueOnce({});

    const onClose = vi.fn();

    render(
      <QueryClientProvider client={queryClient}>
        <EditAlertModal
          open={true}
          onClose={onClose}
          item={mockItem}
          projectId="test-project"
        />
      </QueryClientProvider>
    );

    // Wait for form to populate (title should be initialized)
    await waitFor(
      () => {
        const titleInput = screen.getByDisplayValue('Geladeira') as HTMLInputElement;
        expect(titleInput).toBeInTheDocument();
      },
      { timeout: 3000 }
    );

    const saveButton = screen.getByRole('button', { name: /salvar/i });
    await userEvent.click(saveButton);

    // Wait for PATCH to be called
    await waitFor(
      () => {
        expect(vi.mocked(api.patch)).toHaveBeenCalled();
      },
      { timeout: 3000 }
    );
  });

  it('shows cancel button to close modal', async () => {
    const onClose = vi.fn();

    render(
      <QueryClientProvider client={queryClient}>
        <EditAlertModal
          open={true}
          onClose={onClose}
          item={mockItem}
          projectId="test-project"
        />
      </QueryClientProvider>
    );

    const cancelButton = screen.getByRole('button', { name: /cancelar/i });
    await userEvent.click(cancelButton);

    expect(onClose).toHaveBeenCalled();
  });
});
