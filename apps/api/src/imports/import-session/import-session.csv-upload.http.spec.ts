// The database guard must run before Prisma is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../../scripts/test-db-env.cjs");

import { createHash, randomUUID } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import {
  cleanupImportWorld,
  seedImportWorld,
  seedSession,
  type ImportWorld,
} from "../../test-utils/import-session-harness";
import {
  bootVaultApp,
  CANONICAL_VAULT,
  connectVaultTestDatabase,
  fileSeed,
  putContent,
  reserve,
  UI_HEADERS,
  vaultTestDatabaseIsSafe,
  type RecoveryApp,
} from "../../test-utils/import-session-vault-harness";
import {
  DefaultImportSessionCapability,
  IMPORT_SESSION_CAPABILITY,
  type ImportSessionCapability,
} from "./import-session.capability";
import { ImportRawExecutions } from "./import-session.raw-executions";

const PREFIX = "maria-csv-upload";
const CSV = Buffer.from(
  [
    "date,title,amount",
    "2026-10-05,MERCADO,100.01",
    "2026-10-05,MERCADO,100.01",
    "2026-10-06,PAGAMENTO EFETUADO,250.00",
    "data-incerta,LINHA INCERTA,valor-incerto",
    "",
  ].join("\n"),
  "utf8",
);
const csvCapability: ImportSessionCapability = {
  writesEnabled: () => true,
  newImportFormats: () => ["CSV"],
};

