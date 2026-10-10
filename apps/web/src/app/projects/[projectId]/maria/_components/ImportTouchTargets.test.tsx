import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ImportLocalDocuments } from "./ImportLocalDocuments";
import { ImportProposalCard } from "./ImportProposalCard";

// Contrato de toque (>= 44px) das ações primárias: submit do consentimento e
// confirmação financeira. jsdom não calcula layout; o contrato é a utilidade
// `min-h-11` (44px). A geometria real (375/390/1280) é verificada no journey-qa.

vi.mock("../_hooks/useImportExecution", () => ({
  useImportExecution: () => ({
    view: null,
    catalog: null,
    pending: false,
    error: null,
    notice: null,
    settled: false,
    financialAction: "CONFIRM",
    act: vi.fn(),
    retry: vi.fn(),
  }),
}));

describe("import primary actions touch target", () => {
  it("consent submit is at least 44px tall", () => {
    render(<ImportLocalDocuments formats={["CSV"]} onConsent={vi.fn()} />);
    const submit = screen.getByRole("button", {
      name: "Analisar e guardar rascunho",
    });
    expect(submit.className).toContain("min-h-11");
    expect(
      screen.getByRole("button", { name: "Cancelar seleção" }).className,
    ).toContain("min-h-11");
  });

  it("financial confirmation is at least 44px tall", () => {
    render(<ImportProposalCard sessionId="s1" />);
    expect(
      screen.getByRole("button", { name: "Confirmar lote" }).className,
    ).toContain("min-h-11");
  });
});
