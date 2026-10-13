import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ImportOcrFoundation } from "./ImportOcrFoundation";
import type { OcrUiState } from "../_types";

const scope = {
  key: "private-session:private-attachment",
  fileName: "fatura digitalizada.pdf",
};

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
    expect(disclosure).toHaveTextContent(
      /somente PDFs totalmente digitalizados/i,
    );
    expect(disclosure).toHaveTextContent(
      /PDFs textuais continuam locais.*mistos ou pesquisáveis não são enviados/i,
    );
    expect(disclosure).toHaveTextContent(/PDF original completo/i);
    expect(disclosure).toHaveTextContent(/Google Cloud Vertex AI/i);
    expect(disclosure).toHaveTextContent(/Gemini 2\.5 Flash/i);
    expect(disclosure).toHaveTextContent(/southamerica-east1/i);
    expect(disclosure).toHaveTextContent(/extrair transações/i);
    expect(disclosure).toHaveTextContent(/sete dias sem edição/i);
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
    ["PRE_CALL_UNAVAILABLE", /leitura externa indisponível antes do envio/i],
    ["DOCUMENT_UNSAFE", /documento não é seguro ou legível/i],
    ["SAFETY_OR_MALFORMED", /bloqueada por segurança.*fora do formato seguro/i],
    ["BUDGET_OR_RATE_LIMIT", /limite de uso ou orçamento/i],
    [
      "ATTEMPT_UNKNOWN",
      /resultado é desconhecido.*não faremos outra chamada externa/i,
    ],
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
