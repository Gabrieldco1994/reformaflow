import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MariaPage from './page';
import { setPendingMariaPrompt, consumePendingMariaPrompt } from './_lib/pending-prompt';
import { ProjectProvider } from '@/contexts/project-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IMPORT_CSV_PROMPT, IMPORT_CSV_CTA_LABEL } from './_components/MariaDock';

// Contrato de view: a página Maria reusa `useFinancialAgent`/`useSpeechRecognition`
// (nenhuma nova instância de STT/TTS aqui) e ganha um CTA explícito e acessível
// "Iniciar conversa por voz" que abre `VoiceAssistantOverlay` — o microfone
// one-shot do dock e o botão "Ouvir" de cada resposta seguem como fallback.
//
// Issue #521: o "Voltar" do header (`aria-label="Voltar para hoje"`) não pode
// apontar direto para `/monthly` — `/maria` não é slug de `PROJECT_NAV`, então
// `AppShell` nunca bloqueia a rota por permissão, e um usuário sem o módulo
// `monthlyOverview` chegaria aqui e cairia em `/no-permission` ao voltar. Os
// testes abaixo controlam `hasModule` via mock do contexto real de auth
// (não uma cópia da lógica) para prová-lo com o componente de verdade.

const hasModuleMock = vi.fn((_slug: string) => true);

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ user: { id: 'user-1' }, hasModule: (slug: string) => hasModuleMock(slug) }),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ projectId: 'project-1' }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/projects/project-1/maria',
  useSearchParams: () => new URLSearchParams(),
}));

// A retomada/listagem de importações tem testes próprios; aqui só o contrato da
// tela Maria (entrada descobrível e única).
vi.mock('./_hooks/useImportSessions', () => ({
  useImportUserId: () => 'user-1',
  useImportSessionList: () => ({ entry: null, failure: null, status: 'ready', restart: vi.fn() }),
}));
vi.mock('./_hooks/useImportDocumentFlow', () => ({
  useImportDocumentFlow: () => ({
    sessionId: null,
    hasAttempt: false,
    canRetry: false,
    canResume: false,
    view: null,
    error: null,
    busy: false,
    invalidate: vi.fn(),
  }),
}));

function renderMariaPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ProjectProvider value={{ projectId: 'project-1', projectType: 'PESSOAL', projectName: 'Pessoal' }}>
        <MariaPage />
      </ProjectProvider>
    </QueryClientProvider>,
  );
}

// jsdom não implementa `Element.scrollTo` — a página usa isso para rolar o
// histórico de mensagens ao fundo. Stub mínimo só para montar em teste
// unitário (mesmo padrão do polyfill de ResizeObserver em vitest.setup.ts).
if (typeof HTMLElement.prototype.scrollTo !== 'function') {
  HTMLElement.prototype.scrollTo = function scrollToStub() {};
}

const { agentSend, speechStart, speechStop, streamSpeak, ttsStop } = vi.hoisted(() => ({
  agentSend: vi.fn(),
  speechStart: vi.fn(),
  speechStop: vi.fn(),
  streamSpeak: vi.fn(),
  ttsStop: vi.fn(),
}));
let agentMessages: Array<{ role: 'assistant'; content: string }> = [];
vi.mock('@/components/agent/useFinancialAgent', () => ({
  useFinancialAgent: () => ({ messages: agentMessages, loading: false, send: agentSend }),
}));

vi.mock('@/components/agent/useSpeechRecognition', () => ({
  useSpeechRecognition: () => ({
    supported: true,
    listening: false,
    start: speechStart,
    stop: speechStop,
  }),
}));

streamSpeak.mockImplementation(() => ({ stop: ttsStop }));
vi.mock('@/lib/streaming-tts', () => ({
  isStreamingTtsSupported: () => true,
  streamSpeak,
}));

vi.mock('./_hooks/useMariaOpening', () => ({
  useMariaOpening: () => ({ message: null, loading: false }),
}));

vi.mock('../_components/mobile-launch/MobileLaunchSheetContainer', () => ({
  MobileLaunchSheetContainer: () => null,
}));

let lastVoiceOverlayProps: { send: unknown; autoStart?: boolean; onClose: () => void } | null = null;
vi.mock('@/components/agent/VoiceAssistantOverlay', () => ({
  VoiceAssistantOverlay: (props: { send: unknown; autoStart?: boolean; onClose: () => void }) => {
    lastVoiceOverlayProps = props;
    return (
      <div data-testid="voice-assistant-overlay">
        <button type="button" onClick={props.onClose}>
          Fechar overlay
        </button>
      </div>
    );
  },
}));

