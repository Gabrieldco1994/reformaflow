import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Prisma } from "@prisma/client";
import {
  IMPORT_SESSION_KIND,
  IMPORT_SESSION_LIMITS,
  IMPORT_SESSION_PRIMITIVES,
  ImportSessionArtifactState,
  ImportSessionAttachmentState,
  ImportSessionDocumentFormat,
  ImportSessionState,
} from "@reformaflow/domain";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * QA mutation-hardening of the bootstrap SQL CHECKs. Every case names the
 * violated column/constraint in the SQLite message, so a rejection for an
 * UNRELATED reason (NOT NULL, FK, typo) can no longer satisfy the assertion,
 * and every rejected boundary has an accepted neighbour (kills both a missing
 * CHECK and an over-tight one). All rows are synthetic and tenant-scoped.
 */

const migrationSql = readFileSync(
  resolve(
    __dirname,
    "../../../../../prisma/migrations/20260929010000_import_session_bootstrap/migration.sql",
  ),
  "utf8",
);
const instant = "2026-09-28T12:00:00.000Z";
const emptyDraft =
  '{"version":1,"lines":[],"selectedLineIds":[],"questions":[],"scope":{"observationIds":[],"pendingAttachmentIds":[]}}';
const hex64 = (char: string): string => char.repeat(64);

/** Returns the `CREATE TABLE "<table>" (...);` block of the migration. */
function tableBlock(table: string): string {
  const start = migrationSql.indexOf(`CREATE TABLE "${table}"`);
  expect(start).toBeGreaterThanOrEqual(0);
  return migrationSql.slice(start, migrationSql.indexOf("\n);", start));
}
/** Values of `"<column>" IN ('A','B',...)` inside a table block. */
function inList(table: string, column: string): string[] {
  const match = new RegExp(`"${column}" IN \\(([^)]*)\\)`).exec(
    tableBlock(table),
  );
  expect(match).not.toBeNull();
  return [...match![1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}
function between(table: string, column: string): [number, number][] {
  return [
    ...tableBlock(table).matchAll(
      new RegExp(`"${column}" BETWEEN (\\d+) AND (\\d+)`, "g"),
    ),
  ].map((entry) => [Number(entry[1]), Number(entry[2])]);
}

describe("bootstrap SQL <-> domain contract drift", () => {
  it("keeps every SQL closed-set identical to the exported domain enum", () => {
    expect(inList("import_sessions", "state").sort()).toEqual(
      Object.values(ImportSessionState).sort(),
    );
    expect(inList("import_artifacts", "state").sort()).toEqual(
      Object.values(ImportSessionArtifactState).sort(),
    );
    expect(inList("import_artifacts", "detected_format").sort()).toEqual(
      Object.values(ImportSessionDocumentFormat).sort(),
    );
    expect(inList("import_session_artifacts", "state").sort()).toEqual(
      Object.values(ImportSessionAttachmentState).sort(),
    );
    expect(tableBlock("import_sessions")).toContain(
      `"kind" = '${IMPORT_SESSION_KIND}'`,
    );
  });

  it("keeps SQL quotas and revision bounds equal to the domain limits", () => {
    expect(between("import_artifacts", "verified_bytes")).toEqual([
      [1, IMPORT_SESSION_LIMITS.bytesPerFile],
    ]);
    expect(between("import_session_artifacts", "declared_bytes")).toEqual([
      [1, IMPORT_SESSION_LIMITS.bytesPerFile],
    ]);
    expect(between("import_session_artifacts", "reserved_bytes")).toEqual([
      [0, IMPORT_SESSION_LIMITS.bytesPerFile],
    ]);
    expect(between("import_session_artifacts", "position")).toEqual([
      [0, IMPORT_SESSION_LIMITS.filesPerSession - 1],
    ]);
    const revision = [
      IMPORT_SESSION_PRIMITIVES.minRevision,
      IMPORT_SESSION_PRIMITIVES.maxRevision,
    ];
    expect(between("import_sessions", "revision")).toEqual([revision]);
    expect(between("import_sessions", "confirmed_revision")).toEqual([
      revision,
    ]);
    // Hash CHECKs use the same 64-lowercase-hex shape as the wire pattern.
    expect(IMPORT_SESSION_PRIMITIVES.hashPattern).toBe("^[0-9a-f]{64}$");
    expect(
      tableBlock("import_sessions").match(/length\("[a-z0-9_]+"\) = 64/g),
    ).toHaveLength(3);
    expect(
      tableBlock("import_artifacts").match(/length\("[a-z0-9_]+"\) = 64/g),
    ).toHaveLength(1);
  });
});

describe("bootstrap FK policy stays tenant-scoped and RESTRICT-only", () => {
  const foreignKeys = [
    ...migrationSql.matchAll(
      /FOREIGN KEY \(([^)]*)\) REFERENCES "([a-z_]+)" \(([^)]*)\) ON DELETE (\w+) ON UPDATE (\w+)/g,
    ),
  ];

  it("declares exactly the eleven contract FKs, each RESTRICT on delete AND update", () => {
    expect(foreignKeys).toHaveLength(11);
    expect(migrationSql.match(/FOREIGN KEY/g)).toHaveLength(11);
    expect(migrationSql).not.toMatch(
      /ON (DELETE|UPDATE) (CASCADE|SET NULL|SET DEFAULT|NO ACTION)/,
    );
    for (const [, , , , onDelete, onUpdate] of foreignKeys) {
      expect(onDelete).toBe("RESTRICT");
      expect(onUpdate).toBe("RESTRICT");
    }
  });

  it("makes every FK composite and tenant-first, matching a parent unique key", () => {
    for (const [, child, parent, parentColumns] of foreignKeys) {
      expect(child.startsWith('"tenant_id"')).toBe(true);
      expect(parentColumns.startsWith('"tenant_id"')).toBe(true);
      expect(child.split(",")).toHaveLength(parentColumns.split(",").length);
      expect(parent).toMatch(
        /^(users|projects|credit_cards|expenses|receipts|import_[a-z_]+)$/,
      );
    }
    // The five parent unique indexes the composite FKs need, and nothing else on legacy tables.
    expect(
      [
        ...migrationSql.matchAll(
          /CREATE UNIQUE INDEX "(\w+)" ON "(users|projects|credit_cards|expenses|receipts)"/g,
        ),
      ]
        .map((match) => match[1])
        .sort(),
    ).toEqual([
      "credit_cards_tenant_id_project_id_id_key",
      "expenses_tenant_id_project_id_id_key",
      "projects_tenant_id_id_key",
      "receipts_tenant_id_project_id_id_key",
      "users_tenant_id_id_key",
    ]);
    expect(migrationSql).not.toMatch(
      /^(ALTER TABLE|DROP|UPDATE|INSERT|DELETE FROM|PRAGMA)\b/m,
    );
  });
});

