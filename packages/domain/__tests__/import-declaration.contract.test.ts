import { describe, expect, it } from "vitest";
import {
  encodeImportDeclaration,
  isPendingImportQuestion,
  normalizeImportDeclaration,
  parseImportDeclarationLiteral,
  parseSpokenMoney,
  type ImportDeclarationContextV1,
  type ImportDeclarationUiInputV1,
  type ImportObservationQuestionV1,
  type ImportSessionDraftFieldV1,
} from "@reformaflow/domain";

const money: ImportDeclarationContextV1 = {
  field: "amountCents",
  meaningContext: "TOTAL_PURCHASE",
  effectiveInstallmentCount: 3,
};
const merchant: ImportDeclarationContextV1 = {
  field: "merchant",
  meaningContext: null,
  effectiveInstallmentCount: null,
};
const invalid = { kind: "CLARIFY", reason: "INVALID_VALUE" };
const value = (text: string): ImportDeclarationUiInputV1 => ({
  kind: "VALUE",
  text,
});

describe("independent B3 declaration helper contract on the accepted STOP1 exports", () => {
  it.each([
    ["206,96", 20696, "206,96"],
    ["20.696,00", 2069600, "20696,00"],
    ["1.500", 150000, "1500,00"],
    ["206.96", 20696, "206,96"],
    ["1.000", 100000, "1000,00"],
    [" R$ 100,00 ", 10000, "100,00"],
    ["0,01", 1, "0,01"],
    ["21474836,47", 2147483647, "21474836,47"],
  ] as const)(
    "money %s is integer cents %i, with exact canonical transport %s",
    (literal, cents, encoded) => {
      const expected = {
        field: "amountCents",
        value: cents,
        meaningContext: "TOTAL_PURCHASE",
      };
      expect(normalizeImportDeclaration(money, value(literal))).toEqual({
        kind: "VALID",
        answer: expected,
      });
      expect(parseImportDeclarationLiteral(money, literal)).toEqual({
        kind: "VALID",
        answer: expected,
      });
      expect(encodeImportDeclaration(money, value(literal))).toEqual({
        kind: "ENCODED",
        answer: expected,
        literalAnswer: encoded,
      });
      expect(parseImportDeclarationLiteral(money, encoded)).toEqual({
        kind: "VALID",
        answer: expected,
      });
    },
  );

  it("the unchanged general money parser returns reais, not declaration cents", () => {
    expect(parseSpokenMoney("206,96")).toBe(206.96);
    expect(parseSpokenMoney("20.696,00")).toBe(20696);
    expect(parseSpokenMoney("1.500")).toBe(1500);
    expect(parseSpokenMoney("206.96")).toBe(206.96);
    for (const bad of [0, -1, NaN, Infinity, null, "nonsense"]) {
      expect(parseSpokenMoney(bad)).toBeNull();
    }
  });

  it("closed money grammar rejects negation, multiple values, signs and overflow without extracting spans", () => {
    expect(parseImportDeclarationLiteral(money, "100,00")).toEqual({
      kind: "VALID",
      answer: {
        field: "amountCents",
        value: 10000,
        meaningContext: "TOTAL_PURCHASE",
      },
    });
    for (const literal of [
      "n\u00e3o foi R$ 100,00",
      "nao foi 100, foi 120",
      "100 e 120",
      "sim",
      "+100",
      "-1",
      "0",
      "0,00",
      "1e2",
      "1.2345",
      "1,000",
      "R$  100",
      "21474836,48",
      "9007199254740992",
      "null",
    ]) {
      expect(normalizeImportDeclaration(money, value(literal))).toEqual(
        invalid,
      );
      expect(parseImportDeclarationLiteral(money, literal)).toEqual(invalid);
      expect(encodeImportDeclaration(money, value(literal))).toEqual(invalid);
    }
  });

  it("amount context is preserved and never multiplies a charge by installment count", () => {
    const installment: ImportDeclarationContextV1 = {
      field: "amountCents",
      meaningContext: "INSTALLMENT_CHARGE",
      effectiveInstallmentCount: 3,
    };
    const input = Object.freeze(value("100,00"));
    const before = { ...installment };
    expect(normalizeImportDeclaration(installment, input)).toEqual({
      kind: "VALID",
      answer: {
        field: "amountCents",
        value: 10000,
        meaningContext: "INSTALLMENT_CHARGE",
      },
    });
    expect(encodeImportDeclaration(installment, input)).toEqual({
      kind: "ENCODED",
      literalAnswer: "100,00",
      answer: {
        field: "amountCents",
        value: 10000,
        meaningContext: "INSTALLMENT_CHARGE",
      },
    });
    expect(installment).toEqual(before);
    expect(input).toEqual({ kind: "VALUE", text: "100,00" });
  });

  it("complete dates use explicit years, calendar validation and literal 1900..2199 bounds", () => {
    const context: ImportDeclarationContextV1 = {
      field: "dataCompra",
      meaningContext: null,
      effectiveInstallmentCount: null,
    };
    for (const [text, date] of [
      ["08/10/2026", "2026-10-08"],
      ["2026-10-08", "2026-10-08"],
      ["9 de outubro de 2026", "2026-10-09"],
      ["29/02/2000", "2000-02-29"],
      ["01/01/1900", "1900-01-01"],
      ["31/12/2199", "2199-12-31"],
    ]) {
      const answer = { field: "dataCompra", value: date, meaningContext: null };
      expect(normalizeImportDeclaration(context, value(text))).toEqual({
        kind: "VALID",
        answer,
      });
      expect(parseImportDeclarationLiteral(context, text)).toEqual({
        kind: "VALID",
        answer,
      });
      expect(encodeImportDeclaration(context, value(text))).toEqual({
        kind: "ENCODED",
        answer,
        literalAnswer: date,
      });
    }
    for (const text of [
      "08/10",
      "8/10/2026",
      "2026-1-08",
      "29/02/1900",
      "2026-02-30",
      "1899-12-31",
      "2200-01-01",
      "2026-10-08T00:00:00Z",
      "dia 08/10/2026",
    ]) {
      expect(normalizeImportDeclaration(context, value(text))).toEqual(invalid);
      expect(parseImportDeclarationLiteral(context, text)).toEqual(invalid);
      expect(encodeImportDeclaration(context, value(text))).toEqual(invalid);
    }
  });

  it("meaning has only two case-insensitive whole-literal choices", () => {
    const context: ImportDeclarationContextV1 = {
      field: "amountMeaning",
      meaningContext: null,
      effectiveInstallmentCount: null,
    };
    for (const [text, meaning, literal] of [
      [" TOTAL DA COMPRA ", "TOTAL_PURCHASE", "total da compra"],
      ["VaLoR Da PaRcElA", "INSTALLMENT_CHARGE", "valor da parcela"],
    ]) {
      const answer = {
        field: "amountMeaning",
        value: meaning,
        meaningContext: null,
      };
      expect(normalizeImportDeclaration(context, value(text))).toEqual({
        kind: "VALID",
        answer,
      });
      expect(parseImportDeclarationLiteral(context, text)).toEqual({
        kind: "VALID",
        answer,
      });
      expect(encodeImportDeclaration(context, value(text))).toEqual({
        kind: "ENCODED",
        answer,
        literalAnswer: literal,
      });
    }
    for (const text of [
      "TOTAL_PURCHASE",
      "parcela",
      "acho que total da compra",
      "total da compra ou valor da parcela",
    ]) {
      expect(parseImportDeclarationLiteral(context, text)).toEqual(invalid);
    }
  });

  it.each(["installmentCount", "installmentIndex"] as const)(
    "%s is a whole integer 1..24, never an inferred printed fraction",
    (field) => {
      const context: ImportDeclarationContextV1 = {
        field,
        meaningContext: null,
        effectiveInstallmentCount: null,
      };
      for (const [text, number] of [
        ["1", 1],
        ["24", 24],
      ] as const) {
        const answer = { field, value: number, meaningContext: null };
        expect(normalizeImportDeclaration(context, value(text))).toEqual({
          kind: "VALID",
          answer,
        });
        expect(parseImportDeclarationLiteral(context, text)).toEqual({
          kind: "VALID",
          answer,
        });
        expect(encodeImportDeclaration(context, value(text))).toEqual({
          kind: "ENCODED",
          answer,
          literalAnswer: text,
        });
      }
      for (const text of [
        "0",
        "-1",
        "25",
        "01",
        "+2",
        "2.0",
        "2/3",
        "parcela 2 de 3",
        "9007199254740992",
      ]) {
        expect(normalizeImportDeclaration(context, value(text))).toEqual(
          invalid,
        );
        expect(parseImportDeclarationLiteral(context, text)).toEqual(invalid);
      }
    },
  );

  it("normalizes a bounded Portuguese installment count without model inference", () => {
    const context: ImportDeclarationContextV1 = {
      field: "installmentCount",
      meaningContext: null,
      effectiveInstallmentCount: null,
    };
    expect(
      normalizeImportDeclaration(context, value("vinte e quatro parcelas")),
    ).toEqual({
      kind: "VALID",
      answer: {
        field: "installmentCount",
        value: 24,
        meaningContext: null,
      },
    });
    expect(
      encodeImportDeclaration(context, value("vinte e quatro parcelas")),
    ).toEqual({
      kind: "ENCODED",
      answer: {
        field: "installmentCount",
        value: 24,
        meaningContext: null,
      },
      literalAnswer: "24",
    });
    expect(
      normalizeImportDeclaration(
        { ...context, field: "installmentIndex" },
        value("vinte e quatro parcelas"),
      ),
    ).toEqual(invalid);
    expect(
      normalizeImportDeclaration(context, value("vinte e cinco parcelas")),
    ).toEqual(invalid);
  });

  it("effective count bounds the human printed index, not the count answer", () => {
    const index: ImportDeclarationContextV1 = {
      field: "installmentIndex",
      meaningContext: null,
      effectiveInstallmentCount: 3,
    };
    expect(parseImportDeclarationLiteral(index, "3")).toEqual({
      kind: "VALID",
      answer: { field: "installmentIndex", value: 3, meaningContext: null },
    });
    expect(parseImportDeclarationLiteral(index, "4")).toEqual(invalid);
    expect(
      parseImportDeclarationLiteral(
        { ...index, effectiveInstallmentCount: null },
        "4",
      ),
    ).toEqual({
      kind: "VALID",
      answer: { field: "installmentIndex", value: 4, meaningContext: null },
    });
    expect(
      parseImportDeclarationLiteral(
        {
          field: "installmentCount",
          meaningContext: null,
          effectiveInstallmentCount: 3,
        },
        "4",
      ),
    ).toEqual({
      kind: "VALID",
      answer: { field: "installmentCount", value: 4, meaningContext: null },
    });
  });

  it("merchant is plain during normalization and a whole JSON string only in transport", () => {
    const input = Object.freeze(value('  Loja "Alfa"  '));
    const answer = {
      field: "merchant",
      value: 'Loja "Alfa"',
      meaningContext: null,
    };
    expect(normalizeImportDeclaration(merchant, input)).toEqual({
      kind: "VALID",
      answer,
    });
    expect(encodeImportDeclaration(merchant, input)).toEqual({
      kind: "ENCODED",
      answer,
      literalAnswer: '"Loja \\"Alfa\\""',
    });
    expect(
      parseImportDeclarationLiteral(merchant, '"Loja \\"Alfa\\""'),
    ).toEqual({ kind: "VALID", answer });
    expect(input).toEqual({ kind: "VALUE", text: '  Loja "Alfa"  ' });
    for (const literal of [
      "Loja Alfa",
      '{"merchant":"Loja Alfa"}',
      '["Loja Alfa"]',
      "123",
      "true",
      "null",
    ]) {
      expect(parseImportDeclarationLiteral(merchant, literal)).toEqual(invalid);
    }
  });

  it("merchant length is measured in UTF-16 units, with controls rejected after decoding", () => {
    for (const name of ["A", "A".repeat(160), "\ud83d\ude00".repeat(80)]) {
      const answer = { field: "merchant", value: name, meaningContext: null };
      expect(normalizeImportDeclaration(merchant, value(name))).toEqual({
        kind: "VALID",
        answer,
      });
      expect(
        parseImportDeclarationLiteral(merchant, JSON.stringify(name)),
      ).toEqual({ kind: "VALID", answer });
    }
    for (const name of [
      "",
      " ",
      "A".repeat(161),
      "\ud83d\ude00".repeat(81),
      "Loja\nAlfa",
      "Loja\u0000Alfa",
      "Loja\u007fAlfa",
      "Loja\u0085Alfa",
      "Loja\u2028Alfa",
      "Loja\u2029Alfa",
    ]) {
      expect(normalizeImportDeclaration(merchant, value(name))).toEqual(
        invalid,
      );
      expect(
        parseImportDeclarationLiteral(merchant, JSON.stringify(name)),
      ).toEqual(invalid);
    }
  });

  it("merchant named Remover is distinct from UNKNOWN and REMOVE actions", () => {
    const answer = {
      field: "merchant",
      value: "Remover",
      meaningContext: null,
    };
    expect(normalizeImportDeclaration(merchant, value("Remover"))).toEqual({
      kind: "VALID",
      answer,
    });
    expect(encodeImportDeclaration(merchant, value("Remover"))).toEqual({
      kind: "ENCODED",
      answer,
      literalAnswer: '"Remover"',
    });
    expect(parseImportDeclarationLiteral(merchant, '"Remover"')).toEqual({
      kind: "VALID",
      answer,
    });
    expect(encodeImportDeclaration(merchant, { kind: "REMOVE" })).toEqual({
      kind: "ENCODED",
      answer: { ...answer, value: null },
      literalAnswer: "remover",
    });
    expect(encodeImportDeclaration(merchant, { kind: "UNKNOWN" })).toEqual({
      kind: "ENCODED",
      answer: { ...answer, value: null },
      literalAnswer: "n\u00e3o sei informar",
    });
    expect(parseImportDeclarationLiteral(merchant, "Remover")).toEqual({
      kind: "VALID",
      answer: { ...answer, value: null },
    });
  });

  it("absence commands preserve each field's context without becoming a financial fact", () => {
    const contexts: ImportDeclarationContextV1[] = [
      {
        field: "dataCompra",
        meaningContext: null,
        effectiveInstallmentCount: null,
      },
      merchant,
      {
        field: "amountMeaning",
        meaningContext: null,
        effectiveInstallmentCount: null,
      },
      { ...money, meaningContext: "INSTALLMENT_CHARGE" },
      {
        field: "installmentCount",
        meaningContext: null,
        effectiveInstallmentCount: null,
      },
      {
        field: "installmentIndex",
        meaningContext: null,
        effectiveInstallmentCount: null,
      },
    ];
    for (const context of contexts) {
      const answer = {
        field: context.field,
        value: null,
        meaningContext: context.meaningContext,
      };
      for (const literal of [
        "n\u00e3o sei",
        "nao sei",
        "n\u00e3o sei informar",
        "nao sei informar",
        " REMOVER ",
        "LIMPAR",
      ]) {
        expect(parseImportDeclarationLiteral(context, literal)).toEqual({
          kind: "VALID",
          answer,
        });
      }
      for (const literal of [
        null,
        100,
        {},
        [],
        "null",
        "nao sei mas talvez 100",
      ]) {
        expect(parseImportDeclarationLiteral(context, literal)).toEqual(
          invalid,
        );
      }
      for (const kind of ["UNKNOWN", "REMOVE"] as const) {
        expect(normalizeImportDeclaration(context, { kind })).toEqual({
          kind: "VALID",
          answer,
        });
      }
    }
  });

  it("literal bound is exactly 4000 units before trimming, with no metadata or authority output", () => {
    const input = " ".repeat(3999) + "1";
    expect(input.length).toBe(4000);
    const answer = {
      field: "amountCents",
      value: 100,
      meaningContext: "TOTAL_PURCHASE",
    };
    expect(normalizeImportDeclaration(money, value(input))).toEqual({
      kind: "VALID",
      answer,
    });
    expect(parseImportDeclarationLiteral(money, input)).toEqual({
      kind: "VALID",
      answer,
    });
    expect(encodeImportDeclaration(money, value(input))).toEqual({
      kind: "ENCODED",
      answer,
      literalAnswer: "1,00",
    });
    expect(normalizeImportDeclaration(money, value(" " + input))).toEqual(
      invalid,
    );
    expect(parseImportDeclarationLiteral(money, " " + input)).toEqual(invalid);
    expect(encodeImportDeclaration(money, value(" " + input))).toEqual(invalid);
  });

  it("invalid numeric context fails closed even for absence, without changing the input", () => {
    for (const effectiveInstallmentCount of [0, -1, 1.5, NaN, Infinity]) {
      const context = { ...money, effectiveInstallmentCount };
      expect(normalizeImportDeclaration(context, value("100,00"))).toEqual(
        invalid,
      );
      expect(parseImportDeclarationLiteral(context, "remover")).toEqual(
        invalid,
      );
      expect(encodeImportDeclaration(context, { kind: "UNKNOWN" })).toEqual(
        invalid,
      );
    }
  });
});

