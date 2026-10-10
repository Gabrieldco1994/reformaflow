import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FinancialAgentWidget } from "./FinancialAgentWidget";
import { useCopilotStore } from "@/stores/copilot-store";

// Contrato de toque (>= 44px): os CTAs de importação CSV do widget apontam para
// a Maria e usam `min-h-11` (44px). jsdom não calcula layout, então o contrato é
// a classe utilitária; a geometria real (375/390/1280) é do journey-qa.

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "project-1" }),
}));
vi.mock("@/contexts/project-context", () => ({
  useProject: () => ({ projectId: "project-1", projectType: "PESSOAL" }),
}));
vi.mock("@/lib/streaming-tts", () => ({
  isStreamingTtsSupported: () => false,
  streamSpeak: vi.fn(),
}));
vi.mock("./useSpeechRecognition", () => ({
  useSpeechRecognition: () => ({
    supported: true,
    listening: false,
    start: vi.fn(),
    stop: vi.fn(),
  }),
}));
vi.mock("./VoiceAssistantOverlay", () => ({
  VoiceAssistantOverlay: () => null,
}));

let messages: unknown[] = [];
vi.mock("./useFinancialAgent", () => ({
  useFinancialAgent: () => ({ messages, loading: false, send: vi.fn() }),
}));

if (typeof HTMLElement.prototype.scrollTo !== "function") {
  HTMLElement.prototype.scrollTo = function scrollToStub() {};
}

describe("FinancialAgentWidget touch targets", () => {
  beforeEach(() => {
    useCopilotStore.setState({ open: true });
    messages = [
      {
        role: "assistant",
        content: "Selecione o cartão.",
        importEntryAction: {
          version: 1,
          kind: "START_CARD_INVOICE_IMPORT",
          formats: ["CSV"],
          suggestedCardId: null,
        },
      },
    ];
  });

  it("header CTA to Maria import is at least 44px tall", () => {
    render(<FinancialAgentWidget />);
    const cta = screen.getByRole("link", {
      name: "Importar fatura CSV com Maria",
    });
    expect(cta.className).toContain("min-h-11");
    expect(cta.className).not.toContain("min-h-9");
  });

  it("server-authorized continue CTA is at least 44px tall", () => {
    render(<FinancialAgentWidget />);
    const cta = screen.getByRole("link", {
      name: "Continuar importação CSV com a Maria",
    });
    expect(cta.className).toContain("min-h-11");
  });
});
