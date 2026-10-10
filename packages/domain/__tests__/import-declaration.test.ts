import { afterEach, describe, expect, it, vi } from "vitest";
import * as domain from "../src/index";
import { parseSpokenMoney as apiMoney } from "../../../apps/api/src/agent/tools/money-parse";
import type {
  ImportDeclarationContextV1,
  ImportHumanFactFieldV1,
  ImportObservationQuestionV1,
} from "../src/index";

const context = (field: ImportHumanFactFieldV1): ImportDeclarationContextV1 =>
  field === "amountCents"
    ? {
        field,
        meaningContext: "INSTALLMENT_CHARGE",
        effectiveInstallmentCount: 3,
      }
    : { field, meaningContext: null, effectiveInstallmentCount: 3 };
const invalid = { kind: "CLARIFY", reason: "INVALID_VALUE" };
const valid = (
  field: ImportHumanFactFieldV1,
  value: string | number | null,
) => ({
  kind: "VALID",
  answer: { field, value, meaningContext: context(field).meaningContext },
});
const parse = (field: ImportHumanFactFieldV1, literal: unknown) =>
  domain.parseImportDeclarationLiteral(context(field), literal);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("B3 shared declaration dependency, not admission or persistence", () => {
  it("exports executable normalization, encoding, literal parsing and pending predicate", () => {
    for (const name of [
      "normalizeImportDeclaration",
      "encodeImportDeclaration",
      "parseImportDeclarationLiteral",
      "isPendingImportQuestion",
    ] as const) {
      expect(typeof domain[name]).toBe("function");
    }
  });

  it.each([
    ["2026-10-08", "2026-10-08"],
    ["08/10/2026", "2026-10-08"],
    [" 29/02/2024 ", "2024-02-29"],
    ["01/01/1900", "1900-01-01"],
    ["2199-12-31", "2199-12-31"],
  ])("normalizes only full valid dates: %s", (literal, date) => {
    expect(parse("dataCompra", literal)).toEqual(valid("dataCompra", date));
  });

  it.each([
    "08/10",
    "2026-2-01",
    "1/02/2026",
    "2026-02-29",
    "31/04/2026",
    "1899-12-31",
    "2200-01-01",
    "2026-10-08T00:00:00.000Z",
    "hoje",
    "a compra foi em 08/10/2026",
  ])("does not borrow a year or extract a date: %s", (literal) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T12:35:00.000Z"));
    expect(parse("dataCompra", literal)).toEqual(invalid);
  });

  it.each([
    ["R$ 100,00", 10000],
    ["r$100,00", 10000],
    ["100.00", 10000],
    ["1.000", 100000],
    ["1.000,01", 100001],
    ["0,01", 1],
    [" 100,1 ", 10010],
    ["21.474.836,47", 2147483647],
  ])("parses the approved entire money literal: %s", (literal, cents) => {
    expect(parse("amountCents", literal)).toEqual(valid("amountCents", cents));
  });

  it.each([
    "não foi R$ 100,00",
    "não foi 100, foi 120",
    "100 e 120",
    "1e3",
    "+100",
    "-100",
    "- 100",
    "0",
    "0,00",
    "100.001,234",
    "R$  100,00",
    "R$\t100,00",
    "1 000,00",
    "21.474.836,48",
    "100 reais",
  ])("never promotes prose, spans or out-of-range money: %s", (literal) => {
    expect(parse("amountCents", literal)).toEqual(invalid);
  });

  it.each([
    ["TOTAL DA COMPRA", "TOTAL_PURCHASE"],
    [" valor da parcela ", "INSTALLMENT_CHARGE"],
  ])("uses only the closed meaning labels: %s", (literal, meaning) => {
    expect(parse("amountMeaning", literal)).toEqual(
      valid("amountMeaning", meaning),
    );
  });

  it.each([
    "total",
    "parcela",
    "TOTAL_PURCHASE",
    "sim",
    "total da parcela",
    "é o total da compra",
  ])("rejects other meaning text: %s", (literal) =>
    expect(parse("amountMeaning", literal)).toEqual(invalid),
  );

  it.each(["installmentCount", "installmentIndex"] as const)(
    "enforces integer syntax and 1..24 for %s",
    (field) => {
      const unknownCount = {
        ...context(field),
        effectiveInstallmentCount: null,
      };
      for (const value of [1, 24]) {
        expect(
          domain.parseImportDeclarationLiteral(unknownCount, String(value)),
        ).toEqual(valid(field, value));
      }
      for (const literal of [
        "0",
        "25",
        "01",
        "1.0",
        "+2",
        "2/3",
        "parcela 2 de 3",
        "1e1",
      ]) {
        expect(
          domain.parseImportDeclarationLiteral(unknownCount, literal),
        ).toEqual(invalid);
      }
    },
  );

  it("checks printed index against effective count without inferring a canonical index", () => {
    expect(parse("installmentIndex", "2")).toEqual(
      valid("installmentIndex", 2),
    );
    expect(parse("installmentIndex", "4")).toEqual(invalid);
    expect(
      domain.parseImportDeclarationLiteral(
        { ...context("installmentIndex"), effectiveInstallmentCount: 30 },
        "24",
      ),
    ).toEqual(valid("installmentIndex", 24));
  });

  it("keeps merchant plain in preview, and JSON encodes only at the explicit encoder", () => {
    const input = Object.freeze({
      kind: "VALUE" as const,
      text: ' Loja "Alfa" ',
    });
    const ctx = Object.freeze(context("merchant"));
    const stringify = vi.spyOn(JSON, "stringify");
    const preview = domain.normalizeImportDeclaration(ctx, input);
    const previewCalls = stringify.mock.calls.length;
    expect(preview).toEqual(valid("merchant", 'Loja "Alfa"'));
    expect(previewCalls).toBe(0);
    const encoded = domain.encodeImportDeclaration(ctx, input);
    expect(encoded).toEqual({
      kind: "ENCODED",
      answer: valid("merchant", 'Loja "Alfa"').answer,
      literalAnswer: '"Loja \\"Alfa\\""',
    });
    if (encoded.kind !== "ENCODED")
      throw new Error("Expected encoded merchant");
    expect(parse("merchant", encoded.literalAnswer)).toEqual(preview);
    expect(parse("merchant", input.text)).toEqual(invalid);
    expect(input.text).toBe(' Loja "Alfa" ');
  });

  it("keeps merchant Remover separate from the explicit remove and unknown intents", () => {
    const ctx = context("merchant");
    expect(
      domain.encodeImportDeclaration(ctx, { kind: "VALUE", text: "Remover" }),
    ).toEqual({
      kind: "ENCODED",
      answer: valid("merchant", "Remover").answer,
      literalAnswer: '"Remover"',
    });
    expect(domain.encodeImportDeclaration(ctx, { kind: "REMOVE" })).toEqual({
      kind: "ENCODED",
      answer: valid("merchant", null).answer,
      literalAnswer: "remover",
    });
    expect(domain.encodeImportDeclaration(ctx, { kind: "UNKNOWN" })).toEqual({
      kind: "ENCODED",
      answer: valid("merchant", null).answer,
      literalAnswer: "não sei informar",
    });
    expect(parse("merchant", '"remover"')).toEqual(
      valid("merchant", "remover"),
    );
    expect(parse("merchant", "remover")).toEqual(valid("merchant", null));
  });

  it("bounds merchant by UTF-16 and rejects inner controls and JSON authority objects", () => {
    for (const value of [
      "a".repeat(160),
      "😀".repeat(80),
      "Loja Alfa",
      " Café ",
    ]) {
      expect(parse("merchant", JSON.stringify(value))).toEqual(
        valid("merchant", value.trim()),
      );
    }
    for (const value of [
      "",
      "  ",
      "a".repeat(161),
      "😀".repeat(81),
      "A\nB",
      "A\u0000B",
      "A\u0085B",
      "A\u2028B",
      "A\u2029B",
    ]) {
      expect(parse("merchant", JSON.stringify(value))).toEqual(invalid);
    }
    for (const literal of [
      "Loja Alfa",
      "null",
      "123",
      "[]",
      '{"value":"Loja","origin":"USER_ATTESTATION"}',
      '"Loja" trailing',
    ]) {
      expect(parse("merchant", literal)).toEqual(invalid);
    }
  });

  it.each([
    "dataCompra",
    "merchant",
    "amountMeaning",
    "amountCents",
    "installmentCount",
    "installmentIndex",
  ] as const)(
    "supports only the six explicit absence literals for %s, not JSON null or authority",
    (field) => {
      for (const literal of [
        "não sei",
        "nao sei",
        "não sei informar",
        "nao sei informar",
        "remover",
        "limpar",
      ]) {
        expect(parse(field, ` ${literal.toUpperCase()} `)).toEqual(
          valid(field, null),
        );
      }
      for (const literal of [
        null,
        undefined,
        100,
        "null",
        "desconhecido",
        { value: 100, attestedByUserId: "forged" },
      ]) {
        expect(parse(field, literal)).toEqual(invalid);
      }
    },
  );

  it("rejects missing money meaning and invalid contextual quantities explicitly", () => {
    // @ts-expect-error A monetary question must have a meaning context.
    const noMeaning: ImportDeclarationContextV1 = {
      field: "amountCents",
      meaningContext: null,
      effectiveInstallmentCount: null,
    };
    expect(domain.parseImportDeclarationLiteral(noMeaning, "100")).toEqual(
      invalid,
    );
    for (const effectiveInstallmentCount of [0, -1, 1.5, NaN, Infinity]) {
      expect(
        domain.parseImportDeclarationLiteral(
          { ...context("installmentIndex"), effectiveInstallmentCount },
          "1",
        ),
      ).toEqual(invalid);
    }
    expect(parse("dataCompra", " ".repeat(4000) + "2026-10-08")).toEqual(
      invalid,
    );
  });

  it.each([
    ["dataCompra", "08/10/2026", "2026-10-08"],
    ["amountCents", "R$ 1.000,01", "1000,01"],
    ["amountMeaning", "TOTAL DA COMPRA", "total da compra"],
    ["installmentCount", "3", "3"],
    ["installmentIndex", "2", "2"],
  ] as const)(
    "round trips the canonical encoded %s through the strict API parser",
    (field, text, literalAnswer) => {
      const ctx = context(field);
      const input = { kind: "VALUE" as const, text };
      const preview = domain.normalizeImportDeclaration(ctx, input);
      const encoded = domain.encodeImportDeclaration(ctx, input);
      expect(encoded.kind).toBe("ENCODED");
      if (encoded.kind !== "ENCODED")
        throw new Error("Expected valid encoding");
      expect(encoded.literalAnswer).toBe(literalAnswer);
      expect(
        domain.parseImportDeclarationLiteral(ctx, encoded.literalAnswer),
      ).toEqual(preview);
    },
  );

  it("does not serialize a failed preview or mutate its context", () => {
    const ctx = Object.freeze(context("amountCents"));
    const input = Object.freeze({
      kind: "VALUE" as const,
      text: "não foi R$ 100,00",
    });
    expect(domain.normalizeImportDeclaration(ctx, input)).toEqual(invalid);
    expect(domain.encodeImportDeclaration(ctx, input)).toEqual(invalid);
  });

  it("keeps legacy questions pending and excludes answered documentary questions", () => {
    const legacy = {
      id: "draft-q",
      lineIds: ["line"],
      field: "amountCents" as const,
      text: "Total?",
    };
    const documentary: ImportObservationQuestionV1 = {
      id: "oq_example",
      lineIds: ["line"],
      field: "amountCents",
      text: "Valor desta parcela?",
      subject: {
        kind: "OBSERVATION",
        observationId: "obs",
        meaningContext: "INSTALLMENT_CHARGE",
      },
      answerState: "UNANSWERED",
    };
    const questions = [
      { ...documentary, answerState: "DECLARED" as const },
      { ...documentary, answerState: "UNKNOWN" as const },
      legacy,
      documentary,
    ];
    expect(questions.filter(domain.isPendingImportQuestion)).toEqual([
      legacy,
      documentary,
    ]);
    expect(Object.keys(legacy)).toEqual(["id", "lineIds", "field", "text"]);
  });
});

