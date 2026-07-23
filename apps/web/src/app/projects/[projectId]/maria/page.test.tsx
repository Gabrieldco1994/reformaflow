import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MariaPage from './page';
import { setPendingMariaPrompt, consumePendingMariaPrompt } from './_lib/pending-prompt';

// Contrato de view: a página Maria reusa `useFinancialAgent`/`useSpeechRecognition`
// (nenhuma nova instância de STT/TTS aqui) e ganha um CTA explícito e acessível
// "Iniciar conversa por voz" que abre `VoiceAssistantOverlay` — o microfone
// one-shot do dock e o botão "Ouvir" de cada resposta seguem como fallback.

vi.mock('next/navigation', () => ({
  useParams: () => ({ projectId: 'project-1' }),
}));

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
  });

  it('does not render the voice overlay until the explicit CTA is used', () => {
    render(<MariaPage />);
    expect(screen.queryByTestId('voice-assistant-overlay')).not.toBeInTheDocument();
  });

  it('opens VoiceAssistantOverlay via the "Iniciar conversa por voz" CTA, reusing agent.send and auto-starting capture', () => {
    render(<MariaPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Iniciar conversa por voz' }));

    expect(screen.getByTestId('voice-assistant-overlay')).toBeInTheDocument();
    expect(lastVoiceOverlayProps?.send).toBe(agentSend);
    expect(lastVoiceOverlayProps?.autoStart).toBe(true);
  });

  it('stops one-shot capture and page audio before opening the automatic conversation', () => {
    agentMessages = [{ role: 'assistant', content: 'Resposta da Maria.' }];
    render(<MariaPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Ouvir resposta' }));
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar conversa por voz' }));

    expect(speechStop).toHaveBeenCalledTimes(1);
    expect(ttsStop).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('voice-assistant-overlay')).toBeInTheDocument();
  });

  it('ignores a late one-shot transcript after the automatic conversation opens', () => {
    render(<MariaPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Falar' }));
    const callbacks = speechStart.mock.calls[0]?.[0] as { onResult: (text: string) => void };

    fireEvent.click(screen.getByRole('button', { name: 'Iniciar conversa por voz' }));
    callbacks.onResult('resultado atrasado');

    expect(agentSend).not.toHaveBeenCalled();
  });

  it('auto-envia o prompt pendente do onboarding uma vez e limpa a ponte', () => {
    setPendingMariaPrompt('Quanto já gastei em Supermercado este mês?');

    render(<MariaPage />);

    expect(agentSend).toHaveBeenCalledTimes(1);
    expect(agentSend).toHaveBeenCalledWith('Quanto já gastei em Supermercado este mês?');
    // Ponte consumida → refresh não re-dispara.
    expect(consumePendingMariaPrompt()).toBeNull();
  });

  it('não envia nada quando não há prompt pendente (input nasce vazio)', () => {
    render(<MariaPage />);
    expect(agentSend).not.toHaveBeenCalled();
  });

  it('closes the overlay via onClose and returns control to the dock', () => {
    render(<MariaPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar conversa por voz' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fechar overlay' }));
    expect(screen.queryByTestId('voice-assistant-overlay')).not.toBeInTheDocument();
  });
});
