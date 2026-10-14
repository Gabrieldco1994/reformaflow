import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ImportOcrFoundation } from "./ImportOcrFoundation";
import type { OcrUiState } from "../_types";

const scope = {
  key: "private-session:private-attachment",
  fileName: "fatura digitalizada.pdf",
};

const EXTERNAL_RETENTION_DISCLOSURE =
  "Se você autorizar, o PDF original completo, incluindo seus metadados e qualquer conteúdo potencialmente não visível ou incorporado, será enviado ao Google Cloud Vertex AI, modelo Gemini 2.5 Flash, na região southamerica-east1, exclusivamente para a transcrição das linhas do documento para revisão humana, não para classificação financeira. Todo esse conteúdo enviado externamente, assim como o resultado e a evidência da leitura externa, fica retido externamente por no máximo sete dias corridos contados da tentativa, independentemente de edições ou prorrogações da sessão. Esta versão não cria uma derivada raster local para substituir esse envio.";

const LOCAL_RETENTION_DISCLOSURE =
  "Separadamente, o PDF original privado armazenado no ReformaFlow segue a política de retenção local da sessão e do cofre privado (vault): ele pode ser liberado antes ao concluir ou cancelar, quando não houver outra referência autorizada. Essa retenção local não reinicia nem estende o prazo máximo de sete dias da retenção externa. A auditoria mínima de consentimento e provedor permanece conforme a política aplicável.";

describe("ImportOcrFoundation", () => {
  it("discloses the first-release boundary, full-PDF transfer, provider, retention, and human review", () => {
    const { rerender } = render(
      <ImportOcrFoundation state={null} scope={scope} onConsent={vi.fn()} />,
    );
    expect(
      screen.queryByRole("region", { name: "Leitura externa do documento" }),
    ).not.toBeInTheDocument();

    rerender(
      <ImportOcrFoundation
        state={{ kind: "CONSENT_REQUIRED" }}
        scope={scope}
        onConsent={vi.fn()}
      />,
    );

    const disclosure = screen.getByRole("region", {
      name: "Leitura externa do documento",
    });
    expect(disclosure).toHaveTextContent(/se este arquivo for um PDF/i);
    expect(disclosure).toHaveTextContent(
      /PDFs textuais continuam locais.*mistos ou pesquisáveis não são enviados/i,
    );
    expect(disclosure).not.toHaveTextContent(
      /identificado como um PDF totalmente digitalizado/i,
    );
    expect(disclosure).toHaveTextContent(/PDF original completo/i);
    expect(disclosure).toHaveTextContent(
      /metadados.*conteúdo.*não visível ou incorporado/i,
    );
    expect(disclosure).toHaveTextContent(/Google Cloud Vertex AI/i);
    expect(disclosure).toHaveTextContent(/Gemini 2\.5 Flash/i);
    expect(disclosure).toHaveTextContent(/southamerica-east1/i);
    const renderedParagraphs = Array.from(
      disclosure.querySelectorAll("p"),
      (paragraph) => paragraph.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(renderedParagraphs).toContain(EXTERNAL_RETENTION_DISCLOSURE);
    expect(renderedParagraphs).toContain(LOCAL_RETENTION_DISCLOSURE);
    expect(disclosure).toHaveTextContent(/revisão humana/i);
    expect(disclosure).toHaveTextContent(
      /nenhum registro financeiro.*confirmação/i,
    );
    expect(
      screen.getByRole("checkbox", {
        name: /autorizo o envio do PDF original completo/i,
      }),
    ).not.toBeChecked();
    expect(document.body).not.toHaveTextContent("private-session");
    expect(document.body).not.toHaveTextContent("private-attachment");
  });

  it("sends consent only after the affirmative checkbox and locks immediately", async () => {
    const onConsent = vi.fn();
    render(
      <ImportOcrFoundation
        state={{ kind: "CONSENT_REQUIRED" }}
        scope={scope}
        onConsent={onConsent}
      />,
    );

    const submit = screen.getByRole("button", {
      name: "Autorizar leitura externa",
    });
    expect(submit).toBeDisabled();
    await userEvent.click(submit);
    expect(onConsent).not.toHaveBeenCalled();

    await userEvent.click(
      screen.getByRole("checkbox", {
        name: /autorizo o envio do PDF original completo/i,
      }),
    );
    await userEvent.click(submit);
    await userEvent.click(submit);
    expect(onConsent).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "OCR_UNAVAILABLE",
      /falha aconteceu antes de o PDF ser enviado.*entrada manual/i,
    ],
    [
      "OCR_SAFETY_BLOCKED",
      /provedor bloqueou a leitura.*Nenhum lançamento foi criado/i,
    ],
    [
      "OCR_MALFORMED_RESPONSE",
      /provedor devolveu uma leitura inválida.*Nenhum lançamento foi criado/i,
    ],
    [
      "OCR_BUDGET_EXHAUSTED",
      /limite diário de OCR foi atingido antes do envio/i,
    ],
    [
      "OCR_ATTEMPT_UNKNOWN",
      /envio começou ou pode ter ocorrido.*não pode ser repetida.*Nenhum lançamento foi criado/i,
    ],
    ["DOCUMENT_UNREADABLE", /não foi possível ler este documento/i],
    ["PDF_PASSWORD_REQUIRED", /protegido por senha.*não envie sua senha/i],
    ["UNSUPPORTED_DOCUMENT", /documento.*não é suportado/i],
  ] satisfies ReadonlyArray<[OcrUiState["kind"], RegExp]>)(
    "renders terminal typed state %s with fallback choices and no retry CTA",
    (kind, copy) => {
      render(
        <ImportOcrFoundation
          state={{ kind } as OcrUiState}
          scope={scope}
          onConsent={vi.fn()}
        />,
      );

      expect(screen.getByRole("alert")).toHaveTextContent(copy);
      expect(screen.getByText(/Entrada manual:/i)).toBeVisible();
      expect(screen.getByText(/Substituir o arquivo:/i)).toBeVisible();
      expect(screen.getByText(/Cancelar:/i)).toBeVisible();
      expect(
        screen.getByText(/zero registros financeiros foram criados/i),
      ).toBeVisible();
      expect(
        screen.queryByRole("button", { name: /autorizar|tentar|retry/i }),
      ).not.toBeInTheDocument();
    },
  );

  it("does not render consent on textual or mixed/searchable paths", () => {
    render(
      <ImportOcrFoundation state={null} scope={scope} onConsent={vi.fn()} />,
    );
    expect(
      screen.queryByRole("checkbox", { name: /processamento externo/i }),
    ).not.toBeInTheDocument();
  });
});
