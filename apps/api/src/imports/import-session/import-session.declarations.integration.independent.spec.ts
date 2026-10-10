const dbGuard: {
  REPO_ROOT: string;
  ACTIVE_DB_PATH: string;
} = require("../../../../../scripts/test-db-env.cjs");

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ImportSessionStoredDraftV1,
  ImportStoredDeclarationV1,
} from "@reformaflow/domain";
import { PrismaService } from "../../prisma/prisma.service";
import {
  seedImportWorld,
  seedSession,
  type ImportWorld,
} from "../../test-utils/import-session-harness";
import { validationDraft } from "../../test-utils/import-session-validation-fixtures";
import {
  bootRecoveryApp,
  type RecoveryApp,
} from "../../test-utils/import-session-recovery-harness";
import { extractCardStatementDocument } from "../../credit-card/parsers/statement-document";
import { buildImportMaterialization } from "./import-session.extraction";
import { parseStoredDraft } from "./import-session.projection";
import { validateStoredDraft } from "./import-session.validation";
import { ImportSessionCorruptStateError } from "./import-session.errors";
import { IMPORT_SESSION_WRITES_ENABLED } from "./import-session.disabled";

const NOW = new Date("2026-10-08T12:35:00.000Z");
const evidenceRoot =
  process.env.B3_QA_EVIDENCE ??
  resolve(dbGuard.REPO_ROOT, ".agents/b3-contract-evidence");
mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
const evidenceDir = mkdtempSync(resolve(evidenceRoot, "integration-"));

function proveDb(label: string) {
  expect(process.env.DATABASE_URL).toBe(`file:${dbGuard.ACTIVE_DB_PATH}`);
  const raw = execFileSync(
    "lsof",
    ["-nP", "-a", "-p", String(process.pid), "-Fn"],
    {
      encoding: "utf8",
    },
  );
  writeFileSync(resolve(evidenceDir, `${label}.lsof`), raw, {
    mode: 0o600,
    flag: "wx",
  });
  const databases = raw
    .split("\n")
    .filter((line) => /^n.*\.(db|sqlite3?)(-(wal|shm|journal))?$/.test(line))
    .map((line) => line.slice(1));
  expect(databases).toContain(dbGuard.ACTIVE_DB_PATH);
  expect(
    databases.filter(
      (file) =>
        ![
          dbGuard.ACTIVE_DB_PATH,
          `${dbGuard.ACTIVE_DB_PATH}-wal`,
          `${dbGuard.ACTIVE_DB_PATH}-shm`,
          `${dbGuard.ACTIVE_DB_PATH}-journal`,
        ].includes(file),
    ),
  ).toEqual([]);
}

// Structural validator inputs only. The HTTP spec creates every live declaration by ANSWER.
function declaration() {
  return {
    lineId: "line-create",
    observationId: "observation-create",
    field: "dataCompra",
    value: "2026-09-28",
    meaningContext: null,
    originalFingerprint: "a".repeat(64),
    claimVersion: 0,
    originSessionId: "origin-session",
    recordedRevision: 2,
    questionId: `oq_${"b".repeat(64)}`,
    turnId: "11111111-1111-4111-8111-111111111111",
    attestedByUserId: "synthetic-user",
    attestedAt: "2026-10-08T12:30:00.000Z",
    literalHash: "c".repeat(64),
  } satisfies ImportStoredDeclarationV1;
}
function extendedDraft() {
  const declarations: NonNullable<ImportSessionStoredDraftV1["declarations"]> =
    { version: 1, items: [declaration()] };
  return {
    ...validationDraft("project"),
    declarations,
  };
}

