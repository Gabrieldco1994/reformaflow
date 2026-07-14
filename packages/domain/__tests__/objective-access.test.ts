import { describe, expect, it } from "vitest";
import * as domain from "../src";

const TYPES = [
  "REFORMA",
  "COMPRA",
  "CASA",
  "CARRO",
  "PESSOAL",
  "PLANTAS",
] as const;
const derive = (
  domain as unknown as {
    deriveObjectiveAccess: (types: readonly string[]) => {
      allowedProjectTypes: string[];
      allowedModules: string[];
    };
  }
).deriveObjectiveAccess;

describe("canonical objective authorization", () => {
  it("maps all objectives to exact types and the deterministic canonical feature union", () => {
    expect(typeof derive).toBe("function");
    expect(derive(TYPES)).toEqual({
      allowedProjectTypes: [...TYPES],
      allowedModules: [
        "expenses",
        "receipts",
        "cashFlow",
        "dashboard",
        "rooms",
        "floorPlans",
        "simulation",
        "priceCompare",
        "pendencias",
        "recurringBills",
        "maintenance",
        "reminders",
        "monthlyOverview",
        "creditCards",
        "bankAccounts",
        "plantsAi",
      ],
    });
  });

  it("preserves objective order while deduplicating shared modules exactly once", () => {
    const result = derive(["CASA", "CARRO"]);
    expect(result).toEqual({
      allowedProjectTypes: ["CASA", "CARRO"],
      allowedModules: [
        "dashboard",
        "recurringBills",
        "maintenance",
        "reminders",
        "expenses",
      ],
    });
    expect(new Set(result.allowedModules).size).toBe(
      result.allowedModules.length,
    );
  });

  it("never infers an unselected objective from shared modules", () => {
    const result = derive(["CASA"]);
    expect(result.allowedProjectTypes).toEqual(["CASA"]);
    expect(result.allowedProjectTypes).not.toContain("CARRO");
  });
});
