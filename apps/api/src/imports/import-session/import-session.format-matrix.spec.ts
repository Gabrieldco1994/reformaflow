// The database guard must run before Prisma is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../../scripts/test-db-env.cjs");

import { createHash } from "node:crypto";
import type { ImportArtifact, ImportSessionArtifact } from "@prisma/client";
import {
  IMPORT_SESSION_LIMITS,
  ImportSessionErrorCode,
  type ImportSessionStoredDraftV1,
} from "@reformaflow/domain";
import { PrismaService } from "../../prisma/prisma.service";
import * as statementDocument from "../../credit-card/parsers/statement-document";
import {
  DocumentExtractionError,
  extractStrictCsvStatementDocument,
} from "../../credit-card/parsers/statement-document";
import { mintImportAuthContext } from "./import-session.auth";
import type { ImportSessionCapability } from "./import-session.capability";
import {
  buildImportMaterialization,
  type ImportMaterializationInput,
} from "./import-session.extraction";
import { projectImportSessionEntry } from "./import-session.intake-gate";
import {
  ImportUploadService,
  parseReserveRequest,
} from "./vault/import-upload.service";
import { MIME_FORMAT } from "./vault/vault-storage";
import type { ImportVaultGate } from "./vault/vault-state";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const TENANT_ID = "qa-format-matrix-tenant";
const SESSION_ID = "00000000-0000-4000-8000-000000000716";
const ATTACHMENT_ID = "00000000-0000-4000-8000-000000000717";
const capability: ImportSessionCapability = {
  writesEnabled: () => true,
  newImportFormats: () => ["CSV"],
};

function emptyDraft(): ImportSessionStoredDraftV1 {
  return {
    version: 1,
    lines: [],
    selectedLineIds: [],
    questions: [],
    scope: {
      observationIds: [],
      pendingAttachmentIds: [ATTACHMENT_ID],
    },
  };
}

