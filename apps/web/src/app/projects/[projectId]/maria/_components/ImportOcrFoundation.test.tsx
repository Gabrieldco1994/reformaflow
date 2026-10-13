import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ImportOcrFoundation } from "./ImportOcrFoundation";
import type { OcrCandidateView, OcrConsentIntentV2 } from "../_types";

const candidate = (ref = "candidate-private-7f2a"): OcrCandidateView => ({
  ref,
  status: "UNVERIFIED",
  fields: [
    {
      key: "merchant",
      label: "Estabelecimento",
      value: "Mercado Central",
    },
    { key: "amountCents", label: "Valor", value: "R$ 123,45" },
  ],
});

const scope = {
  key: "account-private:project-private:session-private:artifact-private",
  fileName: "fatura digitalizada.pdf",
};

describe("ImportOcrFoundation", () => {
  it("shows consent v2 only after typed OCR_REQUIRED and leaves it unchecked", () => {
    const { rerender } = render(
      <ImportOcrFoundation
        triggerCode={null}
        scope={scope}
        availability={{ state: "DISABLED", reason: "FEATURE_OFF" }}
      />,
    );

    expect(
      screen.queryByRole("region", { name: "Opção de OCR" }),
    ).not.toBeInTheDocument();

    rerender(
      <ImportOcrFoundation
        triggerCode="DOCUMENT_UNREADABLE"
        scope={scope}
        availability={{ state: "DISABLED", reason: "FEATURE_OFF" }}
      />,
    );
    expect(
      screen.queryByRole("region", { name: "Opção de OCR" }),
    ).not.toBeInTheDocument();

    rerender(
      <ImportOcrFoundation
        triggerCode="OCR_REQUIRED"
        scope={scope}
        availability={{ state: "DISABLED", reason: "FEATURE_OFF" }}
      />,
    );

    expect(
      screen.getByText("Google Cloud Vertex AI", { exact: false }),
    ).toBeVisible();
    expect(
      screen.getByText("Gemini 2.5 Flash", { exact: false }),
    ).toBeVisible();
    expect(
      screen.getByText("southamerica-east1", { exact: false }),
    ).toBeVisible();
    expect(
      screen.getByText(/extrair candidatos para revisão humana/i),
    ).toBeVisible();
    expect(
      screen.getByRole("checkbox", {
        name: /autorizo o processamento externo/i,
      }),
    ).not.toBeChecked();
  });

  it.each([
    ["FEATURE_OFF", /OCR está desativado/i],
    ["PROVIDER_UNAVAILABLE", /provedor de OCR está indisponível/i],
    ["CONTRACT_PENDING", /integração segura de OCR ainda não está pronta/i],
  ] as const)(
    "keeps an honest textual/manual fallback for %s without a retry loop",
    (reason, copy) => {
      render(
        <ImportOcrFoundation
          triggerCode="OCR_REQUIRED"
          scope={scope}
          availability={{ state: "DISABLED", reason }}
        />,
      );

      expect(screen.getByText(copy)).toBeVisible();
      expect(screen.getByText(/PDF textual sem imagens ou CSV/i)).toBeVisible();
      expect(
        screen.queryByRole("button", { name: /tentar|retry/i }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("checkbox", {
          name: /autorizo o processamento externo/i,
        }),
      ).toBeDisabled();
    },
  );

  it("sends only consent intent, then renders every candidate UNVERIFIED and unselected", async () => {
    const loadCandidates = vi
      .fn<
        (
          intent: OcrConsentIntentV2,
          signal: AbortSignal,
        ) => Promise<readonly OcrCandidateView[]>
      >()
      .mockResolvedValue([candidate()]);
    render(
      <ImportOcrFoundation
        triggerCode="OCR_REQUIRED"
        scope={scope}
        availability={{ state: "READY" }}
        loadCandidates={loadCandidates}
        onPrepare={vi.fn()}
      />,
    );

    const consent = screen.getByRole("checkbox", {
      name: /autorizo o processamento externo/i,
    });
    expect(consent).not.toBeChecked();
    expect(
      screen.getByRole("button", { name: "Solicitar leitura por OCR" }),
    ).toBeDisabled();

    await userEvent.click(consent);
    await userEvent.click(
      screen.getByRole("button", { name: "Solicitar leitura por OCR" }),
    );

    expect(loadCandidates).toHaveBeenCalledWith(
      {
        version: 2,
        consentExternalProcessing: true,
      },
      expect.any(AbortSignal),
    );
    expect(Object.keys(loadCandidates.mock.calls[0][0]).sort()).toEqual([
      "consentExternalProcessing",
      "version",
    ]);

    const dialog = await screen.findByRole("dialog", {
      name: "Revisar candidatos de OCR",
    });
    expect(within(dialog).getByText("NÃO VERIFICADO")).toBeVisible();
    expect(
      within(dialog).getByRole("checkbox", {
        name: /selecionar candidato 1/i,
      }),
    ).not.toBeChecked();
    expect(
      within(dialog).getByRole("button", {
        name: /preparar candidatos selecionados/i,
      }),
    ).toBeDisabled();

    const rendered = document.body.textContent ?? "";
    expect(rendered).not.toContain("candidate-private-7f2a");
    expect(rendered).not.toContain("account-private");
    expect(rendered).not.toContain("project-private");
    expect(rendered).not.toContain("session-private");
    expect(rendered).not.toContain("artifact-private");

    await userEvent.keyboard("{Escape}");
    await userEvent.click(
      screen.getByRole("button", { name: "Abrir revisão de OCR" }),
    );
    expect(loadCandidates).toHaveBeenCalledTimes(1);
  });

  it("requires each field and explicit attestation before selection and prepare", async () => {
    const onPrepare = vi.fn();
    render(
      <ImportOcrFoundation
        triggerCode="OCR_REQUIRED"
        scope={scope}
        availability={{ state: "READY" }}
        loadCandidates={async () => [candidate()]}
        onPrepare={onPrepare}
      />,
    );

    await userEvent.click(
      screen.getByRole("checkbox", {
        name: /autorizo o processamento externo/i,
      }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Solicitar leitura por OCR" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Revisar candidatos de OCR",
    });
    const merchant = within(dialog).getByRole("textbox", {
      name: "Estabelecimento",
    });
    const amount = within(dialog).getByRole("textbox", { name: "Valor" });
    await waitFor(() => expect(merchant).toHaveFocus());

    const selection = within(dialog).getByRole("checkbox", {
      name: /selecionar candidato 1/i,
    });
    const attestation = within(dialog).getByRole("checkbox", {
      name: /atesto que conferi todos os campos do candidato 1/i,
    });
    expect(selection).toBeDisabled();
    expect(attestation).toBeDisabled();

    await userEvent.click(
      within(dialog).getByRole("button", {
        name: "Confirmar campo Estabelecimento",
      }),
    );
    expect(amount).toHaveFocus();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Confirmar campo Valor" }),
    );
    expect(attestation).toBeEnabled();

    await userEvent.click(attestation);
    expect(selection).toBeEnabled();
    await userEvent.click(selection);
    const prepare = within(dialog).getByRole("button", {
      name: /preparar candidatos selecionados/i,
    });
    expect(prepare).toBeEnabled();
    await userEvent.click(prepare);
    expect(onPrepare).toHaveBeenCalledWith([
      {
        ref: "candidate-private-7f2a",
        fields: { merchant: "Mercado Central", amountCents: "R$ 123,45" },
        attested: true,
      },
    ]);
  });

  it("invalidates attestation and selection after a correction", async () => {
    render(
      <ImportOcrFoundation
        triggerCode="OCR_REQUIRED"
        scope={scope}
        availability={{ state: "READY" }}
        loadCandidates={async () => [candidate()]}
        onPrepare={vi.fn()}
      />,
    );
    await userEvent.click(
      screen.getByRole("checkbox", {
        name: /autorizo o processamento externo/i,
      }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Solicitar leitura por OCR" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Revisar candidatos de OCR",
    });
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: "Confirmar campo Estabelecimento",
      }),
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Confirmar campo Valor" }),
    );
    const attestation = within(dialog).getByRole("checkbox", {
      name: /atesto que conferi todos os campos do candidato 1/i,
    });
    const selection = within(dialog).getByRole("checkbox", {
      name: /selecionar candidato 1/i,
    });
    await userEvent.click(attestation);
    await userEvent.click(selection);

    await userEvent.clear(
      within(dialog).getByRole("textbox", { name: "Estabelecimento" }),
    );
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: "Estabelecimento" }),
      "Mercado corrigido",
    );

    expect(attestation).not.toBeChecked();
    expect(attestation).toBeDisabled();
    expect(selection).not.toBeChecked();
    expect(selection).toBeDisabled();
    expect(
      within(dialog).getByRole("button", {
        name: /preparar candidatos selecionados/i,
      }),
    ).toBeDisabled();
  });

  it("drops a late OCR result after account, project, session, or artifact scope changes", async () => {
    let release:
      | ((candidates: readonly OcrCandidateView[]) => void)
      | undefined;
    const loadCandidates = vi.fn(
      () =>
        new Promise<readonly OcrCandidateView[]>((resolve) => {
          release = resolve;
        }),
    );
    const { rerender } = render(
      <ImportOcrFoundation
        triggerCode="OCR_REQUIRED"
        scope={scope}
        availability={{ state: "READY" }}
        loadCandidates={loadCandidates}
      />,
    );
    await userEvent.click(
      screen.getByRole("checkbox", {
        name: /autorizo o processamento externo/i,
      }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Solicitar leitura por OCR" }),
    );

    rerender(
      <ImportOcrFoundation
        triggerCode="OCR_REQUIRED"
        scope={{
          key: "different-account-project-session-artifact",
          fileName: "outro.pdf",
        }}
        availability={{ state: "READY" }}
        loadCandidates={loadCandidates}
      />,
    );
    expect(
      screen.getByRole("checkbox", {
        name: /autorizo o processamento externo/i,
      }),
    ).not.toBeChecked();

    await act(async () => {
      release?.([candidate("late-candidate-private")]);
      await Promise.resolve();
    });
    expect(
      screen.queryByRole("dialog", { name: "Revisar candidatos de OCR" }),
    ).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("late-candidate-private");
  });

  it("returns focus to the opener when the accessible review dialog closes", async () => {
    render(
      <ImportOcrFoundation
        triggerCode="OCR_REQUIRED"
        scope={scope}
        availability={{ state: "READY" }}
        loadCandidates={async () => [candidate()]}
      />,
    );
    const consent = screen.getByRole("checkbox", {
      name: /autorizo o processamento externo/i,
    });
    const opener = screen.getByRole("button", {
      name: "Solicitar leitura por OCR",
    });
    await userEvent.click(consent);
    opener.focus();
    await userEvent.click(opener);
    await screen.findByRole("dialog", { name: "Revisar candidatos de OCR" });
    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(opener).toHaveFocus());
  });
});
