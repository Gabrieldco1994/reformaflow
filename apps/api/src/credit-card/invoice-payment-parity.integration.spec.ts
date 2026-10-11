import { createHash, randomUUID } from "node:crypto";
import {
  IMPORT_SESSION_CONSENT_POLICY_VERSION,
  ProjectType,
} from "@reformaflow/domain";
import { PrismaService } from "../prisma/prisma.service";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import { CreditCardService } from "./credit-card.service";
import {
  invoicePaymentIgnoredReason,
  INVOICE_PAYMENT_LINE_PATTERN,
} from "./invoice-payment-classification";
import { parseStatementBuffers } from "./parsers";
import { extractCardStatementDocument } from "./parsers/statement-document";
import { ImportSessionService } from "../imports/import-session/import-session.service";
import { DefaultImportSessionCapability } from "../imports/import-session/import-session.capability";
import { mintImportAuthContext } from "../imports/import-session/import-session.auth";
import { buildImportMaterialization } from "../imports/import-session/import-session.extraction";
import { EMPTY_DRAFT_JSON } from "../imports/import-session/import-session.projection";
import {
  ignoredImportObservation,
  parseStoredImportObservationEvidence,
} from "../imports/import-session/import-session.observation";

const PAYMENT_CASES = [
  "PAGAMENTO EFETUADO",
  "Pagamento PIX",
  "PAGAMENTO DE FATURA",
  "PGTO FAT",
  "FATURA PAGA",
] as const;
const PLURAL_NEAR_MISS = "PAGAMENTOS DE FATURA";

describe("invoice-payment classifier boundaries", () => {
  it.each(PAYMENT_CASES)(
    "classifies the canonical payment %s",
    (description) => {
      expect(invoicePaymentIgnoredReason(description)).toBe("INVOICE_PAYMENT");
      expect(INVOICE_PAYMENT_LINE_PATTERN.test(description)).toBe(true);
    },
  );

  it.each([
    null,
    "",
    PLURAL_NEAR_MISS,
    "PAGAMENTO DE FATURAS",
    "REPAGAMENTO EFETUADO",
    "PGTO FATO",
    "MERCADO FATURA PAGODE",
  ])("does not classify the lexical near miss %s", (description) => {
    expect(invoicePaymentIgnoredReason(description)).toBeNull();
  });
});