function materializeCsv(bytes: Buffer) {
  const request = parseReserveRequest({
    expectedRevision: 1,
    files: [
      {
        id: ATTACHMENT_ID,
        fileName: "fatura.csv",
        declaredBytes: bytes.length,
        mime: "text/csv",
      },
    ],
  });
  expect(request.files[0]).toMatchObject({
    fileName: "fatura.csv",
    declaredBytes: bytes.length,
    mime: "text/csv",
  });
  expect(MIME_FORMAT[request.files[0]!.mime]).toEqual(["CSV"]);

  const extraction = extractStrictCsvStatementDocument(bytes);
  const artifact: ImportArtifact = {
    id: "artifact-format-matrix",
    tenantId: TENANT_ID,
    ownerProjectId: "project-format-matrix",
    documentSha256: createHash("sha256").update(bytes).digest("hex"),
    verifiedBytes: bytes.length,
    detectedFormat: "CSV",
    state: "EXTRACTED",
    storageKey: null,
    parserVersion: extraction.parserVersion,
    extractionJson: JSON.stringify(extraction),
    parseGeneration: 1,
    leaseSessionId: null,
    leaseSessionVersion: null,
    leaseTokenExpiresAt: null,
    leaseExpiresAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const attachment: ImportSessionArtifact = {
    id: ATTACHMENT_ID,
    tenantId: TENANT_ID,
    ownerProjectId: "project-format-matrix",
    sessionId: SESSION_ID,
    artifactId: artifact.id,
    position: 0,
    fileName: "fatura.csv",
    declaredMime: "text/csv",
    declaredBytes: bytes.length,
    state: "ATTACHED",
    temporaryStorageKey: null,
    reservedBytes: 0,
    uploadGeneration: 1,
    uploadSessionVersion: null,
    uploadTokenExpiresAt: null,
    uploadLeaseExpiresAt: null,
    verifiedAt: NOW,
    releasedAt: null,
    temporaryPurgePending: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const input: ImportMaterializationInput = {
    session: {
      id: SESSION_ID,
      tenantId: TENANT_ID,
      ownerProjectId: artifact.ownerProjectId,
      revision: 1,
    },
    attachment,
    artifact,
    extraction,
    draft: emptyDraft(),
    observations: [],
    newIds: new Map(
      extraction.occurrences.map((occurrence, index) => [
        occurrence.reference,
        {
          observationId: `observation-${index}`,
          lineId: `line-${index}`,
        },
      ]),
    ),
  };
  return {
    detectedFormat: artifact.detectedFormat,
    extraction,
    plan: buildImportMaterialization(input),
  };
}

function extractionCode(bytes: Buffer): string | null {
  try {
    extractStrictCsvStatementDocument(bytes);
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(DocumentExtractionError);
    return (error as DocumentExtractionError).code;
  }
}

function csvAtByteLimit(): Buffer {
  const extraColumns = Array.from({ length: 11 }, (_, index) => `x${index}`);
  const header = ["date", "title", "amount", ...extraColumns].join(",") + "\n";
  const emptyRows = Array.from(
    { length: IMPORT_SESSION_LIMITS.parsedRowsPerFile },
    () =>
      ["2026-10-05", "COMPRA", "1.00", ...extraColumns.map(() => "")].join(
        ",",
      ) + "\n",
  );
  const emptyBytes = Buffer.byteLength(header + emptyRows.join(""));
  const padding = IMPORT_SESSION_LIMITS.bytesPerFile - emptyBytes;
  const slots = emptyRows.length * extraColumns.length;
  const width = Math.floor(padding / slots);
  const remainder = padding % slots;
  expect(width + (remainder > 0 ? 1 : 0)).toBeLessThanOrEqual(
    IMPORT_SESSION_LIMITS.csvFieldBytes,
  );
  let slot = 0;
  const rows = emptyRows.map(() => {
    const fields = extraColumns.map(() => {
      const value = "x".repeat(width + (slot < remainder ? 1 : 0));
      slot += 1;
      return value;
    });
    return ["2026-10-05", "COMPRA", "1.00", ...fields].join(",") + "\n";
  });
  const bytes = Buffer.from(header + rows.join(""), "utf8");
  expect(bytes).toHaveLength(IMPORT_SESSION_LIMITS.bytesPerFile);
  return bytes;
}

function pdf(pages: readonly (readonly string[])[], imageOnly = false): Buffer {
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [index, lines] of pages.entries()) {
    const content = imageOnly
      ? "q 100 0 0 100 40 40 cm BI /W 1 /H 1 /CS /RGB /BPC 8 /F /AHx ID 000000> EI Q"
      : lines
          .map((line, lineIndex) => {
            const escaped = line.replace(/([\\()])/g, "\\$1");
            return `BT /F1 8 Tf 1 0 0 1 40 ${780 - lineIndex * 12} Tm (${escaped}) Tj ET`;
          })
          .join("\n");
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    );
  }
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

describe("qualified format matrix without the Darwin vault runtime", () => {
  const prisma = new PrismaService();

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    {
      name: "comma UTF-8",
      bytes: Buffer.from(
        "date,title,amount\n2026-10-05,CAFÉ CENTRAL,100.01\n",
        "utf8",
      ),
      merchant: "CAFÉ CENTRAL",
      amountCents: 10_001,
    },
    {
      name: "semicolon pt-BR decimal",
      bytes: Buffer.from(
        "data;descricao;valor\n05/10/2026;MERCADO;R$ 1.234,56\n",
        "utf8",
      ),
      merchant: "MERCADO",
      amountCents: 123_456,
    },
    {
      name: "quoted delimiter",
      bytes: Buffer.from(
        'date,title,amount\n2026-10-05,"MERCADO, BAIRRO",100.01\n',
        "utf8",
      ),
      merchant: "MERCADO, BAIRRO",
      amountCents: 10_001,
    },
    {
      name: "CRLF plus BOM",
      bytes: Buffer.from(
        "\uFEFFdate,title,amount\r\n2026-10-05,MERCADO,100.01\r\n",
        "utf8",
      ),
      merchant: "MERCADO",
      amountCents: 10_001,
    },
  ])(
    "$name bytes become one CSV observation and deterministic review questions",
    ({ bytes, merchant, amountCents }) => {
      const result = materializeCsv(bytes);

      expect(result.detectedFormat).toBe("CSV");
      expect(result.extraction.metrics).toEqual({
        pages: 0,
        rows: 1,
        expandedBytes: 0,
        archiveEntries: 0,
        imagePixels: 0,
        frames: 0,
      });
      expect(result.extraction.occurrences).toEqual([
        expect.objectContaining({
          reference: "csv:record:2",
          sourceOrdinal: 0,
          dateOnly: "2026-10-05",
          merchant,
          amountCents,
          identityOrdinal: 0,
        }),
      ]);
      expect(result.plan.draft.lines).toEqual([
        expect.objectContaining({
          id: "line-0",
          titulo: merchant,
          fornecedor: merchant,
          dataCompra: "2026-10-05",
          amountMeaning: "UNKNOWN",
          amountCents: null,
          decision: { kind: "UNRESOLVED" },
        }),
      ]);
      expect(result.plan.draft.selectedLineIds).toEqual(["line-0"]);
      expect(
        result.plan.draft.questions.map((question) => question.field),
      ).toEqual([
        "amountMeaning",
        "amountCents",
        "installmentCount",
        "firstDueDate",
      ]);
      expect(
        result.plan.draft.questions.every(
          (question) =>
            question.lineIds.length === 1 && question.lineIds[0] === "line-0",
        ),
      ).toBe(true);
    },
  );

  it("preserves duplicate records and ignores a negative invoice payment without questions", () => {
    const result = materializeCsv(
      Buffer.from(
        [
          "date,title,amount",
          "2026-10-05,MERCADO,100.01",
          "2026-10-05,MERCADO,100.01",
          "2026-10-06,PAGAMENTO EFETUADO,-250.00",
          "",
        ].join("\n"),
        "utf8",
      ),
    );

    expect(result.detectedFormat).toBe("CSV");
    expect(
      result.extraction.occurrences.map((occurrence) => ({
        reference: occurrence.reference,
        amountCents: occurrence.amountCents,
        identityOrdinal: occurrence.identityOrdinal,
      })),
    ).toEqual([
      {
        reference: "csv:record:2",
        amountCents: 10_001,
        identityOrdinal: 0,
      },
      {
        reference: "csv:record:3",
        amountCents: 10_001,
        identityOrdinal: 1,
      },
      {
        reference: "csv:record:4",
        amountCents: -25_000,
        identityOrdinal: 0,
      },
    ]);
    expect(
      result.plan.draft.lines.map((line) => ({
        id: line.id,
        decision: line.decision,
        targets: line.targets,
      })),
    ).toEqual([
      { id: "line-0", decision: { kind: "UNRESOLVED" }, targets: null },
      { id: "line-1", decision: { kind: "UNRESOLVED" }, targets: null },
      {
        id: "line-2",
        decision: {
          kind: "IGNORED_POLICY",
          reason: "INVOICE_PAYMENT",
          policyVersion: 1,
        },
        targets: [],
      },
    ]);
    expect(result.plan.draft.selectedLineIds).toEqual(["line-0", "line-1"]);
    expect(
      result.plan.draft.questions.map((question) => question.lineIds),
    ).toEqual([
      ["line-0"],
      ["line-0"],
      ["line-0"],
      ["line-0"],
      ["line-1"],
      ["line-1"],
      ["line-1"],
      ["line-1"],
    ]);
  });

  it.each([
    {
      name: "quoted embedded newline",
      bytes: Buffer.from(
        'date,title,amount\n2026-10-05,"MERCADO\nBAIRRO",100.01\n',
        "utf8",
      ),
      code: "UNSUPPORTED_DOCUMENT",
    },
    {
      name: "missing required amount column",
      bytes: Buffer.from(
        "date,title,other\n2026-10-05,MERCADO,100.01\n",
        "utf8",
      ),
      code: "UNSUPPORTED_DOCUMENT",
    },
  ])("$name fails closed with $code", ({ bytes, code }) => {
    expect(
      parseReserveRequest({
        expectedRevision: 1,
        files: [
          {
            id: ATTACHMENT_ID,
            fileName: "fatura.csv",
            declaredBytes: bytes.length,
            mime: "text/csv",
          },
        ],
      }).files[0],
    ).toMatchObject({ mime: "text/csv", declaredBytes: bytes.length });
    expect(extractionCode(bytes)).toBe(code);
  });

  it("accepts exactly 10 MiB and rejects the same qualified CSV at 10 MiB plus one byte", () => {
    const boundary = csvAtByteLimit();
    const accepted = parseReserveRequest({
      expectedRevision: 1,
      files: [
        {
          id: ATTACHMENT_ID,
          fileName: "boundary.csv",
          declaredBytes: boundary.length,
          mime: "text/csv",
        },
      ],
    });
    expect(accepted.files[0]!.declaredBytes).toBe(10_485_760);
    expect(extractStrictCsvStatementDocument(boundary)).toMatchObject({
      parserVersion: "card-local-text-v1",
      metrics: { rows: 1_000 },
    });

    const over = Buffer.concat([boundary, Buffer.from("x")]);
    expect(over).toHaveLength(10_485_761);
    expect(() =>
      parseReserveRequest({
        expectedRevision: 1,
        files: [
          {
            id: ATTACHMENT_ID,
            fileName: "over.csv",
            declaredBytes: over.length,
            mime: "text/csv",
          },
        ],
      }),
    ).toThrow(
      expect.objectContaining({ code: ImportSessionErrorCode.LIMIT_EXCEEDED }),
    );
    expect(extractionCode(over)).toBe("LIMIT_EXCEEDED");
  });

  it.each([
    {
      name: "single-page text PDF",
      bytes: pdf([
        [
          "Fatura de cartao",
          "Data Descricao Valor",
          "05/10/2026 MERCADO 100,01",
        ],
      ]),
    },
    {
      name: "multi-page text PDF",
      bytes: pdf([
        ["Fatura de cartao", "05/10/2026 MERCADO 100,01"],
        ["06/10/2026 FARMACIA 50,00"],
      ]),
    },
    {
      name: "scan-like image-only PDF",
      bytes: pdf([[]], true),
    },
  ])(
    "$name is explicitly unsupported by the CSV-only rollout",
    async ({ bytes }) => {
      const stopped = new AbortController();
      const runtime = Object.freeze({ name: "non-darwin-test-runtime" });
      const gate = {
        boot: {
          state: () => "ON",
          runtime: () => runtime,
          stopped: stopped.signal,
          recheckLock: jest.fn(),
        },
        storage: { writeClaim: jest.fn() },
      } as unknown as ImportVaultGate;
      expect(projectImportSessionEntry(capability, gate)).toEqual({
        kind: "CARD_INVOICE",
        version: 1,
        formats: ["CSV"],
      });
      const database = { $transaction: jest.fn() };
      const verifier = { verify: jest.fn() };
      const service = new ImportUploadService(
        database as unknown as PrismaService,
        { now: () => NOW },
        capability,
        verifier,
        gate,
      );
      const binaryExtraction = jest.spyOn(
        statementDocument,
        "extractCardStatementBinaryDocument",
      );
      const csvExtraction = jest.spyOn(
        statementDocument,
        "extractStrictCsvStatementDocument",
      );
      const auth = mintImportAuthContext({
        tenantId: TENANT_ID,
        userId: "qa-format-matrix-user",
        presentedSessionVersion: 1,
        tokenExpiresAt: "2026-10-11T12:00:00.000Z",
      });

      await expect(
        service.reserve(
          auth,
          SESSION_ID,
          {
            expectedRevision: 1,
            files: [
              {
                id: ATTACHMENT_ID,
                fileName: "fatura.pdf",
                declaredBytes: bytes.length,
                mime: "application/pdf",
              },
            ],
          },
          "unused-grant",
        ),
      ).rejects.toEqual(
        expect.objectContaining({
          code: ImportSessionErrorCode.UNSUPPORTED_DOCUMENT,
        }),
      );
      expect(binaryExtraction).not.toHaveBeenCalled();
      expect(csvExtraction).not.toHaveBeenCalled();
      expect(database.$transaction).not.toHaveBeenCalled();
      expect(verifier.verify).not.toHaveBeenCalled();
      expect(gate.boot.recheckLock).not.toHaveBeenCalled();
      expect(gate.storage.writeClaim).not.toHaveBeenCalled();
      expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    },
  );

  it("creates zero financial rows while extracting, normalizing, rejecting, or classifying", async () => {
    const where = { tenantId: TENANT_ID };
    await expect(
      Promise.all([
        prisma.expense.count({ where }),
        prisma.cashFlowEntry.count({ where }),
        prisma.rateioAllocation.count({ where }),
        prisma.crossProjectSettlement.count({ where }),
        prisma.invoiceFundingAllocation.count({ where }),
        prisma.merchantCategory.count({ where }),
        prisma.receipt.count({ where }),
      ]),
    ).resolves.toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});
