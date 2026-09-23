import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Expense } from "@/types";
import { groupExpensesByMes } from "../_lib/grouping-by-month";
import { CategoryExpenseView } from "./CategoryExpenseView";
import { MonthlyExpenseView } from "./MonthlyExpenseView";

afterEach(() => vi.useRealTimers());

describe.each(["category", "monthly"] as const)(
  "settlement action gates — %s",
  (view) => {
    it.each([0, 40_000])(
      "gates financial actions by paid cents, not summary presence: %s",
      (paidCents) => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-09-23T12:00:00Z"));
        const expense: Expense = {
          id: "contract",
          titulo: "Contrato",
          tipoDespesa: "OUTROS",
          valor: 80_000,
          quantidade: 1,
          valorTotal: 80_000,
          formaPagamento: "PARCELADO",
          quantidadeParcela: 1,
          dataInicioParcela: "2026-10-10",
          status: "PLANEJADO",
          installmentSettlements: [
            {
              parcelaIndex: 0,
              dueDate: "2026-10-10T00:00:00.000Z",
              contractedCents: 80_000,
              paidCents,
              remainingCents: 80_000 - paidCents,
              settlementStatus: paidCents ? "PARTIAL" : "UNPAID",
              contributions: paidCents
                ? [
                    {
                      settlementId: "funding",
                      sourceId: "source",
                      amountCents: paidCents,
                      paymentDate: "2026-09-10T00:00:00.000Z",
                    },
                  ]
                : [],
            },
          ],
        };
        const props = {
          tipoLabel: (value: string) => value,
          emptyMsg: "vazio",
          openEdit: vi.fn(),
          onDelete: vi.fn(),
          onToggleStatus: vi.fn(),
          onQuickUpdate: vi.fn(),
          onQuickCreate: vi.fn(),
        };
        render(
          view === "monthly" ? (
            <MonthlyExpenseView
              {...props}
              grouped={groupExpensesByMes([expense])}
              collapsedMonths={new Set()}
              toggleMonth={vi.fn()}
              tipoOptions={[]}
            />
          ) : (
            <CategoryExpenseView
              {...props}
              categorias={[
                {
                  tipo: "OUTROS",
                  label: "Outros",
                  total: 80_000,
                  totalPago: paidCents,
                  totalPlanejado: 80_000 - paidCents,
                  expenses: [expense],
                },
              ]}
              collapsedCategories={new Set()}
              toggleCategory={vi.fn()}
            />
          ),
        );

        const status = screen.getByRole("button", { name: "Planejado" });
        const edits = screen.getAllByRole("button", { name: "Editar rápido" });
        if (paidCents > 0) {
          expect(status).toBeDisabled();
          edits.forEach((edit) => expect(edit).toBeDisabled());
          return;
        }
        fireEvent.click(status);
        expect(props.onToggleStatus).toHaveBeenCalledWith("contract", "PAGO");
        fireEvent.click(
          screen.getByRole("button", { name: "Editar completo" }),
        );
        expect(props.openEdit).toHaveBeenCalledWith(
          expect.objectContaining({ id: "contract" }),
        );
        fireEvent.click(edits[0]);
        fireEvent.click(
          screen.getByRole("button", {
            name: view === "monthly" ? "Salvar data da parcela" : "Salvar",
          }),
        );
        if (view === "monthly") {
          expect(props.onQuickUpdate).toHaveBeenCalledWith({
            id: "contract",
            data: "2026-10-10",
            parcela: 0,
          });
        } else {
          expect(props.onQuickUpdate).toHaveBeenCalledWith(
            "contract",
            800,
            "2026-10-10",
          );
        }
      },
    );
  },
);
