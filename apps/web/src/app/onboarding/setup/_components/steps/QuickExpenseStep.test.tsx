import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProjectType } from '@reformaflow/domain';
import { QuickExpenseStep } from './QuickExpenseStep';

// Stub VoiceExpenseModal so voice tests don't need full Modal/Speech setup
vi.mock(
  '@/app/projects/[projectId]/expenses/_components/VoiceExpenseModal',
  () => ({
    VoiceExpenseModal: ({ open, onClose }: { open: boolean; onClose: () => void }) =>
      open ? (
        <div data-testid="voice-expense-modal">
          <button onClick={onClose}>fechar-modal-voz</button>
        </div>
      ) : null,
  }),
);

// Stub useVoiceExpense — voiceSupported toggleable via module-level variable
let mockVoiceSupported = true;
vi.mock(
  '@/app/projects/[projectId]/expenses/_hooks/useVoiceExpense',
  () => ({
    useVoiceExpense: () => ({
      voiceModalOpen: false,
      voiceSupported: mockVoiceSupported,
      voiceListening: false,
      voiceTranscript: '',
      voiceError: '',
      voiceData: null,
      setVoiceData: vi.fn(),
      voiceFornecedor: '',
      setVoiceFornecedor: vi.fn(),
      voiceLinkedExpenseId: '',
      setVoiceLinkedExpenseId: vi.fn(),
      voiceLinkedProject: null,
      openVoiceModal: vi.fn(),
      closeVoiceModal: vi.fn(),
      clearVoiceTranscript: vi.fn(),
      startVoiceCapture: vi.fn(),
      saveVoiceExpense: vi.fn(),
    }),
  }),
);

const apiPostMock = vi.fn();
const apiGetMock = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    post: (...args: unknown[]) => apiPostMock(...args),
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));
function renderStep(props: React.ComponentProps<typeof QuickExpenseStep>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <QuickExpenseStep {...props} />
    </QueryClientProvider>,
  );
}