describe("Maria CSV real upload HTTP release", () => {
  const prisma = new PrismaService();
  let world: ImportWorld;
  let api: RecoveryApp;
  let token: string;

  beforeAll(async () => {
    await connectVaultTestDatabase(prisma);
    world = await seedImportWorld(prisma, PREFIX);
  });

  beforeEach(async () => {
    api = await bootVaultApp(prisma, {
      writes: true,
      vault: CANONICAL_VAULT,
      framing: true,
      overrides: [{ token: IMPORT_SESSION_CAPABILITY, value: csvCapability }],
    });
    token = await api.tokenFor(world.users.restricted);
  });

  afterEach(async () => {
    await api?.close();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    if (vaultTestDatabaseIsSafe(prisma))
      await cleanupImportWorld(prisma, PREFIX);
    await prisma.$disconnect();
  });

  async function financialCounts() {
    const where = { tenantId: world.tenantId };
    return {
      expenses: await prisma.expense.count({ where }),
      cashFlowEntries: await prisma.cashFlowEntry.count({ where }),
      allocations: await prisma.rateioAllocation.count({ where }),
      settlements: await prisma.crossProjectSettlement.count({ where }),
      funding: await prisma.invoiceFundingAllocation.count({ where }),
      merchantCategories: await prisma.merchantCategory.count({ where }),
      receipts: await prisma.receipt.count({ where }),
    };
  }

  async function upload(bytes: Buffer, name = "fatura.csv") {
    const session = await seedSession(prisma, world, {
      ownerUserId: world.users.restricted.id,
    });
    const file = fileSeed({
      fileName: name,
      mime: "text/csv",
      declaredBytes: bytes.length,
    });
    const reserved = await reserve(api, token, session.id, [file]);
    expect(reserved.status).toBe(200);
    const stored = await putContent(api, session.id, file.id, {
      token,
      body: bytes,
    });
    return { session, file, reserved, stored };
  }

  it("stored_CSV_bytes_reach_extraction_and_every_record_reaches_the_draft", async () => {
    const before = await financialCounts();
    const native = jest.spyOn(api.app.get(ImportRawExecutions), "start");
    const uploaded = await upload(CSV);
    expect(uploaded.stored.status).toBe(200);

    const ref = await prisma.importSessionArtifact.findUniqueOrThrow({
      where: { id: uploaded.file.id },
    });
    const artifact = await prisma.importArtifact.findUniqueOrThrow({
      where: { id: ref.artifactId! },
    });
    expect(artifact.documentSha256).toBe(
      createHash("sha256").update(CSV).digest("hex"),
    );

    const analyzed = await api.call(
      "POST",
      `/import-sessions/${uploaded.session.id}/attachments/${uploaded.file.id}/analyze`,
      {
        token,
        headers: UI_HEADERS,
        body: { expectedRevision: uploaded.stored.json.revision },
      },
    );
    expect(analyzed.status).toBe(200);
    expect(native).not.toHaveBeenCalled();

    const extracted = await prisma.importArtifact.findUniqueOrThrow({
      where: { id: artifact.id },
    });
    expect(extracted).toMatchObject({
      state: "EXTRACTED",
      parserVersion: "card-local-text-v1",
      documentSha256: createHash("sha256").update(CSV).digest("hex"),
    });
    expect(analyzed.json.lines).toHaveLength(4);
    expect(analyzed.json.lines[0].observationIds[0]).not.toBe(
      analyzed.json.lines[1].observationIds[0],
    );
    expect(analyzed.json.selectedLineIds).toEqual([
      analyzed.json.lines[0].id,
      analyzed.json.lines[1].id,
      analyzed.json.lines[3].id,
    ]);
    expect(analyzed.json.lines[2]).toMatchObject({
      decision: {
        kind: "IGNORED_POLICY",
        reason: "INVOICE_PAYMENT",
        policyVersion: 1,
      },
      targets: [],
    });
    expect(analyzed.json.selectedLineIds).not.toContain(
      analyzed.json.lines[2].id,
    );
    expect(analyzed.json.questions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lineIds: expect.arrayContaining([analyzed.json.lines[3].id]),
        }),
      ]),
    );
    const observations = await prisma.importObservation.findMany({
      where: { artifactId: artifact.id },
      orderBy: { reference: "asc" },
    });
    expect(observations).toHaveLength(4);
    expect(
      observations.every(
        (observation) =>
          observation.claimVersion === 0 &&
          observation.canonicalProjectId === null &&
          observation.canonicalExpenseId === null &&
          observation.canonicalReceiptId === null &&
          observation.claimSessionId === null &&
          observation.claimReceiptJson === null &&
          observation.claimedAt === null,
      ),
    ).toBe(true);

    const sessionBeforeInvalidEdit =
      await prisma.importSession.findUniqueOrThrow({
        where: { id: uploaded.session.id },
      });
    const rejected = await api.call(
      "PATCH",
      `/import-sessions/${uploaded.session.id}/draft`,
      {
        token,
        headers: UI_HEADERS,
        body: {
          expectedRevision: analyzed.json.revision,
          questionId: null,
          replaceLines: [],
          selectedLineIds: [
            ...analyzed.json.selectedLineIds,
            analyzed.json.lines[2].id,
          ],
        },
      },
    );
    expect([rejected.status, rejected.json.code]).toEqual([
      400,
      "INVALID_INPUT",
    ]);
    expect(
      await prisma.importSession.findUniqueOrThrow({
        where: { id: uploaded.session.id },
      }),
    ).toEqual(sessionBeforeInvalidEdit);
    expect(
      await prisma.importObservation.findMany({
        where: { artifactId: artifact.id },
        orderBy: { reference: "asc" },
      }),
    ).toEqual(observations);
    expect(await financialCounts()).toEqual(before);
  });

  it("rejects_non_CSV_reserve_and_invalid_content_without_activating_an_artifact", async () => {
    const before = await financialCounts();
    const unsupported = [
      ["fatura.pdf", "application/pdf"],
      [
        "fatura.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ],
      ["foto.png", "image/png"],
    ] as const;
    for (const [fileName, mime] of unsupported) {
      const session = await seedSession(prisma, world, {
        ownerUserId: world.users.restricted.id,
      });
      const response = await reserve(api, token, session.id, [
        fileSeed({ fileName, mime, declaredBytes: 16 }),
      ]);
      expect(response.status).toBeGreaterThanOrEqual(400);
    }

    for (const [label, bytes] of [
      ["html", Buffer.from("<html><script>alert(1)</script></html>")],
      ["nul", Buffer.from("date,title,amount\n2026-10-05,A,\0\n")],
      [
        "ambiguous",
        Buffer.from(
          "date,title,amount;data;descricao;valor\n2026-10-05,A,1.00;05/10/2026;B;1,00\n",
        ),
      ],
    ] as const) {
      const observationsBefore = await prisma.importObservation.count({
        where: { tenantId: world.tenantId },
      });
      const result = await upload(bytes, `${label}.csv`);
      expect(result.stored.status).toBeGreaterThanOrEqual(400);
      expect(
        await prisma.importArtifact.count({
          where: {
            tenantId: world.tenantId,
            documentSha256: createHash("sha256").update(bytes).digest("hex"),
            state: { in: ["RAW_READY", "ANALYZING", "EXTRACTED"] },
          },
        }),
      ).toBe(0);
      expect(
        await prisma.importObservation.count({
          where: { tenantId: world.tenantId },
        }),
      ).toBe(observationsBefore);
    }
    expect(await financialCounts()).toEqual(before);
  });

  it("advertises_only_CSV_when_the_test_capability_is_enabled", async () => {
    const page = await api.call("GET", "/import-sessions", { token });
    expect(page.status).toBe(200);
    expect(page.json.entry).toEqual({
      kind: "CARD_INVOICE",
      version: 1,
      formats: ["CSV"],
    });
  });

  it("remains_UNAVAILABLE_under_the_default_provider_even_when_an_environment_flag_is_set", async () => {
    const previous = process.env.IMPORT_SESSION_WRITES_ENABLED;
    process.env.IMPORT_SESSION_WRITES_ENABLED = "true";
    const off = await bootVaultApp(prisma, {
      vault: "real",
      overrides: [
        {
          token: IMPORT_SESSION_CAPABILITY,
          value: new DefaultImportSessionCapability(),
        },
      ],
    });
    try {
      const offToken = await off.tokenFor(world.users.restricted);
      const page = await off.call("GET", "/import-sessions", {
        token: offToken,
      });
      expect(page.status).toBe(200);
      expect(page.json.entry).toEqual({
        kind: "UNAVAILABLE",
        version: 1,
        reason: "NOT_ENABLED",
      });
    } finally {
      await off.close();
      if (previous === undefined)
        delete process.env.IMPORT_SESSION_WRITES_ENABLED;
      else process.env.IMPORT_SESSION_WRITES_ENABLED = previous;
    }
  });
});
