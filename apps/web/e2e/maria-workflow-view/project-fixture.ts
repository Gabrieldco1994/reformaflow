import type { StreamTtsOptions } from "../../src/lib/streaming-tts";

export function useProject() {
  return { projectId: "offline-project", projectType: "PESSOAL" };
}

export function isStreamingTtsSupported() {
  return true;
}

/** Synthetic playback records safe text; it never contacts a provider. */
export function streamSpeak(options: StreamTtsOptions) {
  window.dispatchEvent(new CustomEvent("p08-tts", { detail: options.text }));
  const start = setTimeout(() => options.onStart?.(), 1);
  const end = setTimeout(() => options.onEnd?.(), 50);
  return {
    stop: () => {
      clearTimeout(start);
      clearTimeout(end);
    },
  };
}