describe("legacy card route and Maria route payment parity", () => {
  const prisma = new PrismaService();
  const now = new Date("2026-10-11T12:00:00.000Z");
  const clock = { now: () => now };
  const capability = new DefaultImportSessionCapability();
  const verifier = {
    verify: jest.fn().mockReturnValue({}),
    verifyFinancialAction: jest.fn(),
  };
  const runtime = {};
  const gate = {
    boot: {
      runtime: () => runtime,
      stopped: { aborted: false },
      recheckLock: async () => ({ ok: true, runtime }),
    },
  };
  const raw = { abortOwned: jest.fn() };
  let tenantId: string;
  let userId: string;
  let projectId: string;
  let cardId: string;

  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toMatch(/test(?:-worker-\d+)?\.db/);
    expect(process.env.DATABASE_URL).not.toContain("dev.db");
    await prisma.$connect();
  });

  beforeEach(async () => {
    const tenant = await prisma.tenant.create({
      data: { name: "payment parity fixture" },
    });
    tenantId = tenant.id;
    userId = (
      await prisma.user.create({
        data: {
          tenantId,
          username: randomUUID(),
          name: "payment parity fixture",
          role: "ADMIN",
        },
      })
    ).id;
    projectId = (
      await prisma.project.create({
        data: {
          tenantId,
          name: "payment parity fixture",
          type: ProjectType.PESSOAL,
        },
      })
    ).id;
    cardId = (
      await prisma.creditCard.create({
        data: {
          tenantId,
          projectId,
          nickname: "payment parity",
          institution: "fixture",
          last4: "0777",
          closingDay: 5,
          dueDay: 10,
        },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("normalizes the same six rows and creates finance only for the 777-cent plural near miss", async () => {
    const rows = [
      ["2026-10-01", PAYMENT_CASES[0], "-1.01"],
      ["2026-10-02", PAYMENT_CASES[1], "-2.02"],
      ["2026-10-03", PAYMENT_CASES[2], "-3.03"],
      ["2026-10-04", PAYMENT_CASES[3], "-4.04"],
      ["2026-10-05", PAYMENT_CASES[4], "-5.05"],
      ["2026-10-06", PLURAL_NEAR_MISS, "-7.77"],
    ] as const;
    const bytes = Buffer.from(
      ["date,title,amount", ...rows.map((row) => row.join(","))].join("\n"),
    );
    const legacyParsed = await parseStatementBuffers(
      [bytes],
      cardId,
      "CSV_NUBANK",
      "payment-parity.csv",
    );
    const mariaParsed = extractCardStatementDocument({
      version: 1,
      context: "CARD_INVOICE",
      format: "CSV",
      profile: "CSV_NUBANK",
      bytes,
    });
    const legacySnapshot = legacyParsed.transactions.map((row) => ({
      dateOnly: row.date.toISOString().slice(0, 10),
      merchant: row.merchant,
      amountCents: row.amountCents,
      installmentCount: row.installmentTotal ?? null,
      installmentIndex: row.installmentCurrent ?? null,
    }));
    const mariaSnapshot = mariaParsed.occurrences.map((row) => ({
      dateOnly: row.dateOnly,
      merchant: row.merchant,
      amountCents: row.amountCents,
      installmentCount: row.installmentCount,
      installmentIndex: row.installmentIndex,
    }));
    expect(mariaSnapshot).toEqual(legacySnapshot);
    expect(mariaSnapshot.map(({ amountCents }) => amountCents)).toEqual([
      -101, -202, -303, -404, -505, -777,
    ]);

    const sessions = new ImportSessionService(
      prisma,
      clock,
      capability,
      verifier as never,
      gate as never,
      raw as never,
    );
    const auth = mintImportAuthContext({
      tenantId,
      userId,
      presentedSessionVersion: 0,
      tokenExpiresAt: "2026-10-12T12:00:00.000Z",
    });
    const created = await sessions.create(
      auth,
      {
        version: 1,
        createRequestId: randomUUID(),
        cardId,
        consentPolicyVersion: IMPORT_SESSION_CONSENT_POLICY_VERSION,
        consentAnalyze: true,
      },
      {},
    );
    const session = await prisma.importSession.findUniqueOrThrow({
      where: { id: created.view.id },
    });
    const artifact = await prisma.importArtifact.create({
      data: {
        tenantId,
        ownerProjectId: projectId,
        documentSha256: createHash("sha256").update(bytes).digest("hex"),
        verifiedBytes: bytes.length,
        detectedFormat: "CSV",
        state: "EXTRACTED",
        parserVersion: mariaParsed.parserVersion,
        extractionJson: JSON.stringify(mariaParsed),
      },
    });
    const attachment = await prisma.importSessionArtifact.create({
      data: {
        tenantId,
        ownerProjectId: projectId,
        sessionId: session.id,
        artifactId: artifact.id,
        position: 0,
        fileName: "payment-parity.csv",
        declaredMime: "text/csv",
        declaredBytes: bytes.length,
        reservedBytes: 0,
        state: "ATTACHED",
        verifiedAt: now,
      },
    });
    const material = buildImportMaterialization({
      session,
      attachment,
      artifact,
      extraction: mariaParsed,
      observations: [],
      draft: {
        ...JSON.parse(EMPTY_DRAFT_JSON),
        scope: { observationIds: [], pendingAttachmentIds: [attachment.id] },
      },
      newIds: new Map(
        mariaParsed.occurrences.map((occurrence) => [
          occurrence.reference,
          { observationId: randomUUID(), lineId: randomUUID() },
        ]),
      ),
    });
    for (const observation of material.observations)
      await prisma.importObservation.create({ data: observation });
    await prisma.importSession.update({
      where: { id: session.id },
      data: { draftJson: JSON.stringify(material.draft) },
    });

    const persisted = await prisma.importObservation.findMany({
      where: { artifactId: artifact.id },
      orderBy: { reference: "asc" },
    });
    const persistedByDescription = new Map(
      persisted.map((item) => {
        const evidence = parseStoredImportObservationEvidence(
          item.evidenceJson,
        );
        return [evidence.sourceDescription, { item, evidence }] as const;
      }),
    );
    expect(
      rows.map(([, text, amount], index) => ({
        text,
        amountCents: Math.round(Number(amount) * 100),
        ignoredReason: ignoredImportObservation(
          persistedByDescription.get(text)!.evidence,
        ),
      })),
    ).toEqual(
      rows.map(([, text, amount], index) => ({
        text,
        amountCents: Math.round(Number(amount) * 100),
        ignoredReason: index < PAYMENT_CASES.length ? "INVOICE_PAYMENT" : null,
      })),
    );
    expect(
      (await sessions.getObservations(auth, session.id)).items,
    ).toHaveLength(6);
    expect(material.draft.lines).toHaveLength(1);
    expect(material.draft.lines[0]?.titulo).toBe(PLURAL_NEAR_MISS);

    const cards = new CreditCardService(
      prisma,
      new ConciliacaoService(prisma),
      new MerchantClassifierService(prisma),
    );
    const result = await cards.commitImport(
      tenantId,
      projectId,
      cardId,
      bytes,
      "payment-parity.csv",
      "CSV_NUBANK",
      "2026-10",
      undefined,
      undefined,
      userId,
      {
        id: userId,
        role: "OWNER",
        allowedProjects: [projectId],
        allowedProjectTypes: [ProjectType.PESSOAL],
        allowedModules: ["expenses", "creditCards"],
      },
    );
    expect(result).toMatchObject({
      total: 6,
      inserted: 1,
      skipped: 5,
      duplicated: 0,
      settled: 0,
      linked: 0,
    });
    const expenses = await prisma.expense.findMany({
      where: { tenantId, projectId, deletedAt: null },
      select: { fornecedor: true, valorTotal: true },
    });
    expect(expenses).toEqual([
      { fornecedor: PLURAL_NEAR_MISS, valorTotal: -777 },
    ]);
    expect(
      await prisma.cashFlowEntry.findMany({
        where: { tenantId, projectId, deletedAt: null },
        select: { valor: true, tipo: true },
      }),
    ).toEqual([{ valor: -777, tipo: "DESPESA" }]);
    expect(
      await prisma.expense.count({
        where: { tenantId, fornecedor: { in: [...PAYMENT_CASES] } },
      }),
    ).toBe(0);
  });
});