describe("B3 independent persisted JSON contract (not attestation authority)", () => {
  it("legacy_draft_round_trips_without_inferred_declarations", () => {
    const old = validationDraft("project");
    const encoded = JSON.stringify(old);
    const parsed = parseStoredDraft(encoded);
    expect(parsed).toEqual(old);
    expect(JSON.stringify(parsed)).toBe(encoded);
    expect(Object.prototype.hasOwnProperty.call(parsed, "declarations")).toBe(
      false,
    );
    expect(IMPORT_SESSION_WRITES_ENABLED).toBe(false);
  });

  it("valid extension round-trips all private server metadata instead of discarding it", () => {
    const draft = extendedDraft();
    const before = structuredClone(draft);
    expect(validateStoredDraft(draft)).toEqual(before);
    expect(parseStoredDraft(JSON.stringify(draft))).toEqual(before);
    expect(draft).toEqual(before);
    expect(Object.keys(draft.declarations.items[0]).sort()).toEqual(
      [
        "lineId",
        "observationId",
        "field",
        "value",
        "meaningContext",
        "originalFingerprint",
        "claimVersion",
        "originSessionId",
        "recordedRevision",
        "questionId",
        "turnId",
        "attestedByUserId",
        "attestedAt",
        "literalHash",
      ].sort(),
    );
  });

  it("all six allowed fact fields and explicit unknown preserve their distinct types", () => {
    const values = [
      { field: "dataCompra", value: "2026-09-28", meaningContext: null },
      { field: "merchant", value: "Loja Alfa", meaningContext: null },
      {
        field: "amountMeaning",
        value: "INSTALLMENT_CHARGE",
        meaningContext: null,
      },
      {
        field: "amountCents",
        value: 20696,
        meaningContext: "INSTALLMENT_CHARGE",
      },
      { field: "installmentCount", value: 24, meaningContext: null },
      { field: "installmentIndex", value: 2, meaningContext: null },
    ];
    for (const value of values) {
      for (const unknown of [false, true]) {
        const draft = {
          ...validationDraft("project"),
          declarations: {
            version: 1,
            items: [
              {
                ...declaration(),
                ...value,
                ...(unknown ? { value: null } : {}),
              },
            ],
          },
        };
        expect(parseStoredDraft(JSON.stringify(draft))).toEqual(draft);
      }
    }
  });

  it("malformed extensions fail closed rather than becoming an empty collection", () => {
    const valid = declaration();
    const malformed: unknown[] = [
      null,
      [],
      { version: 2, items: [] },
      { version: 1, items: [], extra: true },
      { version: 1, items: [valid, valid] },
      { version: 1, items: [{ ...valid, lineId: "outside-line" }] },
      { version: 1, items: [{ ...valid, observationId: "observation-keep" }] },
      { version: 1, items: [{ ...valid, observationId: "outside-scope" }] },
      { version: 1, items: [{ ...valid, originalFingerprint: "not-a-hash" }] },
      { version: 1, items: [{ ...valid, claimVersion: -1 }] },
      { version: 1, items: [{ ...valid, recordedRevision: 0 }] },
      { version: 1, items: [{ ...valid, attestedAt: "yesterday" }] },
      { version: 1, items: [{ ...valid, literalHash: "x".repeat(64) }] },
      { version: 1, items: [{ ...valid, origin: "USER_ATTESTATION" }] },
      { version: 1, items: [{ ...valid, field: "ordinal", value: 0 }] },
      {
        version: 1,
        items: [{ ...valid, field: "fitId", value: "model-fitid" }],
      },
      {
        version: 1,
        items: [{ ...valid, field: "externalId", value: "model-external" }],
      },
      { version: 1, items: [{ ...valid, field: "firstDueDate" }] },
      { version: 1, items: [{ ...valid, meaningContext: "TOTAL_PURCHASE" }] },
      {
        version: 1,
        items: [
          { ...valid, field: "amountCents", value: 100, meaningContext: null },
        ],
      },
      {
        version: 1,
        items: [
          {
            ...valid,
            field: "amountCents",
            value: 0,
            meaningContext: "TOTAL_PURCHASE",
          },
        ],
      },
      {
        version: 1,
        items: [{ ...valid, field: "installmentCount", value: 25 }],
      },
      {
        version: 1,
        items: [{ ...valid, field: "installmentIndex", value: 0 }],
      },
      {
        version: 1,
        items: [{ ...valid, field: "merchant", value: "x".repeat(161) }],
      },
    ];
    // Establish positive admission first: blanket rejection of every extension is not coverage.
    expect(validateStoredDraft(extendedDraft())).toEqual(extendedDraft());
    for (const declarations of malformed) {
      expect(() =>
        validateStoredDraft({ ...validationDraft("project"), declarations }),
      ).toThrow(ImportSessionCorruptStateError);
    }
  });

  it("full draft including declarations keeps the literal 1 MiB byte boundary", () => {
    const draft = extendedDraft();
    draft.declarations.items[0] = {
      ...declaration(),
      field: "merchant",
      value: "Loja Açúcar",
    };
    const json = JSON.stringify(draft);
    expect(Buffer.byteLength(json, "utf8")).toBeGreaterThan(json.length);
    for (const size of [1_048_575, 1_048_576, 1_048_577]) {
      const raw = json + " ".repeat(size - Buffer.byteLength(json, "utf8"));
      expect(Buffer.byteLength(raw, "utf8")).toBe(size);
      if (size <= 1_048_576) expect(parseStoredDraft(raw)).toEqual(draft);
      else
        expect(() => parseStoredDraft(raw)).toThrow(
          ImportSessionCorruptStateError,
        );
    }
  });

  it("keeps generic questions narrow while accepting exact documentary identity", () => {
    const draft = validationDraft("project");
    const original = draft.questions[0];
    expect(Object.keys(original).sort()).toEqual([
      "field",
      "id",
      "lineIds",
      "text",
    ]);
    const documentary = {
      id: "question-documentary-merchant",
      lineIds: ["line-unknown"],
      field: "merchant",
      text: "Qual o estabelecimento?",
      subject: {
        kind: "OBSERVATION",
        observationId: "observation-unknown",
        meaningContext: null,
      },
      answerState: "UNANSWERED",
    };
    expect(
      validateStoredDraft({ ...draft, questions: [documentary] }).questions,
    ).toEqual([documentary]);
    expect(() =>
      validateStoredDraft({
        ...draft,
        questions: [
          {
            ...documentary,
            subject: {
              ...documentary.subject,
              observationId: "observation-create",
            },
          },
        ],
      }),
    ).toThrow(ImportSessionCorruptStateError);
    for (const field of ["merchant", "installmentIndex"]) {
      expect(() =>
        validateStoredDraft({ ...draft, questions: [{ ...original, field }] }),
      ).toThrow(ImportSessionCorruptStateError);
    }
  });
});

