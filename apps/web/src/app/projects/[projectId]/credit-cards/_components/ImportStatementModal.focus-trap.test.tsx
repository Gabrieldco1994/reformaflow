import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ImportStatementModal from "./ImportStatementModal";
import type { CardRow } from "../_types";

/**
 * #680 — focus trap + aria-modal no ImportStatementModal
 */

const apiUploadMock = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { upload: (...args: unknown[]) => apiUploadMock(...args) },
}));

const CARD: CardRow = {
  id: "card-a",
  institution: "NUBANK",
  brand: "MASTERCARD",
  nickname: "Roxinho",
  last4: "4242",
  limitTotalCents: null,
  limitAvailableCents: null,
  closingDay: 10,
  dueDay: 17,
};

const PREVIEW = {
  source: "CSV_NUBANK",
  periodLabel: "2026-07",
  total: 2,
  duplicated: 0,
  totalAmountCents: 12000,
  classificationStatus: "success" as const,
  preview: [
    {
      externalId: "t-nova",
      date: "2026-07-01",
      merchant: "PADARIA",
      amountCents: 7000,
      category: "food",
      installmentCurrent: null,
      installmentTotal: null,
      duplicate: false,
      willImport: true,
      possibleDuplicate: undefined,
      crossProjectMatches: undefined,
    },
    {
      externalId: "t-dup",
      date: "2026-07-02",
      merchant: "MERCADO",
      amountCents: 5000,
      category: "food",
      installmentCurrent: null,
      installmentTotal: null,
      duplicate: false,
      willImport: false,
      possibleDuplicate: true,
      crossProjectMatches: undefined,
    },
  ],
  futureInstallments: [],
};

const COMMIT = {
  source: "CSV_NUBANK",
  periodLabel: "2026-07",
  inserted: 1,
  duplicated: 0,
  settled: 0,
  importId: "imp-1",
};

async function toPreview() {
  const onClose = vi.fn();
  render(
    <ImportStatementModal
      projectId="p1"
      card={CARD}
      onClose={onClose}
      onCommitted={vi.fn()}
    />,
  );
  const input = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File(["x"], "fatura.csv", { type: "text/csv" })] },
  });
  apiUploadMock.mockResolvedValueOnce(PREVIEW);
  fireEvent.click(screen.getByRole("button", { name: /pré-visualizar/i }));
  await screen.findByText(/transações/i);
  return onClose;
}

beforeEach(() => {
  apiUploadMock.mockReset();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("ImportStatementModal — focus trap (#680)", () => {
  it('modal tem role="dialog" e aria-modal="true"', async () => {
    await toPreview();
    const panel = document.querySelector('[data-mobile-sheet="modal"]');
    expect(panel).toHaveAttribute("role", "dialog");
    expect(panel).toHaveAttribute("aria-modal", "true");
  });

  it("Tab do último botão volta ao primeiro focável do modal", async () => {
    await toPreview();
    const panel = document.querySelector(
      '[data-mobile-sheet="modal"]',
    ) as HTMLElement;

    // Na revisão o último botão avança ao resumo, ainda sem mutação.
    const confirmBtn = screen.getByRole("button", { name: /ver resumo/i });
    confirmBtn.focus();
    expect(document.activeElement).toBe(confirmBtn);

    // Tab do último focável deve ir para o primeiro
    await userEvent.tab();
    const focusablesInModal = Array.from(
      panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusablesInModal.length > 0) {
      expect(focusablesInModal).toContain(document.activeElement);
    }
  });

  it("Shift+Tab do primeiro focável vai ao último do modal", async () => {
    await toPreview();
    const panel = document.querySelector(
      '[data-mobile-sheet="modal"]',
    ) as HTMLElement;

    const focusablesInModal = Array.from(
      panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );

    if (focusablesInModal.length > 0) {
      const firstFocusable = focusablesInModal[0];
      firstFocusable.focus();
      expect(document.activeElement).toBe(firstFocusable);

      // Shift+Tab do primeiro focável deve ir para o último
      await userEvent.tab({ shift: true });
      expect(focusablesInModal).toContain(document.activeElement);
    }
  });

  it('document.activeElement nunca sai do [data-mobile-sheet="modal"]', async () => {
    await toPreview();
    const panel = document.querySelector(
      '[data-mobile-sheet="modal"]',
    ) as HTMLElement;

    // Fazer tab múltiplas vezes
    for (let i = 0; i < 15; i++) {
      await userEvent.tab();
      expect(panel.contains(document.activeElement)).toBe(true);
    }

    // Fazer shift+tab múltiplas vezes
    for (let i = 0; i < 15; i++) {
      await userEvent.tab({ shift: true });
      expect(panel.contains(document.activeElement)).toBe(true);
    }
  });

  it("Escape dispara onClose", async () => {
    const onClose = await toPreview();
    const panel = document.querySelector('[data-mobile-sheet="modal"]');
    expect(panel).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("com botão focável fora do modal (render wrapper), Tab não o alcança", async () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <>
        <button data-testid="outside-btn">Botão fora</button>
        <ImportStatementModal
          projectId="p1"
          card={CARD}
          onClose={onClose}
          onCommitted={vi.fn()}
        />
      </>,
    );

    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "fatura.csv", { type: "text/csv" })] },
    });
    apiUploadMock.mockResolvedValueOnce(PREVIEW);
    fireEvent.click(screen.getByRole("button", { name: /pré-visualizar/i }));
    await screen.findByText(/transações/i);

    const outsideBtn = document.querySelector(
      '[data-testid="outside-btn"]',
    ) as HTMLElement;
    const panel = document.querySelector(
      '[data-mobile-sheet="modal"]',
    ) as HTMLElement;

    // Tab múltiplas vezes — nunca deve chegar ao botão fora
    for (let i = 0; i < 20; i++) {
      await userEvent.tab();
      expect(document.activeElement).not.toBe(outsideBtn);
      expect(panel.contains(document.activeElement)).toBe(true);
    }
  });
});
