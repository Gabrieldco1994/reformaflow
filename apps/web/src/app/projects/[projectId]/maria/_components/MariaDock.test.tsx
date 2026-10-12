import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  IMPORT_CSV_CTA_LABEL,
  IMPORT_CSV_PROMPT,
  MariaDock,
  VOICE_LAUNCH_CHIP_LABEL,
} from "./MariaDock";

// Contrato: o dock preserva o microfone one-shot (`onMic`) como fallback e
// ganha uma ação explícita e acessível "Iniciar conversa por voz" que abre a
// experiência 100% voz (`VoiceAssistantOverlay`) na página — sem duplicar
// STT/TTS aqui.
describe("MariaDock", () => {
  function setup(overrides: Partial<Parameters<typeof MariaDock>[0]> = {}) {
    const props = {
      input: "",
      onInputChange: vi.fn(),
      onSubmit: vi.fn(),
      onMic: vi.fn(),
      listening: false,
      micSupported: true,
      disabled: false,
      onOpenVoiceConversation: vi.fn(),
      ...overrides,
    };
    render(<MariaDock {...props} />);
    return props;
  }

  it("opens the voice conversation overlay via the explicit CTA, without touching STT/TTS", () => {
    const props = setup();

    fireEvent.click(
      screen.getByRole("button", { name: "Iniciar conversa por voz" }),
    );

    expect(props.onOpenVoiceConversation).toHaveBeenCalledTimes(1);
    expect(props.onMic).not.toHaveBeenCalled();
  });

  it("keeps the one-shot mic fallback (chip and inline button) working independently", () => {
    const props = setup();

    fireEvent.click(
      screen.getByRole("button", { name: VOICE_LAUNCH_CHIP_LABEL }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Falar" }));

    expect(props.onMic).toHaveBeenCalledTimes(2);
    expect(props.onOpenVoiceConversation).not.toHaveBeenCalled();
  });

  it("disables the voice-conversation CTA while the agent is busy, like the rest of the dock", () => {
    setup({ disabled: true });

    expect(
      screen.getByRole("button", { name: "Iniciar conversa por voz" }),
    ).toBeDisabled();
  });

  it("renders no import CTA unless an import entry handler is provided", () => {
    setup();
    expect(
      screen.queryByRole("button", { name: IMPORT_CSV_CTA_LABEL }),
    ).not.toBeInTheDocument();
  });

  it("import CTA is keyboard-reachable, >=44px, and asks for the import via the chat turn", () => {
    const onSubmit = vi.fn();
    setup({ onImportStart: () => onSubmit(IMPORT_CSV_PROMPT) });
    const cta = screen.getByRole("button", { name: IMPORT_CSV_CTA_LABEL });
    expect(cta).toHaveAttribute("type", "button");
    expect(cta.className).toContain("min-h-[44px]");
    cta.focus();
    expect(cta).toHaveFocus();
    fireEvent.click(cta);
    expect(onSubmit).toHaveBeenCalledWith(IMPORT_CSV_PROMPT);
    expect(IMPORT_CSV_PROMPT.toLowerCase()).toMatch(/importar/);
    expect(IMPORT_CSV_PROMPT.toLowerCase()).toMatch(/fatura/);
  });

  it("disables the CTA while the agent is busy", () => {
    setup({ disabled: true, onImportStart: vi.fn() });
    expect(
      screen.getByRole("button", { name: IMPORT_CSV_CTA_LABEL }),
    ).toBeDisabled();
  });
});
