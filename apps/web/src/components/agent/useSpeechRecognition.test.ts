import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSpeechRecognition } from "./useSpeechRecognition";

type RecognitionResult = {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
};

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  lang = "";
  interimResults = false;
  maxAlternatives = 1;
  continuous = false;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onresult: ((event: RecognitionResult) => void) | null = null;
  abort = vi.fn();
  stop = vi.fn();
  start = vi.fn();

  constructor() {
    FakeRecognition.instances.push(this);
  }

  result(transcript: string) {
    this.onresult?.({
      results: {
        0: { 0: { transcript }, length: 1 },
        length: 1,
      },
    });
  }
}

describe("useSpeechRecognition capture ownership", () => {
  beforeEach(() => {
    FakeRecognition.instances = [];
    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: FakeRecognition,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "SpeechRecognition");
  });

  it("reports not-allowed without producing a transcript", async () => {
    const onResult = vi.fn();
    const onError = vi.fn();
    const { result } = renderHook(() => useSpeechRecognition());
    await waitFor(() => expect(result.current.supported).toBe(true));

    act(() => result.current.start({ onResult, onError }));
    const recognition = FakeRecognition.instances[0];
    act(() => {
      recognition.onstart?.();
      recognition.onerror?.({ error: "not-allowed" });
    });

    expect(result.current.listening).toBe(false);
    expect(onResult).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toMatch(/Microfone bloqueado/);
  });

  it("ignores every late callback from a superseded recognition while the current capture remains authoritative", async () => {
    const staleResult = vi.fn();
    const staleError = vi.fn();
    const currentResult = vi.fn();
    const currentError = vi.fn();
    const { result } = renderHook(() => useSpeechRecognition());
    await waitFor(() => expect(result.current.supported).toBe(true));

    act(() =>
      result.current.start({ onResult: staleResult, onError: staleError }),
    );
    const stale = FakeRecognition.instances[0];
    act(() => stale.onstart?.());
    expect(result.current.listening).toBe(true);

    stale.abort.mockImplementationOnce(() => {
      stale.result("resultado durante abort");
      stale.onerror?.({ error: "network" });
      stale.onend?.();
    });
    act(() =>
      result.current.start({ onResult: currentResult, onError: currentError }),
    );
    const current = FakeRecognition.instances[1];
    expect(stale.abort).toHaveBeenCalledOnce();
    expect(staleResult).not.toHaveBeenCalled();
    expect(staleError).not.toHaveBeenCalled();

    act(() => current.onstart?.());
    expect(result.current.listening).toBe(true);

    act(() => {
      stale.result("transcrição atrasada");
      stale.onerror?.({ error: "network" });
      stale.onend?.();
    });

    expect(staleResult).not.toHaveBeenCalled();
    expect(staleError).not.toHaveBeenCalled();
    expect(currentResult).not.toHaveBeenCalled();
    expect(currentError).not.toHaveBeenCalled();
    expect(result.current.listening).toBe(true);

    act(() => current.result("  Mercado Central  "));
    expect(currentResult).toHaveBeenCalledOnce();
    expect(currentResult).toHaveBeenCalledWith("Mercado Central");
    expect(currentError).not.toHaveBeenCalled();
    expect(result.current.listening).toBe(true);

    act(() => current.onend?.());
    expect(result.current.listening).toBe(false);
  });
});
