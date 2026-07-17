import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceAssistantOverlay } from './VoiceAssistantOverlay';

// Contrato do view-layer: a resposta textual da Maria fica visível assim que
// chega, o estado vira `preparing` (não `speaking`) enquanto o TTS ainda não
// tocou o primeiro PCM real, e só vira `speaking` dentro de `onStart`. Este
// teste mocka o streaming de áudio e a captura de voz — nenhuma rede real.

interface StreamTtsOptions {
  text: string;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (error: Error) => void;
}

const streamSpeakMock = vi.fn();
vi.mock('@/lib/streaming-tts', () => ({
  streamSpeak: (options: StreamTtsOptions) => streamSpeakMock(options),
}));

let speechCallbacks: { onResult: (text: string) => void; onError?: (message: string) => void } | null = null;
const speechStartMock = vi.fn((callbacks: typeof speechCallbacks) => {
  speechCallbacks = callbacks;
});
const speechStopMock = vi.fn();
vi.mock('./useSpeechRecognition', () => ({
  useSpeechRecognition: () => ({
    supported: true,
    listening: false,
    start: speechStartMock,
    stop: speechStopMock,
  }),
}));

function latestTtsOptions(): StreamTtsOptions {
  const call = streamSpeakMock.mock.calls.at(-1) as [StreamTtsOptions] | undefined;
  if (!call) throw new Error('streamSpeak não foi chamado.');
  return call[0];
}

async function flushMicrotasks() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe('VoiceAssistantOverlay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    streamSpeakMock.mockReset();
    streamSpeakMock.mockReturnValue({ stop: vi.fn() });
    speechStartMock.mockClear();
    speechStopMock.mockClear();
    speechCallbacks = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows "preparing" (with the reply already visible) before onStart, and only shows "speaking" once onStart fires', async () => {
    const send = vi.fn().mockResolvedValue({ role: 'assistant', content: 'Você gastou R$ 100 no mercado.' });

    render(<VoiceAssistantOverlay send={send} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Iniciar conversa por voz' }));
    expect(speechStartMock).toHaveBeenCalledTimes(1);

    act(() => {
      speechCallbacks!.onResult('quanto gastei no mercado');
    });
    await flushMicrotasks();

    expect(screen.getByText('Preparando voz…')).toBeInTheDocument();
    expect(screen.getByText('Você gastou R$ 100 no mercado.')).toBeInTheDocument();
    expect(screen.queryByText('Falando…')).not.toBeInTheDocument();

    act(() => {
      latestTtsOptions().onStart?.();
    });

    expect(screen.getByText('Falando…')).toBeInTheDocument();
    expect(screen.getByText('Você gastou R$ 100 no mercado.')).toBeInTheDocument();
  });

  it('shows the warm-up hint only after 3s in "preparing", and clears it once audio starts', async () => {
    const send = vi.fn().mockResolvedValue({ role: 'assistant', content: 'Resposta da Maria.' });
    render(<VoiceAssistantOverlay send={send} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Iniciar conversa por voz' }));
    act(() => {
      speechCallbacks!.onResult('oi maria');
    });
    await flushMicrotasks();

    expect(screen.getByText('Preparando voz…')).toBeInTheDocument();
    expect(screen.queryByText(/A voz está aquecendo/)).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2999);
    });
    expect(screen.queryByText(/A voz está aquecendo/)).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByText('A voz está aquecendo. Você já pode ler a resposta.')).toBeInTheDocument();

    act(() => {
      latestTtsOptions().onStart?.();
    });
    expect(screen.queryByText(/A voz está aquecendo/)).not.toBeInTheDocument();
    expect(screen.getByText('Falando…')).toBeInTheDocument();
  });

  it('closing during "preparing" cancels the warm-up timer and does not reopen the microphone afterwards', async () => {
    const send = vi.fn().mockResolvedValue({ role: 'assistant', content: 'Resposta da Maria.' });
    const onClose = vi.fn();
    const stopHandle = { stop: vi.fn() };
    streamSpeakMock.mockReturnValue(stopHandle);

    render(<VoiceAssistantOverlay send={send} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Iniciar conversa por voz' }));
    act(() => {
      speechCallbacks!.onResult('oi maria');
    });
    await flushMicrotasks();

    expect(screen.getByText('Preparando voz…')).toBeInTheDocument();
    speechStartMock.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Fechar conversa por voz' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(stopHandle.stop).toHaveBeenCalledTimes(1);

    // Mesmo passando bastante tempo (o que dispararia o hint de aquecimento e,
    // se o áudio tivesse terminado, reabriria o microfone), nada deve
    // acontecer: o timer foi cancelado e o modo automático foi desligado.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.queryByText(/A voz está aquecendo/)).not.toBeInTheDocument();
    expect(speechStartMock).not.toHaveBeenCalled();
  });

  it('pausing mid-"speaking" does not reopen the microphone when playback would otherwise end', async () => {
    const send = vi.fn().mockResolvedValue({ role: 'assistant', content: 'Resposta da Maria.' });
    let capturedOnEnd: (() => void) | undefined;
    streamSpeakMock.mockImplementation((options: StreamTtsOptions) => {
      capturedOnEnd = options.onEnd;
      return { stop: vi.fn() };
    });

    render(<VoiceAssistantOverlay send={send} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Iniciar conversa por voz' }));
    act(() => {
      speechCallbacks!.onResult('oi maria');
    });
    await flushMicrotasks();
    act(() => {
      latestTtsOptions().onStart?.();
    });
    expect(screen.getByText('Falando…')).toBeInTheDocument();

    speechStartMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Pausar conversa por voz' }));

    // Simula o áudio finalmente terminando depois de já ter sido pausado —
    // o modo automático está desligado, então o microfone não deve reabrir.
    act(() => {
      capturedOnEnd?.();
    });
    expect(speechStartMock).not.toHaveBeenCalled();
  });
});
