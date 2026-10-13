import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportLocalDocuments } from "./ImportLocalDocuments";

afterEach(cleanup);

describe("pre-session CSV/PDF consent contract", () => {
  it("pins the exact qualified-format copy before any local selection", () => {
    render(
      <ImportLocalDocuments formats={["CSV", "PDF"]} onConsent={vi.fn()} />,
    );

    const input = screen.getByLabelText("Selecionar arquivos");
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy!)?.textContent).toBe(
      "CSV e PDF textual sem imagens. Até 5 arquivos, 10485760 bytes por arquivo. A seleção não valida o conteúdo; a análise depende dos formatos habilitados.",
    );
    expect(screen.getByText("Nenhum arquivo selecionado.")).toBeInTheDocument();
  });

  it("pins consent to private deterministic analysis without model authority", () => {
    render(
      <ImportLocalDocuments formats={["CSV", "PDF"]} onConsent={vi.fn()} />,
    );

    const prefix =
      "Ao escolher Analisar e guardar rascunho, você autoriza o envio";
    const paragraph = screen.getByText((_, element) =>
      Boolean(
        element?.tagName === "P" && element.textContent?.startsWith(prefix),
      ),
    );
    expect(paragraph.textContent).toBe(
      "Ao escolher Analisar e guardar rascunho, você autoriza o envio e processamento dos documentos para análise e armazenamento privado do rascunho. Essa autorização inicial não permite processamento externo. Não cria despesas, pagamentos ou rateios. O rascunho pendente e sua referência ao original expiram após 7 dias sem edição sua; consultas não renovam esse prazo.",
    );
  });
});
