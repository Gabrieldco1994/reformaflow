import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProjectType } from '@reformaflow/domain';
import { QuickExpenseStep } from './QuickExpenseStep';
import type { OnboardingFunding } from '../_types';

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

// Stub useVoiceExpense — voiceSupported toggleable via module-level variable.
// `capturedVoiceConfig` guarda o objeto que o componente passa ao hook, para os
// testes poderem exercitar o `onCreate` REAL (o que salva a despesa por voz) em
// vez de só verificar que o botão existe. Sem isso, o mock esconderia justamente
// o caminho onde os bugs D e E viviam.
let capturedVoiceConfig: {
  onCreate?: (data: unknown, onSuccess: () => void) => void;
  defaultExpenseType?: string;
} = {};
let mockVoiceSupported = true;
vi.mock(
  '@/app/projects/[projectId]/expenses/_hooks/useVoiceExpense',
  () => ({
    useVoiceExpense: (config: Record<string, unknown>) => {
      capturedVoiceConfig = config as typeof capturedVoiceConfig;
      return {
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
      };
    },
  }),
);

const apiPostMock = vi.fn();
const apiGetMock = vi.fn();
const apiUploadMock = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    post: (...args: unknown[]) => apiPostMock(...args),
    get: (...args: unknown[]) => apiGetMock(...args),
    upload: (...args: unknown[]) => apiUploadMock(...args),
  },
}));

// #218 (W5): o gate `hasFeature(type,'bankAccounts') && hasModule('bankAccounts')`
// decide se a query `['tenant','bank-accounts']` sequer dispara. Default true — a
// metade `hasFeature` é o eixo por tipo; os casos que provam `hasModule` sobrescrevem.
let mockHasModule: (slug: string) => boolean = () => true;
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ user: { name: 'Teste' }, hasModule: (slug: string) => mockHasModule(slug) }),
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
    apiUploadMock.mockReset();
    apiGetMock.mockResolvedValue([]);
    mockHasModule = () => true;
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

    it('foto mode: envia a imagem para OCR e preenche o formulário para conferência (não salva sozinho)', async () => {
      const onDone = vi.fn();
      apiUploadMock.mockResolvedValueOnce({
        valorCents: 8990,
        fornecedor: 'Padaria Central',
        descricao: 'pães e leite',
        data: '2026-07-15',
      });

      renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone, onSkip: vi.fn() });
      fireEvent.click(screen.getByRole('button', { name: /foto/i }));
      await waitFor(() =>
        expect(screen.getByText(/fotografe o comprovante/i)).toBeInTheDocument(),
      );
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      fireEvent.change(input, {
        target: { files: [new File(['img'], 'receipt.jpg', { type: 'image/jpeg' })] },
      });

      // Antes isto era um stub: só chamava `onDone()` e nada era enviado nem
      // salvo. Agora a imagem vai para o OCR...
      await waitFor(() =>
        expect(apiUploadMock).toHaveBeenCalledWith(
          '/projects/p1/expenses/scan-receipt',
          expect.any(FormData),
          expect.objectContaining({ timeoutMs: expect.any(Number) }),
        ),
      );

      // ...e o que a IA leu cai nos campos para o usuário CONFERIR. Gravar
      // direto a partir de OCR seria dinheiro entrando no consolidado sem
      // ninguém ter olhado o valor.
      await waitFor(() =>
        expect(screen.getByDisplayValue('89,90')).toBeInTheDocument(),
      );
      expect(screen.getByDisplayValue('pães e leite')).toBeInTheDocument();
      expect(screen.getByDisplayValue('2026-07-15')).toBeInTheDocument();

      // O passo NÃO avança e NADA foi salvo — a confirmação é do usuário.
      expect(onDone).not.toHaveBeenCalled();
      expect(apiPostMock).not.toHaveBeenCalled();
    });

    it('foto mode: valor ilegível avisa e mantém os demais campos lidos', async () => {
      apiUploadMock.mockResolvedValueOnce({
        valorCents: null,
        fornecedor: 'Posto Shell',
        descricao: null,
        data: '2026-07-10',
      });

      renderStep({
        projectId: 'p1',
        projectType: ProjectType.PESSOAL,
        onDone: vi.fn(),
        onSkip: vi.fn(),
      });
      fireEvent.click(screen.getByRole('button', { name: /foto/i }));
      await waitFor(() =>
        expect(screen.getByText(/fotografe o comprovante/i)).toBeInTheDocument(),
      );
      fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
        target: { files: [new File(['img'], 'r.jpg', { type: 'image/jpeg' })] },
      });

      // Obrigar a redigitar tudo por causa de um campo seria pior que o OCR
      // não existir: o que foi lido é preservado.
      await waitFor(() =>
        expect(screen.getByText(/não consegui ler o valor/i)).toBeInTheDocument(),
      );
      expect(screen.getByDisplayValue('Posto Shell')).toBeInTheDocument();
      expect(screen.getByDisplayValue('2026-07-10')).toBeInTheDocument();
    });

    it('foto mode: falha na leitura mostra o erro e não avança o passo', async () => {
      const onDone = vi.fn();
      apiUploadMock.mockRejectedValueOnce(new Error('A leitura da foto demorou demais'));

      renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone, onSkip: vi.fn() });
      fireEvent.click(screen.getByRole('button', { name: /foto/i }));
      await waitFor(() =>
        expect(screen.getByText(/fotografe o comprovante/i)).toBeInTheDocument(),
      );
      fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
        target: { files: [new File(['img'], 'r.jpg', { type: 'image/jpeg' })] },
      });

      await waitFor(() =>
        expect(screen.getByText(/a leitura da foto demorou demais/i)).toBeInTheDocument(),
      );
      expect(onDone).not.toHaveBeenCalled();
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

  /**
   * Bugs D e E, ambos no caminho de VOZ e ambos invisíveis para os testes
   * antigos: o mock do `useVoiceExpense` escondia o `onCreate`, então dava para
   * verificar que o botão de voz existia sem nunca exercitar o que ele faz.
   */
  describe('lançamento por voz — erro e categoria (bugs D e E)', () => {
    it('E: fallback de categoria é OUTROS, não o primeiro da lista (que em PESSOAL é CARTAO_CREDITO, tipo neutro)', () => {
      renderStep({
        projectId: 'p1',
        projectType: ProjectType.PESSOAL,
        onDone: vi.fn(),
        onSkip: vi.fn(),
      });

      // CARTAO_CREDITO é o primeiro de `getExpenseOptions(PESSOAL)` e tem
      // `essentiality: 'NEUTRO'` — existe para pagamento de fatura. Uma despesa
      // que a voz não classificou não pode nascer com ele.
      expect(capturedVoiceConfig.defaultExpenseType).toBe('OUTROS');
      expect(capturedVoiceConfig.defaultExpenseType).not.toBe('CARTAO_CREDITO');
    });

    it('E: em tipo de projeto SEM a categoria OUTROS (REFORMA), cai no primeiro válido em vez de um tipo inexistente', () => {
      renderStep({
        projectId: 'p1',
        projectType: ProjectType.REFORMA,
        onDone: vi.fn(),
        onSkip: vi.fn(),
      });

      // REFORMA não oferece OUTROS: forçá-lo produziria um tipo inválido para o
      // projeto — trocaria um bug por outro.
      expect(capturedVoiceConfig.defaultExpenseType).toBe('MATERIAL_CONSTRUCAO');
    });

    it('D: falha ao salvar por voz mostra erro e NÃO avança o passo', async () => {
      const onDone = vi.fn();
      apiPostMock.mockRejectedValueOnce(new Error('Erro de validação da API'));

      renderStep({
        projectId: 'p1',
        projectType: ProjectType.PESSOAL,
        onDone,
        onSkip: vi.fn(),
      });

      const onSuccess = vi.fn();
      capturedVoiceConfig.onCreate?.({ tipoDespesa: 'OUTROS', valor: 100 }, onSuccess);

      // Antes: `.catch(() => {})` — o erro sumia, o passo avançava, e o usuário
      // só descobria depois que nada tinha sido salvo.
      await waitFor(() =>
        expect(screen.getByText('Erro de validação da API')).toBeInTheDocument(),
      );
      expect(onDone).not.toHaveBeenCalled();
      expect(onSuccess).not.toHaveBeenCalled();
    });

    it('D: sucesso por voz avança o passo e propaga a categoria criada', async () => {
      const onDone = vi.fn();
      apiPostMock.mockResolvedValueOnce({ id: 'e1' });

      renderStep({
        projectId: 'p1',
        projectType: ProjectType.PESSOAL,
        onDone,
        onSkip: vi.fn(),
      });

      const onSuccess = vi.fn();
      capturedVoiceConfig.onCreate?.({ tipoDespesa: 'ALIMENTACAO', valor: 100 }, onSuccess);

      await waitFor(() => expect(onSuccess).toHaveBeenCalled());
      expect(onDone).toHaveBeenCalledWith(
        expect.objectContaining({
          createdExpense: expect.objectContaining({ tipoDespesa: 'ALIMENTACAO' }),
        }),
      );
    });
  });

