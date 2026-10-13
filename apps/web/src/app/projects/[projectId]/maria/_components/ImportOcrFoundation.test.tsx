import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ImportOcrFoundation } from "./ImportOcrFoundation";

const scope = {
  key: "private-session:private-attachment",
  fileName: "fatura digitalizada.pdf",
};

describe("ImportOcrFoundation", () => {
  it("offers explicit external processing consent only after OCR_REQUIRED", () => {
    const { rerender } = render(
      <ImportOcrFoundation
        triggerCode={null}
        scope={scope}
        onConsent={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("region", { name: "Leitura externa do documento" }),
    ).not.toBeInTheDocument();

    rerender(
      <ImportOcrFoundation
        triggerCode="DOCUMENT_UNREADABLE"
        scope={scope}
        onConsent={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("region", { name: "Leitura externa do documento" }),
    ).not.toBeInTheDocument();

    rerender(
      <ImportOcrFoundation
        triggerCode="OCR_REQUIRED"
        scope={scope}
        onConsent={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("checkbox", {
        name: /autorizo o envio deste documento/i,
      }),
    ).not.toBeChecked();
    expect(screen.getByText(/Google Cloud Vertex AI/i)).toBeVisible();
    expect(screen.getByText(/somente para este documento/i)).toBeVisible();
    expect(document.body).not.toHaveTextContent("private-session");
    expect(document.body).not.toHaveTextContent("private-attachment");
  });

  it("submits consent once and never exposes a provider retry after an ambiguous failure", async () => {
    const onConsent = vi.fn();
    const { rerender } = render(
      <ImportOcrFoundation
        triggerCode="OCR_REQUIRED"
        scope={scope}
        onConsent={onConsent}
      />,
    );

    const submit = screen.getByRole("button", {
      name: "Autorizar leitura externa",
    });
    expect(submit).toBeDisabled();
    await userEvent.click(
      screen.getByRole("checkbox", {
        name: /autorizo o envio deste documento/i,
      }),
    );
    await userEvent.click(submit);
    await userEvent.click(submit);
    expect(onConsent).toHaveBeenCalledTimes(1);

    rerender(
      <ImportOcrFoundation
        triggerCode="OCR_REQUIRED"
        scope={scope}
        attempted
        errorMessage="Não foi possível confirmar a leitura externa."
        onConsent={onConsent}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Não foi possível confirmar a leitura externa.",
    );
    expect(
      screen.queryByRole("button", { name: /autorizar|tentar|retry/i }),
    ).not.toBeInTheDocument();
    expect(onConsent).toHaveBeenCalledTimes(1);
  });

  it("does not render consent on the successful textual path", () => {
    render(
      <ImportOcrFoundation
        triggerCode={null}
        scope={scope}
        onConsent={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("checkbox", { name: /processamento externo/i }),
    ).not.toBeInTheDocument();
  });
});