describe("B3 real PrismaService materialization and recovery boundaries", () => {
  const setup = new PrismaService();
  let h: RecoveryApp;
  let world: ImportWorld;
  let sequence = 0;

  beforeAll(async () => {
    jest.useFakeTimers({
      now: NOW,
      doNotFake: [
        "hrtime",
        "nextTick",
        "performance",
        "queueMicrotask",
        "setImmediate",
        "clearImmediate",
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
      ],
    });
    await setup.$connect();
    proveDb("setup-connected-before-seed");
    h = await bootRecoveryApp(setup, {
      writesEnabled: true,
      beforeListen: async (app) => {
        await app.init();
        proveDb("app-connected-before-seed-listen");
        expect(
          (
            await app.get(PrismaService).$queryRaw<
              Array<{ file: string }>
            >`PRAGMA database_list`
          )
            .map((row) => row.file)
            .filter(Boolean),
        ).toEqual([dbGuard.ACTIVE_DB_PATH]);
      },
    });
    h.clock.current = NOW;
    expect((await h.call("GET", "/import-sessions")).status).toBe(401);
  });
  beforeEach(async () => {
    world = await seedImportWorld(
      setup,
      `b3-integration-${process.pid}-${++sequence}`,
    );
  });
  afterAll(async () => {
    await h?.close();
    await setup.$disconnect();
    jest.useRealTimers();
  });

  it("real materializer preserves private extension; never copies it to another observation", async () => {
    const draft = extendedDraft();
    const session = await seedSession(setup, world, {
      consentedAt: NOW,
      lastUserEditAt: NOW,
      expiresAt: new Date("2026-10-15T12:35:00.000Z"),
      draftJson: JSON.stringify(draft),
    });
    const bytes = Buffer.from(
      "date,title,amount\n2026-09-25,NEW SYNTHETIC,100.00\n",
    );
    const extraction = extractCardStatementDocument({
      version: 1,
      context: "CARD_INVOICE",
      format: "CSV",
      profile: "CSV_NUBANK",
      bytes,
    });
    const artifact = await setup.importArtifact.create({
      data: {
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        documentSha256: createHash("sha256").update(bytes).digest("hex"),
        verifiedBytes: bytes.length,
        state: "EXTRACTED",
        detectedFormat: "CSV",
        parserVersion: extraction.parserVersion,
        extractionJson: JSON.stringify(extraction),
      },
    });
    const attachment = await setup.importSessionArtifact.create({
      data: {
        id: "attachment-pending",
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        sessionId: session.id,
        artifactId: artifact.id,
        position: 0,
        state: "ATTACHED",
        fileName: "synthetic.csv",
        declaredMime: "text/csv",
        declaredBytes: bytes.length,
        reservedBytes: bytes.length,
        verifiedAt: NOW,
      },
    });
    const before = structuredClone(draft);
    const planned = buildImportMaterialization({
      session,
      attachment,
      artifact,
      extraction,
      draft,
      observations: [],
      newIds: new Map(
        extraction.occurrences.map((occurrence, index) => [
          occurrence.reference,
          {
            observationId: `new-observation-${index}`,
            lineId: `new-line-${index}`,
          },
        ]),
      ),
    });
    expect(planned.draft).toHaveProperty("declarations", before.declarations);
    expect(draft).toEqual(before);
    expect(planned.observations).toHaveLength(1);
    expect(planned.draft.lines.slice(0, before.lines.length)).toEqual(
      before.lines,
    );
    expect(planned.draft.scope.pendingAttachmentIds).toEqual([]);
    expect(
      await setup.importObservation.count({
        where: { tenantId: world.tenantId },
      }),
    ).toBe(0);
    expect(
      await setup.expense.count({ where: { tenantId: world.tenantId } }),
    ).toBe(0);
    expect(
      await setup.importSession.findUniqueOrThrow({
        where: { id: session.id },
      }),
    ).toEqual(session);
  });

  it("legacy ACL control: real guards deny peer and cross-tenant reads", async () => {
    const session = await seedSession(setup, world, {
      consentedAt: NOW,
      lastUserEditAt: NOW,
      expiresAt: new Date("2026-10-15T12:35:00.000Z"),
    });
    for (const user of [world.users.peer, world.users.foreign]) {
      const response = await h.call("GET", `/import-sessions/${session.id}`, {
        token: await h.tokenFor(user),
      });
      expect(response.status).toBe(404);
      expect(response.json).not.toHaveProperty("declarations");
      expect(response.json).not.toHaveProperty("declaredFacts");
    }
    expect(
      await setup.importSession.findUniqueOrThrow({
        where: { id: session.id },
      }),
    ).toEqual(session);
    expect(
      await setup.expense.count({ where: { tenantId: world.tenantId } }),
    ).toBe(0);
  });
});
