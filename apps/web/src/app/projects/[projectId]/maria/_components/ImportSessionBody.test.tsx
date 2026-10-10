import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { lookupNames } from "../_lib/import-receipt-view";
import { IMPORT_STATE_LABEL } from "../_lib/import-session-copy";
import { viewFixture } from "../_lib/import-session-fixtures";
import {
  workflowFixture,
  declarationViewFixture,
  declarationQuestionFixture,
  declaredFactFixture,
} from "../_lib/import-workflow-fixtures";
import { ImportSessionBody } from "./ImportSessionBody";

const names = lookupNames({ cards: [{ id: "card-1", nickname: "Nubank" }] });
const STATES = [
  "DRAFT",
  "ANALYZING",
  "NEEDS_INPUT",
  "READY",
  "CONFIRMED",
  "APPLIED",
  "REVIEW_REQUIRED",
  "CANCELLED",
  "EXPIRED",
] as const;

describe("ImportSessionBody (read-only, future-state fixtures)", () => {
  it.each(["DECLARED", "UNKNOWN"] as const)(
    "B3 recovery never calls a retained %s answer a pending question or offers a write",
    (state) => {
      const wire = {
        ...declarationViewFixture(),
        questions: [declarationQuestionFixture("first", state)],
        declaredFacts: [
          declaredFactFixture(
            "first",
            state === "DECLARED" ? "CURRENT" : "UNKNOWN",
          ),
        ],
      };
      render(<ImportSessionBody view={wire} names={names} />);
      expect(screen.getByText(wire.questions[0].text)).toBeInTheDocument();
      expect(screen.getByText("Compras no rascunho")).toBeInTheDocument();
      expect(
        screen.getAllByText("Compra documental com descrição extensa"),
      ).toHaveLength(2);
      expect(screen.queryByText("Perguntas pendentes")).toBeNull();
      expect(screen.queryAllByRole("button")).toHaveLength(0);
    },
  );

  it.each(["DECLARED", "UNKNOWN"] as const)(
    "B3 mixed recovery keeps %s content while only UNANSWERED is presented as pending",
    (state) => {
      const retained = declarationQuestionFixture("first", state);
      const pending = declarationQuestionFixture("twin");
      const wire = {
        ...declarationViewFixture(),
        questions: [retained, pending],
        declaredFacts: [
          declaredFactFixture(
            "first",
            state === "DECLARED" ? "CURRENT" : "UNKNOWN",
          ),
        ],
      };
      render(<ImportSessionBody view={wire} names={names} />);
      expect(screen.getByText(retained.text)).toBeInTheDocument();
      expect(
        screen.getAllByText("Compra documental com descrição extensa"),
      ).toHaveLength(2);
      const pendingSection = screen
        .getByText("Perguntas pendentes")
        .closest("section");
      if (!pendingSection)
        throw new Error("Missing visible pending-question section");
      expect(
        within(pendingSection).getByText(pending.text),
      ).toBeInTheDocument();
      expect(within(pendingSection).queryByText(retained.text)).toBeNull();
      expect(screen.queryAllByRole("button")).toHaveLength(0);
    },
  );

  it("X3 shows combined blockers and real document completion but never offers analyze/edit", () => {
    const view = workflowFixture();
    view.proposal = null;
    view.actions = ["ANALYZE", "RESOLVE", "CANCEL"];
    view.attachments[0].materializedInSession = false;
    view.attachments[0].canAnalyze = true;
    view.reviewBlockers = [
      {
        lineId: "first",
        code: "ORIGINAL_IDENTITY_INCOMPLETE",
        resolution: "SEARCH_IDENTITY_UNAVAILABLE",
      },
      {
        lineId: "first",
        code: "ORIGINAL_OCCURRENCE_INCOMPLETE",
        resolution: "SEARCH_IDENTITY_UNAVAILABLE",
      },
    ];
    const h = render(<ImportSessionBody view={view} names={names} />);
    expect(screen.getAllByText("Verificação documental pendente")).toHaveLength(
      1,
    );
    expect(screen.getByText("Análise documental pendente")).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    h.rerender(
      <ImportSessionBody
        view={{ ...view, selectedLineIds: ["twin"] }}
        names={names}
      />,
    );
    expect(
      screen.getByText("Fora deste lote · verificação pendente"),
    ).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
  it.each(STATES)(
    "renders %s with its own label and no control at all",
    (state) => {
      render(
        <ImportSessionBody
          view={viewFixture({ state, actions: [] })}
          names={names}
        />,
      );
      expect(
        screen.getByRole("heading", {
          name: new RegExp(IMPORT_STATE_LABEL[state]),
        }),
      ).toBeInTheDocument();
      expect(screen.queryAllByRole("button")).toHaveLength(0);
    },
  );

  it("lists draft lines with exact cents and the meaning of the amount", () => {
    render(
      <ImportSessionBody
        names={names}
        view={viewFixture({
          state: "NEEDS_INPUT",
          lines: [
            {
              id: "l1",
              observationIds: [],
              titulo: "Sofá",
              fornecedor: null,
              tipoDespesa: null,
              categoriaMaoDeObra: null,
              amountMeaning: "INSTALLMENT_CHARGE",
              amountCents: 12_345_678,
              installmentCount: 3,
              dataCompra: "2026-09-20",
              firstDueDate: null,
              targets: null,
              decision: { kind: "UNRESOLVED" },
            },
          ],
        })}
      />,
    );
    expect(screen.getByText("Sofá")).toBeInTheDocument();
    expect(screen.getByText("R$ 123.456,78")).toBeInTheDocument();
    expect(screen.getByText("Valor da parcela")).toBeInTheDocument();
    expect(screen.getByText(/20\/09\/2026/)).toBeInTheDocument();
  });

  it("shows the document count when the retention deadline is gone (terminal state)", () => {
    render(
      <ImportSessionBody
        view={viewFixture({ state: "CANCELLED", expiresAt: null, actions: [] })}
        names={names}
      />,
    );
    expect(screen.queryByText(/Guardada até/)).toBeNull();
    expect(screen.getByText("1 documento")).toBeInTheDocument();
  });

  it("does not throw for handlers it does not have", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<ImportSessionBody view={viewFixture()} names={names} />);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
