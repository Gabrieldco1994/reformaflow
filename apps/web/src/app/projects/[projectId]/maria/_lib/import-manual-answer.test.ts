import { describe, expect, it } from "vitest";
import {
  deterministicVoiceAnswer,
  strictDraftAnswer,
} from "./import-manual-answer";

describe("strict deterministic manual answers", () => {
  it.each([
    ["amountCents", "R$ 1.234,56", { field: "amountCents", value: 123456 }],
    ["installmentCount", "3", { field: "installmentCount", value: 3 }],
    ["dataCompra", "11/10/2026", { field: "dataCompra", value: "2026-10-11" }],
    [
      "amountMeaning",
      "total da compra",
      { field: "amountMeaning", value: "TOTAL_PURCHASE" },
    ],
    ["merchant", "Loja Exemplo", { field: "merchant", value: "Loja Exemplo" }],
  ] as const)(
    "accepts one unambiguous voice %s value without submitting it",
    (field, transcript, expected) => {
      expect(deterministicVoiceAnswer(field, transcript)).toEqual(expected);
    },
  );

  it.each([
    ["amountCents", "cem ou duzentos"],
    ["installmentCount", "2 de 10"],
    ["dataCompra", "amanhã"],
    ["amountMeaning", "acho que total ou parcela"],
    ["decision", "criar"],
    ["targets", "sala"],
  ] as const)(
    "keeps ambiguous or unsupported voice %s manual",
    (field, text) => {
      expect(deterministicVoiceAnswer(field, text)).toBeNull();
    },
  );

  it("requires bounded integer, integral target and authorized decision", () => {
    expect(strictDraftAnswer("installmentCount", "0", {})).toBeNull();
    expect(strictDraftAnswer("installmentCount", "121", {})).toBeNull();
    expect(
      strictDraftAnswer("decision", "expense-2", {
        candidateExpenseIds: ["expense-1"],
      }),
    ).toBeNull();
    expect(
      strictDraftAnswer("targets", "target", {
        amountCents: 10_000,
        projectId: "project-2",
        roomId: "room-2",
      }),
    ).toEqual({
      field: "targets",
      value: [
        { projectId: "project-2", roomId: "room-2", amountCents: 10_000 },
      ],
    });
  });
});