describe('MariaPage', () => {
  beforeEach(() => {
    agentMessages = [];
    speechStop.mockClear();
    speechStart.mockClear();
    agentSend.mockClear();
    streamSpeak.mockClear();
    ttsStop.mockClear();
    sessionStorage.clear();
    hasModuleMock.mockReset();
    hasModuleMock.mockReturnValue(true);
  });

  it('points "Voltar para hoje" at /monthly when the user has monthlyOverview', () => {
    renderMariaPage();
    expect(screen.getByLabelText('Voltar para hoje')).toHaveAttribute(
      'href',
      '/projects/project-1/monthly',
    );
  });

  it('never sends a monthlyOverview-reduced user through /monthly (issue #521): falls back to the first module they can actually see', () => {
    // Reduzido: só enxerga `expenses` (que cobre `recorrentes`/`metas` no nav
    // do PESSOAL) — sem `monthlyOverview`, o alvo antigo (`/monthly`) cairia
    // em `/no-permission`.
    hasModuleMock.mockImplementation((slug: string) => slug === 'expenses');
    renderMariaPage();
    const href = screen.getByLabelText('Voltar para hoje').getAttribute('href');
    expect(href).not.toBe('/projects/project-1/monthly');
    expect(href).toBe('/projects/project-1/recorrentes');
  });

  it('does not render the voice overlay until the explicit CTA is used', () => {
    renderMariaPage();
    expect(screen.queryByTestId('voice-assistant-overlay')).not.toBeInTheDocument();
  });

  it('opens VoiceAssistantOverlay via the "Iniciar conversa por voz" CTA, reusing agent.send and auto-starting capture', () => {
    renderMariaPage();

    fireEvent.click(screen.getByRole('button', { name: 'Iniciar conversa por voz' }));

    expect(screen.getByTestId('voice-assistant-overlay')).toBeInTheDocument();
    // `send` é o wrapper da tela (detecta importEntryAction) sobre o mesmo agent.send.
    void (lastVoiceOverlayProps?.send as (t: string) => unknown)('oi');
    expect(agentSend).toHaveBeenCalledWith('oi');
    expect(lastVoiceOverlayProps?.autoStart).toBe(true);
  });

  it('stops one-shot capture and page audio before opening the automatic conversation', () => {
    agentMessages = [{ role: 'assistant', content: 'Resposta da Maria.' }];
    renderMariaPage();

    fireEvent.click(screen.getByRole('button', { name: 'Ouvir resposta' }));
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar conversa por voz' }));

    expect(speechStop).toHaveBeenCalledTimes(1);
    expect(ttsStop).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('voice-assistant-overlay')).toBeInTheDocument();
  });

  it('ignores a late one-shot transcript after the automatic conversation opens', () => {
    renderMariaPage();
    fireEvent.click(screen.getByRole('button', { name: 'Falar' }));
    const callbacks = speechStart.mock.calls[0]?.[0] as { onResult: (text: string) => void };

    fireEvent.click(screen.getByRole('button', { name: 'Iniciar conversa por voz' }));
    callbacks.onResult('resultado atrasado');

    expect(agentSend).not.toHaveBeenCalled();
  });

  it('auto-envia o prompt pendente do onboarding uma vez e limpa a ponte', () => {
    setPendingMariaPrompt('Quanto já gastei em Supermercado este mês?');

    renderMariaPage();

    expect(agentSend).toHaveBeenCalledTimes(1);
    expect(agentSend).toHaveBeenCalledWith('Quanto já gastei em Supermercado este mês?');
    // Ponte consumida → refresh não re-dispara.
    expect(consumePendingMariaPrompt()).toBeNull();
  });

  it('não envia nada quando não há prompt pendente (input nasce vazio)', () => {
    renderMariaPage();
    expect(agentSend).not.toHaveBeenCalled();
  });

  it('closes the overlay via onClose and returns control to the dock', () => {
    renderMariaPage();
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar conversa por voz' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fechar overlay' }));
    expect(screen.queryByTestId('voice-assistant-overlay')).not.toBeInTheDocument();
  });

  it('exposes one visible, labeled import CTA without the user having to ask', () => {
    renderMariaPage();
    const ctas = screen.getAllByRole('button', { name: IMPORT_CSV_CTA_LABEL });
    expect(ctas).toHaveLength(1);
    expect(ctas[0].className).toContain('min-h-[44px]');
  });

  it('routes the CTA through the ordinary server-gated chat turn (no client-only bypass, no parallel flow)', () => {
    renderMariaPage();
    fireEvent.click(screen.getByRole('button', { name: IMPORT_CSV_CTA_LABEL }));
    expect(agentSend).toHaveBeenCalledTimes(1);
    expect(agentSend).toHaveBeenCalledWith(IMPORT_CSV_PROMPT);
    // Nenhum seletor de arquivo antes de o servidor devolver a ação.
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });
});
