import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProjectType } from '@reformaflow/domain';
import { QuickExpenseStep } from './QuickExpenseStep';
import type { OnboardingFunding } from '../../_types';

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

const bankFunding: OnboardingFunding = {
  bankAccount: { kind: 'bankAccount', id: 'ba1', ownerProjectId: 'p1', origin: 'created' },
  creditCard: null,
};
const cardFunding: OnboardingFunding = {
  bankAccount: null,
  creditCard: { kind: 'creditCard', id: 'cc1', ownerProjectId: 'p1', origin: 'created' },
};
const bothFunding: OnboardingFunding = {
  bankAccount: { kind: 'bankAccount', id: 'ba1', ownerProjectId: 'p1', origin: 'created' },
  creditCard: { kind: 'creditCard', id: 'cc1', ownerProjectId: 'p1', origin: 'created' },
};

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

  it('formulário principal NÃO contém selects de conta bancária nem cartão', () => {
    renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone: vi.fn(), onSkip: vi.fn() });
    expect(screen.queryByLabelText(/conta bancária/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^cartão/i)).not.toBeInTheDocument();
  });

  it('"Criar e continuar" desabilitado enquanto valor vazio; habilitado após preencher', () => {
    renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone: vi.fn(), onSkip: vi.fn() });
    const button = screen.getByRole('button', { name: /criar e continuar/i });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: '10,00' } });
    expect(button).not.toBeDisabled();
  });

  it('limite: 0,00 é inválido (botão desabilitado)', () => {
    renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone: vi.fn(), onSkip: vi.fn() });
    fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: '0,00' } });
    expect(screen.getByRole('button', { name: /criar e continuar/i })).toBeDisabled();
  });

  it('limite: 0,01 é válido (botão habilitado)', () => {
    renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone: vi.fn(), onSkip: vi.fn() });
    fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: '0,01' } });
    expect(screen.getByRole('button', { name: /criar e continuar/i })).not.toBeDisabled();
  });

  describe('sem fontes (funding null/vazio)', () => {
    it('clicar Criar e continuar faz POST direto como Carteira (bankAccountId/creditCardId null)', async () => {
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
    });

    it('sem fontes: primeiro continuar NÃO abre tela de fonte', async () => {
      apiPostMock.mockResolvedValue({});
      renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone: vi.fn(), onSkip: vi.fn() });
      fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: '10,00' } });
      fireEvent.click(screen.getByRole('button', { name: /criar e continuar/i }));
      // Tela de fonte não deve aparecer
      expect(screen.queryByText(/como foi pago/i)).not.toBeInTheDocument();
    });
  });

  describe('com fontes (2-screen flow)', () => {
    it('com conta: primeiro continuar abre tela de fonte sem fazer POST', async () => {
      renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone: vi.fn(), onSkip: vi.fn(), funding: bankFunding });
      fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: '10,00' } });
      fireEvent.click(screen.getByRole('button', { name: /criar e continuar/i }));
      await waitFor(() => expect(screen.getByText(/como foi pago/i)).toBeInTheDocument());
      expect(apiPostMock).not.toHaveBeenCalled();
    });

    it('conta: escolher Carteira envia bankAccountId null e creditCardId null', async () => {
      apiPostMock.mockResolvedValue({});
      const onDone = vi.fn();
      renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone, onSkip: vi.fn(), funding: bankFunding });
      fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: '15,00' } });
      fireEvent.click(screen.getByRole('button', { name: /criar e continuar/i }));
      await waitFor(() => expect(screen.getByText(/como foi pago/i)).toBeInTheDocument());
      // Carteira está selecionado por padrão; confirmar
      fireEvent.click(screen.getByRole('button', { name: /confirmar/i }));
      await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith(
        '/projects/p1/expenses',
        expect.objectContaining({ bankAccountId: null, creditCardId: null }),
      ));
      expect(onDone).toHaveBeenCalledTimes(1);
    });

    it('conta: escolher conta envia bankAccountId correto', async () => {
      apiPostMock.mockResolvedValue({});
      apiGetMock.mockImplementation((path: string) => {
        if (path === '/tenant/bank-accounts') return Promise.resolve([{ id: 'ba1', institution: 'NUBANK', last4: '1234', nickname: 'Nu' }]);
        return Promise.resolve([]);
      });
      const onDone = vi.fn();
      renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone, onSkip: vi.fn(), funding: bankFunding });
      fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: '15,00' } });
      fireEvent.click(screen.getByRole('button', { name: /criar e continuar/i }));
      await waitFor(() => screen.getByText(/como foi pago/i));
      // Escolhe conta
      const radio = screen.getByDisplayValue('bankAccount');
      fireEvent.click(radio);
      fireEvent.click(screen.getByRole('button', { name: /confirmar/i }));
      await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith(
        '/projects/p1/expenses',
        expect.objectContaining({ bankAccountId: 'ba1', creditCardId: null }),
      ));
      expect(onDone).toHaveBeenCalledTimes(1);
    });

    it('cartão: escolher cartão envia creditCardId correto', async () => {
      apiPostMock.mockResolvedValue({});
      const onDone = vi.fn();
      renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone, onSkip: vi.fn(), funding: cardFunding });
      fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: '50,00' } });
      fireEvent.click(screen.getByRole('button', { name: /criar e continuar/i }));
      await waitFor(() => screen.getByText(/como foi pago/i));
      const radio = screen.getByDisplayValue('creditCard');
      fireEvent.click(radio);
      fireEvent.click(screen.getByRole('button', { name: /confirmar/i }));
      await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith(
        '/projects/p1/expenses',
        expect.objectContaining({ creditCardId: 'cc1', bankAccountId: null }),
      ));
    });

    it('conta e cartão são mutuamente exclusivos — não envia os dois juntos', async () => {
      apiPostMock.mockResolvedValue({});
      renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone: vi.fn(), onSkip: vi.fn(), funding: bothFunding });
      fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: '10,00' } });
      fireEvent.click(screen.getByRole('button', { name: /criar e continuar/i }));
      await waitFor(() => screen.getByText(/como foi pago/i));
      // Selecionar cartão
      fireEvent.click(screen.getByDisplayValue('creditCard'));
      fireEvent.click(screen.getByRole('button', { name: /confirmar/i }));
      await waitFor(() => {
        const call = apiPostMock.mock.calls[0][1];
        expect(call.bankAccountId).toBeNull();
        expect(call.creditCardId).toBe('cc1');
      });
    });

    it('erro na tela de fonte mantém a tela de fonte visível e não chama onDone', async () => {
      apiPostMock.mockRejectedValue(new Error('Erro de rede'));
      const onDone = vi.fn();
      renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone, onSkip: vi.fn(), funding: bankFunding });
      fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: '10,00' } });
      fireEvent.click(screen.getByRole('button', { name: /criar e continuar/i }));
      await waitFor(() => screen.getByText(/como foi pago/i));
      fireEvent.click(screen.getByRole('button', { name: /confirmar/i }));
      await waitFor(() => expect(screen.getByText('Erro de rede')).toBeInTheDocument());
      expect(onDone).not.toHaveBeenCalled();
      expect(screen.getByText(/como foi pago/i)).toBeInTheDocument();
    });

    it('Voltar na tela de fonte retorna ao formulário', async () => {
      renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone: vi.fn(), onSkip: vi.fn(), funding: bankFunding });
      fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: '10,00' } });
      fireEvent.click(screen.getByRole('button', { name: /criar e continuar/i }));
      await waitFor(() => screen.getByText(/como foi pago/i));
      fireEvent.click(screen.getByRole('button', { name: /voltar/i }));
      expect(screen.getByRole('button', { name: /criar e continuar/i })).toBeInTheDocument();
    });

    it('clique duplo no Confirmar não duplica o POST', async () => {
      apiPostMock.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 100)));
      renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone: vi.fn(), onSkip: vi.fn(), funding: bankFunding });
      fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: '10,00' } });
      fireEvent.click(screen.getByRole('button', { name: /criar e continuar/i }));
      await waitFor(() => screen.getByText(/como foi pago/i));
      const confirm = screen.getByRole('button', { name: /confirmar/i });
      fireEvent.click(confirm);
      fireEvent.click(confirm);
      await waitFor(() => expect(apiPostMock).toHaveBeenCalledTimes(1));
    });
  });

  it('clicking the skip affordance calls onSkip without any api.post call', () => {
    const onSkip = vi.fn();
    renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone: vi.fn(), onSkip });
    fireEvent.click(screen.getByText(/pular por agora/i));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it('api error (sem fontes) keeps the step visible, shows inline error text, does not call onDone', async () => {
    apiPostMock.mockRejectedValue(new Error('Erro ao salvar despesa'));
    const onDone = vi.fn();
    renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone, onSkip: vi.fn() });
    fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: '10,00' } });
    fireEvent.click(screen.getByRole('button', { name: /criar e continuar/i }));

    await waitFor(() => expect(screen.getByText('Erro ao salvar despesa')).toBeInTheDocument());
    expect(onDone).not.toHaveBeenCalled();
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
      mockVoiceSupported = true;
    });

    it('foto mode: clicking Foto shows camera CTA; selecting a file calls onDone without api.post', async () => {
      const onDone = vi.fn();
      renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone, onSkip: vi.fn() });
      fireEvent.click(screen.getByRole('button', { name: /foto/i }));
      await waitFor(() =>
        expect(screen.getByText(/fotografe o comprovante/i)).toBeInTheDocument(),
      );
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      expect(input).not.toBeNull();
      fireEvent.change(input, {
        target: { files: [new File(['img'], 'receipt.jpg', { type: 'image/jpeg' })] },
      });
      expect(onDone).toHaveBeenCalledTimes(1);
      expect(apiPostMock).not.toHaveBeenCalled();
    });

    it('voz mode: clicking Voz renders VoiceExpenseModal stub', () => {
      mockVoiceSupported = true;
      renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone: vi.fn(), onSkip: vi.fn() });
      fireEvent.click(screen.getByRole('button', { name: /voz/i }));
      expect(screen.getByTestId('voice-expense-modal')).toBeInTheDocument();
      fireEvent.click(screen.getByText('fechar-modal-voz'));
      expect(screen.queryByTestId('voice-expense-modal')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /criar e continuar/i })).toBeInTheDocument();
    });
  });
});