describe("independent pending-question predicate contract", () => {
  it("all nine legacy draft fields remain pending, without requiring B3 metadata", () => {
    const fields: ImportSessionDraftFieldV1[] = [
      "amountMeaning",
      "amountCents",
      "installmentCount",
      "dataCompra",
      "firstDueDate",
      "targets",
      "decision",
      "tipoDespesa",
      "categoriaMaoDeObra",
    ];
    for (const field of fields) {
      expect(
        isPendingImportQuestion({
          id: "draft-q",
          lineIds: ["line-a"],
          field,
          text: "Synthetic draft question",
        }),
      ).toBe(true);
    }
  });

  it("only UNANSWERED documentary questions are pending; DECLARED and UNKNOWN remain data, not new prompts", () => {
    const questions: ImportObservationQuestionV1[] = [
      {
        id: "date-q",
        field: "dataCompra",
        lineIds: ["line-a"],
        text: "Date",
        subject: {
          kind: "OBSERVATION",
          observationId: "o-a",
          meaningContext: null,
        },
        answerState: "UNANSWERED",
      },
      {
        id: "merchant-q",
        field: "merchant",
        lineIds: ["line-a"],
        text: "Merchant",
        subject: {
          kind: "OBSERVATION",
          observationId: "o-a",
          meaningContext: null,
        },
        answerState: "UNANSWERED",
      },
      {
        id: "meaning-q",
        field: "amountMeaning",
        lineIds: ["line-a"],
        text: "Meaning",
        subject: {
          kind: "OBSERVATION",
          observationId: "o-a",
          meaningContext: null,
        },
        answerState: "UNANSWERED",
      },
      {
        id: "amount-q",
        field: "amountCents",
        lineIds: ["line-a"],
        text: "Amount",
        subject: {
          kind: "OBSERVATION",
          observationId: "o-a",
          meaningContext: "TOTAL_PURCHASE",
        },
        answerState: "UNANSWERED",
      },
      {
        id: "count-q",
        field: "installmentCount",
        lineIds: ["line-a"],
        text: "Count",
        subject: {
          kind: "OBSERVATION",
          observationId: "o-a",
          meaningContext: null,
        },
        answerState: "UNANSWERED",
      },
      {
        id: "index-q",
        field: "installmentIndex",
        lineIds: ["line-a"],
        text: "Index",
        subject: {
          kind: "OBSERVATION",
          observationId: "o-a",
          meaningContext: null,
        },
        answerState: "UNANSWERED",
      },
    ];
    for (const question of questions) {
      expect(isPendingImportQuestion(question)).toBe(true);
      expect(
        isPendingImportQuestion({ ...question, answerState: "DECLARED" }),
      ).toBe(false);
      expect(
        isPendingImportQuestion({ ...question, answerState: "UNKNOWN" }),
      ).toBe(false);
    }
    const mixed = [
      { ...questions[0], answerState: "DECLARED" as const },
      { ...questions[1], answerState: "UNKNOWN" as const },
      questions[2],
    ];
    expect(mixed.filter(isPendingImportQuestion).map((q) => q.id)).toEqual([
      "meaning-q",
    ]);
    expect(mixed).toHaveLength(3);
  });
});
