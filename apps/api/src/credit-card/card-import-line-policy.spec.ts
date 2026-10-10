import { readFileSync } from "node:fs";
import { join } from "node:path";

type PolicyModule = {
  CARD_IMPORT_LINE_POLICY_VERSION: 1;
  classifyCardImportLine(input: {
    documentaryText: string;
    canonicalType?: string | null;
    settlesInvoiceKey?: string | null;
  }): "PURCHASE" | "IGNORE_INVOICE_PAYMENT" | "IGNORE_CARD_PAYS_CARD";
};

function policy(): PolicyModule {
  // This is intentionally loaded at assertion time: RED reports the missing
  // shared policy instead of preventing Jest from collecting the named cases.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("./card-import-line-policy") as PolicyModule;
}

describe("canonical card-import line policy", () => {
  it.each([
    ["PAGAMENTO EFETUADO", "IGNORE_INVOICE_PAYMENT"],
    ["PAGAMENTO PIX", "IGNORE_INVOICE_PAYMENT"],
    ["PGTO FAT", "IGNORE_INVOICE_PAYMENT"],
    ["FATURA PAG", "IGNORE_INVOICE_PAYMENT"],
    ["MERCADO DO BAIRRO", "PURCHASE"],
  ])(
    "classifies_the_existing_payment_literals_once_for_direct_and_Maria_paths: %s",
    (documentaryText, expected) => {
      expect(
        policy().classifyCardImportLine({
          documentaryText,
          canonicalType: null,
          settlesInvoiceKey: null,
        }),
      ).toBe(expected);
    },
  );

  it("does_not_infer_card_pays_card_without_structured_settlement_evidence", () => {
    expect(
      policy().classifyCardImportLine({
        documentaryText: "PAGAMENTO CARTAO 1234 FATURA OUTUBRO",
      }),
    ).toBe("IGNORE_INVOICE_PAYMENT");
  });

  it("marks_structured_card_pays_card_as_terminal_no_write", () => {
    expect(
      policy().classifyCardImportLine({
        documentaryText: "PAGAMENTO CARTAO",
        canonicalType: "CARD_PAYS_CARD",
        settlesInvoiceKey: "card-123:2026-10",
      }),
    ).toBe("IGNORE_CARD_PAYS_CARD");
    expect(policy().CARD_IMPORT_LINE_POLICY_VERSION).toBe(1);
  });

  it("both_consumers_call_the_shared_policy", () => {
    const direct = readFileSync(
      join(__dirname, "credit-card.service.ts"),
      "utf8",
    );
    const maria = readFileSync(
      join(
        __dirname,
        "../imports/import-session/import-session.extraction.ts",
      ),
      "utf8",
    );

    for (const source of [direct, maria]) {
      expect(source).toMatch(
        /from\s+["'][^"']*card-import-line-policy["']/,
      );
      expect(source).toContain("classifyCardImportLine(");
    }
    expect(direct).not.toMatch(/PAGAMENTO\s*\|.*PGTO\s*FAT/s);
    expect(maria).not.toMatch(/PAGAMENTO\s*\|.*PGTO\s*FAT/s);
  });
});
