import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MariaPage from './page';

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

const agentSend = vi.fn();
vi.mock('@/components/agent/useFinancialAgent', () => ({
  useFinancialAgent: () => ({ messages: [], loading: false, send: agentSend }),
}));

vi.mock('@/components/agent/useSpeechRecognition', () => ({
  useSpeechRecognition: () => ({
    supported: true,
    listening: false,
    start: vi.fn(),
    stop: vi.fn(),
  }),
}));

vi.mock('@/lib/streaming-tts', () => ({
  isStreamingTtsSupported: () => false,
  streamSpeak: vi.fn(),
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

  it('closes the overlay via onClose and returns control to the dock', () => {
    render(<MariaPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar conversa por voz' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fechar overlay' }));
    expect(screen.queryByTestId('voice-assistant-overlay')).not.toBeInTheDocument();
  });
});