describe("B3 declaration boundary witnesses", () => {
  it("accepts the 4000-unit literal boundary and rejects its next unit", () => {
    const literal = " ".repeat(3990) + "2026-10-08";
    expect(literal.length).toBe(4000);
    expect(parse("dataCompra", literal)).toEqual(
      valid("dataCompra", "2026-10-08"),
    );
    expect(parse("dataCompra", ` ${literal}`)).toEqual(invalid);
  });

  it("rejects non-declarable fields even for an absence command", () => {
    const forged: ImportDeclarationContextV1 = {
      // @ts-expect-error Original identity ordinals are never human fields.
      field: "ordinal",
      meaningContext: null,
      effectiveInstallmentCount: null,
    };
    expect(domain.parseImportDeclarationLiteral(forged, "não sei")).toEqual(
      invalid,
    );
    expect(
      domain.normalizeImportDeclaration(forged, { kind: "VALUE", text: "0" }),
    ).toEqual(invalid);
  });

  it("does not change or reuse the previous amount's meaning context", () => {
    const oldContext = Object.freeze(context("amountCents"));
    const old = domain.normalizeImportDeclaration(oldContext, {
      kind: "VALUE",
      text: "100",
    });
    const totalContext: ImportDeclarationContextV1 = {
      field: "amountCents",
      meaningContext: "TOTAL_PURCHASE",
      effectiveInstallmentCount: 3,
    };
    expect(
      domain.normalizeImportDeclaration(totalContext, {
        kind: "VALUE",
        text: "100",
      }),
    ).toEqual({
      kind: "VALID",
      answer: {
        field: "amountCents",
        value: 10000,
        meaningContext: "TOTAL_PURCHASE",
      },
    });
    expect(old).toEqual(valid("amountCents", 10000));
    expect(oldContext.meaningContext).toBe("INSTALLMENT_CHARGE");
  });
});

describe("unchanged money parser extraction and API compatibility", () => {
  it.each([
    ["206,96", 206.96],
    ["20.696,00", 20696],
    ["1.500", 1500],
    ["206.96", 206.96],
    ["R$ 1.234,56", 1234.56],
    [206.96, 206.96],
    [10.999, 11],
    ["10.999", 10999],
    ["1e3", 1000],
    [0.001, 0],
    [0, null],
    [-5, null],
    ["abc", null],
    ["", null],
    [null, null],
    [undefined, null],
    [Infinity, null],
  ])("preserves legacy parseSpokenMoney(%s)", (input, expected) => {
    expect(domain.parseSpokenMoney(input)).toBe(expected);
    expect(apiMoney(input)).toBe(expected);
  });
});