/**
 * #218 (W5) — a query de contexto `['tenant','bank-accounts']` no passo de
 * despesa do onboarding disparava `GET /tenant/bank-accounts` em QUALQUER tipo
 * de projeto. Em REFORMA/COMPRA isso é 403 silencioso (bankAccounts não é
 * feature nem módulo). Gate: `hasFeature(type,'bankAccounts') && hasModule(...)`.
 */
describe('QuickExpenseStep — gate da query de contas do tenant (#218)', () => {
  beforeEach(() => {
    apiPostMock.mockReset();
    apiGetMock.mockReset();
    apiUploadMock.mockReset();
    apiGetMock.mockResolvedValue([]);
    mockHasModule = () => true;
  });

  const chamouTenantAccounts = () =>
    apiGetMock.mock.calls.some((c) => c[0] === '/tenant/bank-accounts');

  it('REFORMA: NÃO dispara GET /tenant/bank-accounts (feature ausente)', async () => {
    renderStep({ projectId: 'p1', projectType: ProjectType.REFORMA, onDone: vi.fn(), onSkip: vi.fn() });
    await Promise.resolve();
    expect(chamouTenantAccounts()).toBe(false);
  });

  it('PESSOAL + hasModule("bankAccounts") true: dispara a query', async () => {
    mockHasModule = () => true;
    renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone: vi.fn(), onSkip: vi.fn() });
    await waitFor(() => expect(chamouTenantAccounts()).toBe(true));
  });

  it('PESSOAL mas hasModule("bankAccounts") false: NÃO dispara (trava a forma hasFeature && hasModule)', async () => {
    mockHasModule = (slug) => slug !== 'bankAccounts';
    renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone: vi.fn(), onSkip: vi.fn() });
    await Promise.resolve();
    expect(chamouTenantAccounts()).toBe(false);
  });
});