describe('QuickExpenseStep', () => {
  beforeEach(() => {
    apiPostMock.mockReset();
    apiGetMock.mockReset();
    apiGetMock.mockResolvedValue([]);
  });

  it('renders tipo options from getExpenseOptions(projectType) — different sets for REFORMA vs PESSOAL', () => {
    const { unmount } = renderStep(
      { projectId: 'p1', projectType: ProjectType.REFORMA, onDone: vi.fn(), onSkip: vi.fn() },
    );
    const reformaOptions = screen.getAllByRole('option').map((o) => o.textContent);
    unmount();

    renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone: vi.fn(), onSkip: vi.fn() });
    const pessoalOptions = screen.getAllByRole('option').map((o) => o.textContent);

    expect(reformaOptions).not.toEqual(pessoalOptions);
  });

  it('"Criar e continuar" disabled while valor is empty; enabled once a valor is typed', () => {
    renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone: vi.fn(), onSkip: vi.fn() });
    const button = screen.getByRole('button', { name: /criar e continuar/i });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: '10,00' } });
    expect(button).not.toBeDisabled();
  });

  it('submits POST /projects/:id/expenses with the expected shape, then calls onDone', async () => {
    apiPostMock.mockResolvedValue({});
    const onDone = vi.fn();
    renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone, onSkip: vi.fn() });
    fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: '10,00' } });
    fireEvent.click(screen.getByRole('button', { name: /criar e continuar/i }));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith(
      '/projects/p1/expenses',
      expect.objectContaining({
        valor: 10,
        quantidade: 1,
        formaPagamento: 'A_VISTA',
        status: 'PAGO',
        creditCardId: null,
        bankAccountId: null,
      }),
    ));
    expect(onDone).toHaveBeenCalledTimes(1);
    // Propaga a despesa criada (tipo + label da categoria) para habilitar o
    // MariaInsightStep — o label vem de getExpenseOptions, não é recriado aqui.
    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({
        createdExpense: expect.objectContaining({ categoriaLabel: expect.any(String) }),
      }),
    );
  });

  it('clicking the skip affordance calls onSkip without any api.post call', () => {
    const onSkip = vi.fn();
    renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone: vi.fn(), onSkip });
    fireEvent.click(screen.getByText(/pular por agora/i));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it('api error keeps the step visible, shows inline error text, does not call onDone', async () => {
    apiPostMock.mockRejectedValue(new Error('Erro ao salvar despesa'));
    const onDone = vi.fn();
    renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone, onSkip: vi.fn() });
    fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: '10,00' } });
    fireEvent.click(screen.getByRole('button', { name: /criar e continuar/i }));

    await waitFor(() => expect(screen.getByText('Erro ao salvar despesa')).toBeInTheDocument());
    expect(onDone).not.toHaveBeenCalled();
  });

  it('shows conta/cartão selects for PESSOAL (has bankAccounts/creditCards features), fetched from tenant-wide endpoints', async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === '/tenant/bank-accounts') return Promise.resolve([{ id: 'ba1', nickname: 'Nubank', institution: 'Nubank' }]);
      if (path === '/tenant/credit-cards') return Promise.resolve([{ id: 'cc1', nickname: null, brand: 'Visa', last4: '1234' }]);
      return Promise.resolve([]);
    });
    renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone: vi.fn(), onSkip: vi.fn() });

    await waitFor(() => expect(screen.getByText('Nubank')).toBeInTheDocument());
    expect(screen.getByText('Visa ••1234')).toBeInTheDocument();
  });

  it('hides conta/cartão selects for REFORMA (no bankAccounts/creditCards feature)', () => {
    renderStep({ projectId: 'p1', projectType: ProjectType.REFORMA, onDone: vi.fn(), onSkip: vi.fn() });
    expect(screen.queryByLabelText(/conta bancária/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^cartão$/i)).not.toBeInTheDocument();
  });

  it('submits the chosen creditCardId/bankAccountId when selected', async () => {
    apiPostMock.mockResolvedValue({});
    apiGetMock.mockImplementation((path: string) => {
      if (path === '/tenant/bank-accounts') return Promise.resolve([{ id: 'ba1', nickname: 'Nubank', institution: 'Nubank' }]);
      if (path === '/tenant/credit-cards') return Promise.resolve([]);
      return Promise.resolve([]);
    });
    renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone: vi.fn(), onSkip: vi.fn() });

    await waitFor(() => expect(screen.getByText('Nubank')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: '10,00' } });
    fireEvent.change(screen.getByLabelText(/conta bancária/i), { target: { value: 'ba1' } });
    fireEvent.click(screen.getByRole('button', { name: /criar e continuar/i }));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith(
      '/projects/p1/expenses',
      expect.objectContaining({ bankAccountId: 'ba1', creditCardId: null }),
    ));
  });

  describe('mode picker', () => {
    it('shows Despesa and Foto mode buttons; Voz shown when voiceSupported=true', () => {
      mockVoiceSupported = true;
      renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone: vi.fn(), onSkip: vi.fn() });
      expect(screen.getByRole('button', { name: /despesa/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /voz/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /foto/i })).toBeInTheDocument();
    });

    it('hides Voz button when voiceSupported=false', () => {
      mockVoiceSupported = false;
      renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone: vi.fn(), onSkip: vi.fn() });
      expect(screen.queryByRole('button', { name: /voz/i })).not.toBeInTheDocument();
      // Restore for other tests
      mockVoiceSupported = true;
    });

    it('foto mode: clicking Foto shows camera CTA; selecting a file calls onDone without api.post', async () => {
      const onDone = vi.fn();
      renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone, onSkip: vi.fn() });

      fireEvent.click(screen.getByRole('button', { name: /foto/i }));

      // Camera CTA visible
      await waitFor(() =>
        expect(screen.getByText(/fotografe o comprovante/i)).toBeInTheDocument(),
      );

      // Simulate file selection on the hidden input
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      expect(input).not.toBeNull();
      fireEvent.change(input, {
        target: { files: [new File(['img'], 'receipt.jpg', { type: 'image/jpeg' })] },
      });

      expect(onDone).toHaveBeenCalledTimes(1);
      expect(apiPostMock).not.toHaveBeenCalled();
    });

    it('despesa mode: original form still submits correctly (regression)', async () => {
      mockVoiceSupported = true;
      apiPostMock.mockResolvedValue({});
      const onDone = vi.fn();
      renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone, onSkip: vi.fn() });

      // Should be in despesa mode by default
      expect(screen.getByRole('button', { name: /criar e continuar/i })).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: '25,00' } });
      fireEvent.click(screen.getByRole('button', { name: /criar e continuar/i }));

      await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith(
        '/projects/p1/expenses',
        expect.objectContaining({ valor: 25 }),
      ));
      expect(onDone).toHaveBeenCalledTimes(1);
    });

    it('voz mode: clicking Voz renders VoiceExpenseModal stub', () => {
      mockVoiceSupported = true;
      renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone: vi.fn(), onSkip: vi.fn() });

      fireEvent.click(screen.getByRole('button', { name: /voz/i }));

      expect(screen.getByTestId('voice-expense-modal')).toBeInTheDocument();

      // Closing modal falls back to despesa mode gracefully
      fireEvent.click(screen.getByText('fechar-modal-voz'));
      expect(screen.queryByTestId('voice-expense-modal')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /criar e continuar/i })).toBeInTheDocument();
    });
  });
});
