import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ManagementDashboard from "./ManagementDashboard";

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => {
    if (queryKey[0] === "recurring-bills")
      return {
        data: [
          {
            id: "bill-1",
            nome: "Energia",
            valor: 20696,
            categoria: "OUTROS",
            frequencia: "MENSAL",
            diaVencimento: 5,
            status: "ATIVO",
          },
        ],
      };
    if (queryKey[0] === "maintenance-logs")
      return {
        data: [
          {
            id: "maintenance-1",
            tipo: "Revisão elétrica",
            dataRealizada: "2026-06-01T12:00:00-03:00",
            dataProxima: "2026-07-20T12:00:00-03:00",
            custo: 15000,
          },
        ],
      };
    if (queryKey[0] === "financing")
      return {
        data: {
          sistema: "PRICE",
          valorTotalFinanciado: 30000000,
          summary: {
            valorPago: 1000000,
            saldoDevedor: 29000000,
            progresso: 3,
            totalParcelas: 360,
            parcelasPagas: 10,
            proximaParcela: {
              numeroParcela: 11,
              dataVencimento: "2026-08-10T00:00:00.000Z",
              valorPrevisto: 250000,
            },
          },
        },
      };
    return {
      data: [
        {
          id: "reminder-1",
          titulo: "Trocar filtro",
          data: "2026-07-18T12:00:00-03:00",
          prioridade: "ALTA",
          recorrencia: "NENHUMA",
          status: "PENDENTE",
        },
      ],
    };
  },
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}));

describe.each(["CASA", "CARRO"])(
  "ManagementDashboard %s hierarchy",
  (projectType) => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-11T12:00:00-03:00"));
    });
    afterEach(() => vi.useRealTimers());
    it("preserves exact Glance, Focus, Detail routes and dense desktop content", () => {
      render(
        <ManagementDashboard projectId="project-7" projectType={projectType} />,
      );
      const glance = screen.getByRole("region", { name: "Relance de gestão" });
      expect(glance).toHaveTextContent("R$ 206,96");
      expect(glance).toHaveTextContent("Contas ativas1");
      expect(
        within(glance)
          .getAllByRole("link")
          .map((link) => link.getAttribute("href")),
      ).toEqual([
        "/projects/project-7/bills",
        "/projects/project-7/bills",
        "/projects/project-7/maintenance",
        "/projects/project-7/reminders",
      ]);
      for (const link of within(glance).getAllByRole("link"))
        expect(link.className).toContain("min-h-[44px]");
      const trigger = screen.getByRole("button", {
        name: /Contas Recorrentes/,
      });
      const panelId = trigger.getAttribute("aria-controls");
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(trigger);
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      const panel = document.getElementById(panelId!);
      expect(panel).toHaveTextContent("Energia");
      expect(within(panel!).getByRole("link")).toHaveAttribute(
        "href",
        "/projects/project-7/bills",
      );
      expect(within(panel!).getByRole("link").className).toContain(
        "min-h-[44px]",
      );
      expect(trigger.querySelector("svg")?.className.baseVal).toContain(
        "motion-reduce:transition-none",
      );
      expect(screen.getAllByText("Energia").length).toBe(2);
      expect(
        screen.getAllByText("Revisão elétrica").length,
      ).toBeGreaterThanOrEqual(1);
      expect(
        screen.getAllByText("Trocar filtro").length,
      ).toBeGreaterThanOrEqual(1);
      expect(document.body).not.toHaveTextContent(
        /quilometragem|veículo|placa|combustível/i,
      );
      if (projectType === "CASA") {
        expect(screen.getByRole("progressbar", { name: "Progresso do financiamento" }))
          .toHaveAttribute("aria-valuenow", "3");
        expect(screen.getByRole("link", { name: "Ver detalhes" })).toHaveAttribute(
          "href",
          "/projects/project-7/financing",
        );
      } else {
        expect(screen.queryByText("Saldo Devedor")).not.toBeInTheDocument();
      }
    });
  },
);