describe("bootstrap SQL CHECKs on the real PrismaService/SQLite (FK enforced)", () => {
  const db = new PrismaService();
  const prefix = `qa-checks-${randomUUID()}`;
  const tenantId = `${prefix}-tenant`;
  const userId = `${prefix}-user`;
  const projectId = `${prefix}-project`;
  const cardId = `${prefix}-card`;
  let expenseId: string;
  let receiptId: string;
  let artifactCounter = 0;

  beforeAll(async () => {
    await db.$connect();
    await db.tenant.create({ data: { id: tenantId, name: "QA checks" } });
    await db.user.create({
      data: { id: userId, tenantId, username: prefix, name: "QA actor" },
    });
    await db.project.create({
      data: { id: projectId, tenantId, name: "QA anchor", type: "PESSOAL" },
    });
    await db.creditCard.create({
      data: {
        id: cardId,
        tenantId,
        projectId,
        institution: "OUTROS",
        nickname: "QA",
        last4: "1234",
      },
    });
    expenseId = (
      await db.expense.create({
        data: {
          tenantId,
          projectId,
          tipoDespesa: "OUTROS",
          valor: 1,
          valorTotal: 1,
          formaPagamento: "A_VISTA",
        },
      })
    ).id;
    receiptId = (
      await db.receipt.create({
        data: {
          tenantId,
          projectId,
          valor: 1,
          data: new Date(instant),
          tipo: "OUTROS",
        },
      })
    ).id;
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  const newSession = async (): Promise<string> =>
    (
      await db.importSession.create({
        data: {
          tenantId,
          ownerUserId: userId,
          ownerProjectId: projectId,
          cardId,
          kind: "CREATE_CARD_PURCHASES",
          state: "DRAFT",
          revision: 1,
          createRequestId: randomUUID(),
          createPayloadHash: hex64("a"),
          consentPolicyVersion: 1,
          consentedAt: new Date(instant),
          lastUserEditAt: new Date(instant),
          expiresAt: new Date("2026-10-05T12:00:00.000Z"),
          draftJson: emptyDraft,
        },
      })
    ).id;
  const newArtifact = async (): Promise<string> =>
    (
      await db.importArtifact.create({
        data: {
          tenantId,
          ownerProjectId: projectId,
          documentSha256: (++artifactCounter).toString(16).padStart(64, "0"),
          verifiedBytes: 1,
          detectedFormat: "PDF",
          state: "RAW_READY",
        },
      })
    ).id;
  const newAttachment = async (sessionId: string): Promise<string> =>
    (
      await db.importSessionArtifact.create({
        data: {
          tenantId,
          ownerProjectId: projectId,
          sessionId,
          position: 0,
          fileName: "qa.pdf",
          declaredMime: "application/pdf",
          declaredBytes: 1,
          state: "RESERVED",
          reservedBytes: 0,
        },
      })
    ).id;
  const newObservation = async (artifactId: string): Promise<string> =>
    (
      await db.importObservation.create({
        data: {
          tenantId,
          ownerProjectId: projectId,
          artifactId,
          reference: randomUUID(),
          evidenceJson: '{"version":1}',
        },
      })
    ).id;

  const update = (
    table: string,
    id: string,
    set: Record<string, string | number | null>,
  ): Promise<number> => {
    const columns = Object.keys(set);
    return db.$executeRawUnsafe(
      `UPDATE "${table}" SET ${columns.map((column) => `"${column}" = ?`).join(", ")} WHERE "id" = ?`,
      ...columns.map((column) => set[column]),
      id,
    );
  };
  /** Rejected by SQLite as a CHECK violation that names `constraint`. */
  const expectCheck = async (
    table: string,
    id: string,
    set: Record<string, string | number | null>,
    constraint: string,
  ): Promise<void> => {
    const error = await update(table, id, set).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).not.toBeNull();
    const message = String((error as Error).message);
    expect(message).toMatch(/CHECK constraint failed/i);
    expect(message).toContain(constraint);
  };
  const expectAccepted = async (
    table: string,
    id: string,
    set: Record<string, string | number | null>,
  ): Promise<void> => {
    expect(await update(table, id, set)).toBe(1);
  };

  it("runs with foreign keys ON and an empty foreign_key_check", async () => {
    expect(await db.$queryRaw`PRAGMA foreign_keys`).toEqual([
      { foreign_keys: 1n },
    ]);
  });

  it("import_sessions: closed literals, integer typing and bounds", async () => {
    const id = await newSession();
    const t = "import_sessions";
    for (const value of [0, 2, 1.5])
      await expectCheck(t, id, { protocol_version: value }, "protocol_version");
    await expectAccepted(t, id, { protocol_version: 1 });
    for (const value of ["OTHER", "create_card_purchases", ""])
      await expectCheck(t, id, { kind: value }, "kind");
    for (const value of [0, 2])
      await expectCheck(
        t,
        id,
        { consent_policy_version: value },
        "consent_policy_version",
      );
    for (const value of ["draft", "Done", ""])
      await expectCheck(t, id, { state: value }, "state");
    for (const state of Object.values(ImportSessionState).filter(
      (value) => value !== "APPLIED",
    ))
      await expectAccepted(t, id, { state });
    // typeof(...) = 'integer' rejects a REAL that a bare BETWEEN would accept.
    await expectCheck(t, id, { revision: 1.5 }, "revision");
    await expectAccepted(t, id, { revision: 1 });
    await expectCheck(t, id, { prepare_generation: -1 }, "prepare_generation");
    await expectCheck(t, id, { prepare_generation: 0.5 }, "prepare_generation");
    await expectAccepted(t, id, { prepare_generation: 0 });
    await expectAccepted(t, id, { prepare_generation: 2147483647 });
  });

  it("import_sessions: every hash column is exactly 64 lowercase hex chars", async () => {
    const id = await newSession();
    const bad = [
      "A".repeat(64),
      "a".repeat(63),
      "a".repeat(65),
      `g${"a".repeat(63)}`,
      `${"a".repeat(63)} `,
      "",
    ];
    for (const column of [
      "create_payload_hash",
      "proposal_hash",
      "preflight_hash",
    ]) {
      for (const value of bad)
        await expectCheck("import_sessions", id, { [column]: value }, column);
      await expectAccepted("import_sessions", id, { [column]: hex64("0") });
      await expectAccepted("import_sessions", id, {
        [column]: "0123456789abcdef".repeat(4),
      });
    }
    for (const column of ["proposal_hash", "preflight_hash"])
      await expectAccepted("import_sessions", id, { [column]: null });
    await expect(
      update("import_sessions", id, { create_payload_hash: null }),
    ).rejects.toThrow(/NOT NULL|Null constraint/i);
  });

  it("import_sessions: every JSON column must be valid JSON; nullable ones accept NULL", async () => {
    const id = await newSession();
    for (const column of [
      "draft_json",
      "search_json",
      "proposal_json",
      "challenge_json",
      "prepare_lease_json",
      "receipt_json",
    ]) {
      for (const value of ["{bad", "", "undefined"])
        await expectCheck("import_sessions", id, { [column]: value }, column);
      await expectAccepted("import_sessions", id, { [column]: "{}" });
    }
    for (const column of [
      "search_json",
      "proposal_json",
      "challenge_json",
      "prepare_lease_json",
      "receipt_json",
    ])
      await expectAccepted("import_sessions", id, { [column]: null });
  });

  it("import_sessions: confirmation tuple is all-or-nothing and needs a proposal hash", async () => {
    const id = await newSession();
    const t = "import_sessions";
    const tuple = {
      financial_request_id: randomUUID(),
      confirmed_revision: 1,
      confirmed_session_version: 0,
      confirmed_at: instant,
      proposal_hash: hex64("c"),
    };
    const constraint = "import_sessions_confirmation_tuple_check";
    // Each single member alone breaks the tuple.
    await expectCheck(
      t,
      id,
      { financial_request_id: tuple.financial_request_id },
      constraint,
    );
    await expectCheck(t, id, { confirmed_revision: 1 }, constraint);
    await expectCheck(t, id, { confirmed_session_version: 0 }, constraint);
    await expectCheck(t, id, { confirmed_at: instant }, constraint);
    // Every member but one also fails.
    for (const missing of [
      "financial_request_id",
      "confirmed_revision",
      "confirmed_session_version",
      "confirmed_at",
      "proposal_hash",
    ]) {
      await expectCheck(t, id, { ...tuple, [missing]: null }, constraint);
    }
    await expectCheck(
      t,
      id,
      { ...tuple, confirmed_revision: 0 },
      "confirmed_revision",
    );
    await expectCheck(
      t,
      id,
      { ...tuple, confirmed_revision: 2147483648 },
      "confirmed_revision",
    );
    await expectCheck(
      t,
      id,
      { ...tuple, confirmed_session_version: -1 },
      "confirmed_session_version",
    );
    await expectAccepted(t, id, { ...tuple, confirmed_session_version: 0 });
    await expectAccepted(t, id, { confirmed_revision: 2147483647 });
    // The tuple may be cleared only as a whole.
    await expectCheck(t, id, { confirmed_at: null }, constraint);
    await expectAccepted(t, id, {
      financial_request_id: null,
      confirmed_revision: null,
      confirmed_session_version: null,
      confirmed_at: null,
    });
  });

  it("import_sessions: APPLIED requires receipt, financial request id and closed_at together", async () => {
    const id = await newSession();
    const t = "import_sessions";
    const applied = {
      state: "APPLIED",
      financial_request_id: randomUUID(),
      confirmed_revision: 1,
      confirmed_session_version: 0,
      confirmed_at: instant,
      proposal_hash: hex64("c"),
      receipt_json: '{"version":1}',
      closed_at: instant,
    };
    const constraint = "import_sessions_applied_check";
    for (const missing of ["receipt_json", "closed_at"])
      await expectCheck(t, id, { ...applied, [missing]: null }, constraint);
    // Dropping the financial request id also violates the tuple, never APPLIED.
    await expectCheck(
      t,
      id,
      { ...applied, financial_request_id: null },
      "import_sessions_confirmation_tuple_check",
    );
    await expectAccepted(t, id, applied);
    // CONFIRMED (not APPLIED) needs neither receipt nor closed_at.
    await expectAccepted(t, id, {
      state: "CONFIRMED",
      receipt_json: null,
      closed_at: null,
    });
  });

  it("import_artifacts: hash, size, format, state and PURGED storage invariants", async () => {
    const id = await newArtifact();
    const t = "import_artifacts";
    for (const value of ["A".repeat(64), "a".repeat(63), "a".repeat(65), ""])
      await expectCheck(t, id, { document_sha256: value }, "document_sha256");
    await expectAccepted(t, id, { document_sha256: hex64("e") });
    for (const value of [0, -1, 10485761, 0.5, 1.5])
      await expectCheck(t, id, { verified_bytes: value }, "verified_bytes");
    for (const value of [1, 10485760])
      await expectAccepted(t, id, { verified_bytes: value });
    for (const value of ["GIF", "png", "", "PDF "])
      await expectCheck(t, id, { detected_format: value }, "detected_format");
    for (const value of Object.values(ImportSessionDocumentFormat))
      await expectAccepted(t, id, { detected_format: value });
    for (const value of ["DONE", "raw_ready", ""])
      await expectCheck(t, id, { state: value }, "state");
    for (const value of Object.values(ImportSessionArtifactState))
      await expectAccepted(t, id, { state: value, storage_key: null });
    for (const value of ["{bad", ""])
      await expectCheck(t, id, { extraction_json: value }, "extraction_json");
    await expectAccepted(t, id, { extraction_json: "[]" });
    await expectAccepted(t, id, { extraction_json: null });
    await expectCheck(t, id, { parse_generation: -1 }, "parse_generation");
    await expectAccepted(t, id, { parse_generation: 0 });
    await expectCheck(
      t,
      id,
      { lease_session_version: -1 },
      "lease_session_version",
    );
    await expectAccepted(t, id, { lease_session_version: 0 });
    await expectAccepted(t, id, { lease_session_version: null });
    // A PURGED artifact must not keep a storage key; any other state may.
    await expectCheck(
      t,
      id,
      { state: "PURGED", storage_key: "private" },
      "import_artifacts_purged_check",
    );
    await expectAccepted(t, id, { state: "PURGED", storage_key: null });
    await expectAccepted(t, id, { state: "EXTRACTED", storage_key: "private" });
    await expectCheck(
      t,
      id,
      { state: "PURGED" },
      "import_artifacts_purged_check",
    );
  });

  it("import_session_artifacts: slot, byte, state, ATTACHED and purge-flag invariants", async () => {
    const sessionId = await newSession();
    const artifactId = await newArtifact();
    const id = await newAttachment(sessionId);
    const t = "import_session_artifacts";
    for (const value of [-1, 10, 0.5])
      await expectCheck(t, id, { position: value }, "position");
    for (const value of [0, 9])
      await expectAccepted(t, id, { position: value });
    for (const value of [0, -1, 10485761, 1.5])
      await expectCheck(t, id, { declared_bytes: value }, "declared_bytes");
    for (const value of [1, 10485760])
      await expectAccepted(t, id, { declared_bytes: value });
    for (const value of [-1, 10485761, 1.5])
      await expectCheck(t, id, { reserved_bytes: value }, "reserved_bytes");
    for (const value of [0, 10485760])
      await expectAccepted(t, id, { reserved_bytes: value });
    for (const value of ["DONE", "reserved", ""])
      await expectCheck(t, id, { state: value }, "state");
    for (const value of ["RESERVED", "UPLOADED", "FAILED", "RELEASED"])
      await expectAccepted(t, id, { state: value });
    await expectCheck(t, id, { upload_generation: -1 }, "upload_generation");
    await expectCheck(
      t,
      id,
      { upload_session_version: -1 },
      "upload_session_version",
    );
    await expectAccepted(t, id, { upload_generation: 0 });
    await expectAccepted(t, id, { upload_session_version: 0 });
    for (const value of [2, -1, 0.5])
      await expectCheck(
        t,
        id,
        { temporary_purge_pending: value },
        "temporary_purge_pending",
      );
    for (const value of [0, 1])
      await expectAccepted(t, id, { temporary_purge_pending: value });
    // ATTACHED needs BOTH the artifact link and the verification instant.
    const constraint = "import_session_artifacts_attached_check";
    await expectCheck(t, id, { state: "ATTACHED" }, constraint);
    await expectCheck(
      t,
      id,
      { state: "ATTACHED", artifact_id: artifactId },
      constraint,
    );
    await expectCheck(
      t,
      id,
      { state: "ATTACHED", verified_at: instant },
      constraint,
    );
    await expectAccepted(t, id, {
      state: "ATTACHED",
      artifact_id: artifactId,
      verified_at: instant,
    });
  });

  it("import_observations: evidence JSON, versions and the canonical-claim state machine", async () => {
    const artifactId = await newArtifact();
    const sessionId = await newSession();
    const id = await newObservation(artifactId);
    const t = "import_observations";
    for (const value of ["{bad", ""])
      await expectCheck(t, id, { evidence_json: value }, "evidence_json");
    await expectCheck(t, id, { claim_version: -1 }, "claim_version");
    await expectCheck(t, id, { claim_version: 0.5 }, "claim_version");
    await expectAccepted(t, id, { claim_version: 0 });

    const expenseClaim = {
      canonical_project_id: projectId,
      canonical_expense_id: expenseId,
      claim_session_id: sessionId,
      claim_receipt_json: '{"kind":"SESSION"}',
      claimed_at: instant,
    };
    const claim = "import_observations_claim_check";
    // A claim is all-or-nothing: each member missing, or an entity without a project, fails.
    for (const missing of [
      "canonical_project_id",
      "claim_receipt_json",
      "claimed_at",
    ])
      await expectCheck(t, id, { ...expenseClaim, [missing]: null }, claim);
    await expectCheck(t, id, { canonical_project_id: projectId }, claim);
    await expectCheck(t, id, { claimed_at: instant }, claim);
    await expectCheck(t, id, { claim_receipt_json: "{}" }, claim);
    await expectCheck(
      t,
      id,
      { ...expenseClaim, claim_receipt_json: "{bad" },
      "claim_receipt_json",
    );
    // An expense and a receipt are mutually exclusive.
    await expectCheck(
      t,
      id,
      { ...expenseClaim, canonical_receipt_id: receiptId },
      "import_observations_entity_check",
    );
    // canonical_index only makes sense for an expense, inside the int32 range.
    await expectCheck(
      t,
      id,
      { canonical_index: 0 },
      "import_observations_index_check",
    );
    for (const value of [-1, 2147483648, 0.5])
      await expectCheck(
        t,
        id,
        { ...expenseClaim, canonical_index: value },
        "canonical_index",
      );
    await expectAccepted(t, id, { ...expenseClaim, canonical_index: 0 });
    await expectAccepted(t, id, { canonical_index: 2147483647 });
    // A receipt claim carries no index and no expense.
    await expectAccepted(t, id, {
      canonical_expense_id: null,
      canonical_index: null,
      canonical_receipt_id: receiptId,
    });
    await expectCheck(
      t,
      id,
      { canonical_index: 1 },
      "import_observations_index_check",
    );
    // Clearing the whole claim is the only other legal state.
    await expectAccepted(t, id, {
      canonical_project_id: null,
      canonical_receipt_id: null,
      canonical_expense_id: null,
      canonical_index: null,
      claim_session_id: null,
      claim_receipt_json: null,
      claimed_at: null,
    });
    expect(await db.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
  });
});

describe("PrismaService soft-delete allowlist covers every model without deletedAt", () => {
  const db = new PrismaService();
  afterAll(async () => {
    await db.$disconnect();
  });

  const lower = (name: string): string =>
    name.charAt(0).toLowerCase() + name.slice(1);
  const models = Prisma.dmmf.datamodel.models;

  it("recognises the four lifecycle models as deletedAt-free in the generated client", () => {
    for (const name of [
      "ImportSession",
      "ImportArtifact",
      "ImportSessionArtifact",
      "ImportObservation",
    ]) {
      const model = models.find((candidate) => candidate.name === name);
      expect(model).toBeDefined();
      expect(model!.fields.some((field) => field.name === "deletedAt")).toBe(
        false,
      );
    }
  });

  it("never injects deletedAt into a model that has no such field (findMany/findFirst)", async () => {
    const withoutSoftDelete = models
      .filter((model) => !model.fields.some((f) => f.name === "deletedAt"))
      .map((model) => model.name);
    // Sanity: the discriminator finds the legacy allowlist AND the new models.
    expect(withoutSoftDelete).toEqual(
      expect.arrayContaining([
        "ImportSession",
        "ImportArtifact",
        "ImportSessionArtifact",
        "ImportObservation",
        "Feedback",
        "SimulationValue",
      ]),
    );
    const failures: string[] = [];
    for (const name of withoutSoftDelete) {
      const delegate = (db as unknown as Record<string, any>)[lower(name)];
      for (const action of ["findMany", "findFirst"] as const) {
        try {
          await delegate[action]({ take: 1 });
        } catch (error) {
          failures.push(`${name}.${action}: ${(error as Error).message}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
