require("../../../../../scripts/test-db-env.cjs");

import { createHash, randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import {
  authFor,
  mintGrant,
  FIXED_NOW,
  cleanupImportWorld,
  seedImportWorld,
  seedSession,
  type ImportWorld,
} from "../../test-utils/import-session-harness";
import {
  bootVaultApp,
  connectVaultTestDatabase,
  vaultTestDatabaseIsSafe,
  fileSeed,
  reserve,
  CANONICAL_VAULT,
  UI_HEADERS,
  type RecoveryApp,
} from "../../test-utils/import-session-vault-harness";
import {
  extractCardStatementDocument,
  validateDocumentExtraction,
} from "../../credit-card/parsers/statement-document";
import { parseStoredImportObservationEvidence } from "./import-session.observation";
import { PrismaService } from "../../prisma/prisma.service";
import { ImportUiGrantIssuer } from "./import-session-ui-grant";
import {
  IMPORT_SESSION_CAPABILITY,
  IMPORT_SESSION_GRANT_VERIFIER,
  type ImportSessionCapability,
  type ImportSessionClock,
} from "./import-session.capability";
import type {
  AuthenticatedImportContext,
  UiImportPersistenceGrantVerifier,
} from "./import-session.contract";
import { ImportSessionExtractionService } from "./import-session.extraction.service";
import * as writer from "./import-session.writer";

const PREFIX = "x3-own";
const csvCapability: ImportSessionCapability = {
  writesEnabled: () => true,
  newImportFormats: () => ["CSV"],
};
describe("X3 cached adoption through real module, not first-upload extraction", () => {
  const setup = new PrismaClient();
  let world: ImportWorld;
  let api: RecoveryApp;
  let token: string;
  let restoreWriter: (() => void) | undefined;
  beforeAll(async () => {
    await connectVaultTestDatabase(setup);
    api = await bootVaultApp(setup, {
      writes: true,
      vault: CANONICAL_VAULT,
      overrides: [{ token: IMPORT_SESSION_CAPABILITY, value: csvCapability }],
    });
  });
  beforeEach(async () => {
    api.clock.current = new Date(FIXED_NOW);
    jest
      .spyOn(
        api.app.get<ImportSessionCapability>(IMPORT_SESSION_CAPABILITY),
        "writesEnabled",
      )
      .mockReturnValue(true);
    world = await seedImportWorld(setup, `${PREFIX}-${randomUUID()}`);
    token = await api.tokenFor(world.users.owner);
  });
  afterEach(() => {
    restoreWriter?.();
    restoreWriter = undefined;
  });
  afterAll(async () => {
    await api?.close();
    if (vaultTestDatabaseIsSafe(setup)) await cleanupImportWorld(setup, PREFIX);
    await setup.$disconnect();
  });
  async function attached(
    csv = "date,title,amount\n2026-06-22,LOJA PARC 2/3,100.00\n",
  ) {
    const session = await seedSession(setup, world);
    const file = fileSeed({
      fileName: "synthetic.csv",
      mime: "text/csv",
      declaredBytes: Buffer.byteLength(csv),
    });
    const reserved = await reserve(api, token, session.id, [file]);
    expect(reserved.status).toBe(200);
    const extraction =
      csv === "date,title,amount\n"
        ? validateDocumentExtraction({
            version: 1,
            parserVersion: "card-local-text-v1",
            documentKind: "UNKNOWN",
            invoiceDueMonth: null,
            metrics: {
              rows: 0,
              pages: 0,
              expandedBytes: 0,
              archiveEntries: 0,
              imagePixels: 0,
              frames: 0,
            },
            occurrences: [],
            diagnostics: [],
          })
        : extractCardStatementDocument({
            version: 1,
            context: "CARD_INVOICE",
            format: "CSV",
            profile: "CSV_NUBANK",
            bytes: Buffer.from(csv),
          });
    const sha = createHash("sha256").update(csv).digest("hex");
    const artifact =
      (await setup.importArtifact.findFirst({
        where: {
          tenantId: world.tenantId,
          ownerProjectId: session.ownerProjectId,
          documentSha256: sha,
        },
      })) ??
      (await setup.importArtifact.create({
        data: {
          id: randomUUID(),
          tenantId: world.tenantId,
          ownerProjectId: session.ownerProjectId,
          documentSha256: sha,
          verifiedBytes: Buffer.byteLength(csv),
          detectedFormat: "CSV",
          state: "EXTRACTED",
          parserVersion: extraction.parserVersion,
          extractionJson: JSON.stringify(extraction),
          storageKey: null,
        },
      }));
    await setup.importSessionArtifact.update({
      where: { id: file.id },
      data: {
        artifactId: artifact.id,
        state: "ATTACHED",
        reservedBytes: 0,
        temporaryStorageKey: null,
        verifiedAt: api.clock.now(),
        uploadLeaseExpiresAt: null,
      },
    });
    return { session, file, artifact, revision: reserved.json.revision };
  }
  const analyze = (
    id: string,
    ref: string,
    revision: number,
    headers: Record<string, string> = UI_HEADERS,
  ) =>
    api.call("POST", `/import-sessions/${id}/attachments/${ref}/analyze`, {
      token,
      headers,
      body: { expectedRevision: revision },
    });

  function afterClaim(action: () => Promise<void>) {
    const original = writer.runImportSessionWrite;
    let handled = false;
    const spy = jest
      .spyOn(writer, "runImportSessionWrite")
      .mockImplementation(async function <T>(
        db: Pick<PrismaService, "$transaction">,
        clock: ImportSessionClock,
        auth: Readonly<Pick<AuthenticatedImportContext, "tenantId">>,
        work: (tx: Prisma.TransactionClient, now: Date) => Promise<T>,
        guard?: () => undefined,
      ): Promise<T> {
        const result = await original(db, clock, auth, work, guard);
        if (!handled) {
          handled = true;
          await action();
        }
        return result;
      });
    restoreWriter = () => {
      spy.mockRestore();
    };
    return spy;
  }

  it("reserve atomically adds pending and preserves human draft", async () => {
    const session = await seedSession(setup, world);
    const file = fileSeed({ fileName: "fatura.csv", mime: "text/csv" });
    const result = await reserve(api, token, session.id, [file]);
    expect(result.status).toBe(200);
    const row = await setup.importSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(JSON.parse(row.draftJson)).toEqual({
      ...JSON.parse(session.draftJson),
      scope: { observationIds: [], pendingAttachmentIds: [file.id] },
    });
    expect(result.json.attachments[0]).toEqual({
      id: file.id,
      fileName: file.fileName,
      declaredBytes: file.declaredBytes,
      state: "RESERVED",
      materializedInSession: false,
      canAnalyze: false,
    });
  });

  it("preserves twins, unknown originals and zero; publication selects each once", async () => {
    const f = await attached(
      "date,title,amount\n2026-06-22,LOJA PARC 2/3,100.00\n,SEM DATA,abc\n2026-06-22,LOJA PARC 2/3,100.00\n2026-06-22,ZERO,0.00\n",
    );
    const result = await analyze(f.session.id, f.file.id, f.revision);
    expect(result.status).toBe(200);
    expect(result.json.selectedLineIds).toEqual(
      result.json.lines.map((line: { id: string }) => line.id),
    );
    expect(result.json.lines).toHaveLength(4);
    expect(result.json.lines[0].amountCents).toBeNull();
    expect(
      result.json.lines.every(
        (line: { decision: { kind: string }; targets: unknown }) =>
          line.decision.kind === "UNRESOLVED" && line.targets === null,
      ),
    ).toBe(true);
    const rows = await setup.importObservation.findMany({
      where: { artifactId: f.artifact.id },
      orderBy: { reference: "asc" },
    });
    const originals = rows.map((row) =>
      parseStoredImportObservationEvidence(row.evidenceJson),
    );
    expect(originals.map((row) => row.amountCents)).toEqual([
      10000,
      null,
      10000,
      0,
    ]);
    expect(originals.map((row) => row.identity.ordinal)).toEqual([
      0,
      null,
      1,
      0,
    ]);
    expect(originals.every((row) => row.identity.externalId === null)).toBe(
      true,
    );
    expect(
      await setup.expense.count({ where: { tenantId: world.tenantId } }),
    ).toBe(0);
    expect(result.json.attachments[0]).toMatchObject({
      materializedInSession: true,
      canAnalyze: false,
    });
  });

  it.each(["empty", "normal"])(
    "%s completion survives GET and replay without renewed revision or retention",
    async (kind) => {
      const f = await attached(
        kind === "empty" ? "date,title,amount\n" : undefined,
      );
      const first = await analyze(f.session.id, f.file.id, f.revision);
      expect(first.status).toBe(200);
      const before = await setup.importSession.findUniqueOrThrow({
        where: { id: f.session.id },
      });
      const recovered = await api.call(
        "GET",
        `/import-sessions/${f.session.id}`,
        { token },
      );
      expect(recovered.json.attachments[0]).toMatchObject({
        materializedInSession: true,
        canAnalyze: false,
      });
      const replay = await analyze(f.session.id, f.file.id, f.revision);
      expect(replay.status).toBe(200);
      expect(replay.json.revision).toBe(first.json.revision);
      expect(
        await setup.importSession.findUniqueOrThrow({
          where: { id: f.session.id },
        }),
      ).toEqual(before);
      const reserveReplay = await reserve(api, token, f.session.id, [f.file]);
      expect(reserveReplay.status).toBe(200);
      expect(reserveReplay.json).toEqual(recovered.json);
      expect(replay.json).toEqual(recovered.json);
      expect(reserveReplay.json.attachments[0].materializedInSession).toBe(
        true,
      );
    },
  );

  it("RAW stays pending and unavailable; invalid UI authority never adopts", async () => {
    const f = await attached();
    const denied = await analyze(f.session.id, f.file.id, f.revision, {});
    expect(denied.status).toBe(403);
    await setup.importArtifact.update({
      where: { id: f.artifact.id },
      data: { state: "RAW_READY", extractionJson: null, parserVersion: null },
    });
    const read = await api.call("GET", `/import-sessions/${f.session.id}`, {
      token,
    });
    expect(read.json.attachments[0]).toMatchObject({
      materializedInSession: false,
      canAnalyze: false,
    });
    expect(read.json.actions).not.toContain("ANALYZE");
    const result = await analyze(f.session.id, f.file.id, f.revision);
    expect([result.status, result.json.code]).toEqual([
      503,
      "CAPABILITY_DISABLED",
    ]);
    expect(
      await setup.importObservation.count({
        where: { artifactId: f.artifact.id },
      }),
    ).toBe(0);
  });

  it.each([99, 100, 101])(
    "enforces %i editable lines without partial publication",
    async (count) => {
      const csv =
        "date,title,amount\n" +
        Array.from(
          { length: count },
          (_, i) => `2026-06-22,LOJA ${i},1.00\n`,
        ).join("");
      const f = await attached(csv);
      const before = await setup.importSession.findUniqueOrThrow({
        where: { id: f.session.id },
      });
      const result = await analyze(f.session.id, f.file.id, f.revision);
      if (count <= 100) {
        expect(result.status).toBe(200);
        expect(result.json.lines).toHaveLength(count);
        expect(result.json.selectedLineIds).toEqual(
          result.json.lines.slice(0, 10).map((line: { id: string }) => line.id),
        );
        expect(
          await setup.importObservation.count({
            where: { artifactId: f.artifact.id },
          }),
        ).toBe(count);
      } else {
        expect(result.json.code).toBe("LIMIT_EXCEEDED");
        expect(
          await setup.importObservation.count({
            where: { artifactId: f.artifact.id },
          }),
        ).toBe(0);
        expect(
          await setup.importSession.findUniqueOrThrow({
            where: { id: f.session.id },
          }),
        ).toEqual(before);
      }
      const artifact = await setup.importArtifact.findUniqueOrThrow({
        where: { id: f.artifact.id },
      });
      expect(artifact.leaseSessionId).toBeNull();
    },
  );

  it("successful completed replay preserves a human deselection", async () => {
    const f = await attached();
    const first = await analyze(f.session.id, f.file.id, f.revision);
    expect(first.status).toBe(200);
    expect(first.json.selectedLineIds).toHaveLength(1);
    const deselected = await api.call(
      "PATCH",
      `/import-sessions/${f.session.id}/draft`,
      {
        token,
        headers: UI_HEADERS,
        body: {
          expectedRevision: first.json.revision,
          questionId: null,
          replaceLines: [],
          selectedLineIds: [],
        },
      },
    );
    expect(deselected.status).toBe(200);
    expect(deselected.json.selectedLineIds).toEqual([]);

    const replay = await analyze(f.session.id, f.file.id, f.revision);
    expect(replay.status).toBe(200);
    expect(replay.json.revision).toBe(deselected.json.revision);
    expect(replay.json.selectedLineIds).toEqual([]);
  });

  it.each([
    "revision",
    "generation",
    "bytes",
    "sha",
    "format",
    "parser",
    "extraction",
    "lease",
    "sv",
    "cancel",
    "expiry",
    "transfer",
    "purge",
    "off",
  ] as const)(
    "%s drift after claim fences cached publication",
    async (change) => {
      const f = await attached();
      afterClaim(async () => {
        const owned = await setup.importArtifact.findUniqueOrThrow({
          where: { id: f.artifact.id },
        });
        expect(owned.leaseSessionId).toBe(f.session.id);
        if (change === "revision")
          await setup.importSession.update({
            where: { id: f.session.id },
            data: { revision: { increment: 1 } },
          });
        if (change === "generation")
          await setup.importArtifact.update({
            where: { id: f.artifact.id },
            data: { parseGeneration: { increment: 1 } },
          });
        if (change === "bytes")
          await setup.importArtifact.update({
            where: { id: f.artifact.id },
            data: { verifiedBytes: { increment: 1 } },
          });
        if (change === "sha")
          await setup.importArtifact.update({
            where: { id: f.artifact.id },
            data: { documentSha256: "f".repeat(64) },
          });
        if (change === "format")
          await setup.importArtifact.update({
            where: { id: f.artifact.id },
            data: { detectedFormat: "OFX" },
          });
        if (change === "parser")
          await setup.importArtifact.update({
            where: { id: f.artifact.id },
            data: { parserVersion: "changed" },
          });
        if (change === "extraction")
          await setup.importArtifact.update({
            where: { id: f.artifact.id },
            data: { extractionJson: "{}" },
          });
        if (change === "lease")
          api.clock.current = new Date(api.clock.now().getTime() + 90_000);
        if (change === "sv")
          await setup.user.update({
            where: { id: world.users.owner.id },
            data: { sessionVersion: { increment: 1 } },
          });
        if (change === "cancel") {
          const cancelled = await api.call(
            "POST",
            `/import-sessions/${f.session.id}/cancel`,
            {
              token,
              headers: UI_HEADERS,
              body: { expectedRevision: f.revision },
            },
          );
          expect(cancelled.status).toBe(200);
        }
        if (change === "expiry")
          await setup.importSession.update({
            where: { id: f.session.id },
            data: { expiresAt: api.clock.now() },
          });
        if (change === "transfer") {
          const target = await seedSession(setup, world);
          await setup.importSessionArtifact.update({
            where: { id: f.file.id },
            data: { sessionId: target.id },
          });
        }
        if (change === "purge")
          await setup.importArtifact.update({
            where: { id: f.artifact.id },
            data: { state: "PURGED", extractionJson: null },
          });
        if (change === "off")
          jest
            .spyOn(
              api.app.get<ImportSessionCapability>(IMPORT_SESSION_CAPABILITY),
              "writesEnabled",
            )
            .mockReturnValue(false);
      });
      const result = await analyze(f.session.id, f.file.id, f.revision);
      const code =
        change === "revision"
          ? "REVISION_CONFLICT"
          : change === "sv"
            ? "UNAUTHENTICATED"
            : change === "transfer"
              ? "NOT_FOUND"
              : change === "cancel"
                ? "STALE_PREVIEW"
                : change === "expiry"
                  ? "SESSION_EXPIRED"
                  : change === "off"
                    ? "CAPABILITY_DISABLED"
                    : "LEASE_CONFLICT";
      expect(result.json.code).toBe(code);
      expect(
        await setup.importObservation.count({
          where: { artifactId: f.artifact.id },
        }),
      ).toBe(0);
      if (change === "generation") {
        const artifact = await setup.importArtifact.findUniqueOrThrow({
          where: { id: f.artifact.id },
        });
        expect(artifact.leaseSessionId).toBe(f.session.id);
        expect(artifact.parseGeneration).toBe(f.artifact.parseGeneration + 2);
      }
    },
  );

  it("an aborted caller cannot publish and only its lease is released", async () => {
    const f = await attached();
    const abort = new AbortController();
    const auth = authFor(world.users.owner);
    const grant = mintGrant(api.app.get(ImportUiGrantIssuer), auth, {
      operation: "ANALYZE_ATTACHMENT",
      sessionId: f.session.id,
      attachmentId: f.file.id,
      expectedRevision: f.revision,
    });
    afterClaim(async () => {
      abort.abort();
    });
    await expect(
      api.app
        .get(ImportSessionExtractionService)
        .analyzeAttached(
          auth,
          f.session.id,
          f.file.id,
          { expectedRevision: f.revision },
          grant,
          abort.signal,
        ),
    ).rejects.toMatchObject({ code: "LEASE_CONFLICT" });
    expect(
      await setup.importObservation.count({
        where: { artifactId: f.artifact.id },
      }),
    ).toBe(0);
    expect(
      (
        await setup.importArtifact.findUniqueOrThrow({
          where: { id: f.artifact.id },
        })
      ).leaseSessionId,
    ).toBeNull();
  });

  it("GET is metadata/evidence-only and OFF preserves completion without eligibility", async () => {
    const f = await attached();
    const db = api.app.get(PrismaService);
    const calls: string[] = [];
    let capture = false;
    db.$use(async (params, next) => {
      if (capture) calls.push(`${params.model}.${params.action}`);
      return next(params);
    });
    capture = true;
    const pending = await api.call("GET", `/import-sessions/${f.session.id}`, {
      token,
    });
    capture = false;
    expect(pending.json.attachments[0]).toMatchObject({
      materializedInSession: false,
      canAnalyze: true,
    });
    expect(pending.json.actions).toContain("ANALYZE");
    expect(
      calls.filter((call) =>
        /^(Expense|CashFlowEntry|Receipt|RateioAllocation)\./.test(call),
      ),
    ).toEqual([]);
    expect(
      calls.every((call) => /\.(findFirst|findUnique|findMany)$/.test(call)),
    ).toBe(true);
    expect((await analyze(f.session.id, f.file.id, f.revision)).status).toBe(
      200,
    );
    jest
      .spyOn(
        api.app.get<ImportSessionCapability>(IMPORT_SESSION_CAPABILITY),
        "writesEnabled",
      )
      .mockReturnValue(false);
    const recovered = await api.call(
      "GET",
      `/import-sessions/${f.session.id}`,
      { token },
    );
    expect(recovered.json.attachments[0]).toMatchObject({
      materializedInSession: true,
      canAnalyze: false,
    });
    expect(recovered.json.actions).not.toContain("ANALYZE");
    expect(
      (await analyze(f.session.id, f.file.id, recovered.json.revision)).json
        .code,
    ).toBe("CAPABILITY_DISABLED");
  });

  it("two overlapping adopters publish once; the active lease is not stolen", async () => {
    const f = await attached();
    let competing: Awaited<ReturnType<typeof analyze>> | undefined;
    afterClaim(async () => {
      competing = await analyze(f.session.id, f.file.id, f.revision);
    });

    const result = await analyze(f.session.id, f.file.id, f.revision);
    expect([competing?.status, competing?.json]).toEqual([
      409,
      {
        code: "LEASE_CONFLICT",
        retryable: false,
        sessionId: null,
        currentRevision: null,
        reason: null,
      },
    ]);
    expect(result.status).toBe(200);
    expect(result.json.revision).toBe(f.revision + 1);
    expect(
      await setup.importObservation.count({
        where: { artifactId: f.artifact.id },
      }),
    ).toBe(1);
  });

  it("human edits and deselection never erase original blockers; selected blockers suppress PREPARE", async () => {
    const f = await attached("date,title,amount\n,SEM DATA,abc\n");
    const adopted = await analyze(f.session.id, f.file.id, f.revision);
    expect(adopted.status).toBe(200);
    const line = adopted.json.lines[0];
    const edited = await api.call(
      "PATCH",
      `/import-sessions/${f.session.id}/draft`,
      {
        token,
        headers: UI_HEADERS,
        body: {
          expectedRevision: adopted.json.revision,
          questionId: null,
          replaceLines: [
            {
              ...line,
              titulo: "Informado",
              fornecedor: "Informado",
              tipoDespesa: "OUTROS",
              amountMeaning: "TOTAL_PURCHASE",
              amountCents: 30000,
              installmentCount: 3,
              dataCompra: "2026-06-22",
              firstDueDate: "2026-11-05",
              targets: [],
              decision: { kind: "CREATE", acceptNaturalDuplicate: false },
            },
          ],
          selectedLineIds: [line.id],
        },
      },
    );
    expect(edited.status).toBe(200);
    const blockers = [
      {
        lineId: line.id,
        code: "ORIGINAL_IDENTITY_INCOMPLETE",
        resolution: "NEEDS_DECLARATION",
      },
      {
        lineId: line.id,
        code: "ORIGINAL_OCCURRENCE_INCOMPLETE",
        resolution: "NEEDS_DECLARATION",
      },
    ];
    expect(edited.json.reviewBlockers).toEqual(blockers);
    expect(edited.json.actions).not.toContain("PREPARE");
    const recovered = await api.call(
      "GET",
      `/import-sessions/${f.session.id}`,
      { token },
    );
    expect(recovered.json.reviewBlockers).toEqual(blockers);
    const deselected = await api.call(
      "PATCH",
      `/import-sessions/${f.session.id}/draft`,
      {
        token,
        headers: UI_HEADERS,
        body: {
          expectedRevision: edited.json.revision,
          questionId: null,
          replaceLines: [],
          selectedLineIds: [],
        },
      },
    );
    expect(deselected.status).toBe(200);
    expect(deselected.json.reviewBlockers).toEqual(blockers);
  });

  it.each(["evidence", "claimVersion"])(
    "%s drift on shared cached evidence prevents a second-session publication",
    async (change) => {
      const first = await attached();
      expect(
        (await analyze(first.session.id, first.file.id, first.revision)).status,
      ).toBe(200);
      const second = await attached();
      expect(second.artifact.id).toBe(first.artifact.id);
      const original = await setup.importObservation.findFirstOrThrow({
        where: { artifactId: first.artifact.id },
      });
      afterClaim(async () => {
        await setup.importObservation.update({
          where: { id: original.id },
          data:
            change === "evidence"
              ? {
                  evidenceJson: original.evidenceJson.replace(
                    '"amountCents":10000',
                    '"amountCents":10001',
                  ),
                }
              : { claimVersion: { increment: 1 } },
        });
      });
      const result = await analyze(
        second.session.id,
        second.file.id,
        second.revision,
      );
      expect(result.json.code).toBe("STALE_PREVIEW");
      const row = await setup.importSession.findUniqueOrThrow({
        where: { id: second.session.id },
      });
      expect(JSON.parse(row.draftJson).scope.pendingAttachmentIds).toEqual([
        second.file.id,
      ]);
      expect(JSON.parse(row.draftJson).lines).toEqual([]);
    },
  );

  it("lease expiration during publication rolls back inserted observations and the draft together", async () => {
    const f = await attached();
    const before = await setup.importSession.findUniqueOrThrow({
      where: { id: f.session.id },
    });
    let expire = true;
    api.app.get(PrismaService).$use(async (params, next) => {
      const result = await next(params);
      if (
        expire &&
        params.model === "ImportObservation" &&
        params.action === "create"
      ) {
        expire = false;
        api.clock.current = new Date(api.clock.now().getTime() + 90_000);
      }
      return result;
    });
    expect((await analyze(f.session.id, f.file.id, f.revision)).json.code).toBe(
      "LEASE_CONFLICT",
    );
    expect(
      await setup.importObservation.count({
        where: { artifactId: f.artifact.id },
      }),
    ).toBe(0);
    expect(
      await setup.importSession.findUniqueOrThrow({
        where: { id: f.session.id },
      }),
    ).toEqual(before);
  });

  it("an admission retry consumes its UI grant once and rechecks the real writer", async () => {
    const f = await attached();
    const verify = jest.spyOn(
      api.app.get<UiImportPersistenceGrantVerifier>(
        IMPORT_SESSION_GRANT_VERIFIER,
      ),
      "verify",
    );
    let fail = true;
    api.app.get(PrismaService).$use(async (params, next) => {
      if (
        fail &&
        params.model === "ImportArtifact" &&
        params.action === "updateMany"
      ) {
        fail = false;
        throw new Error("SQLITE_BUSY synthetic admission retry");
      }
      return next(params);
    });
    try {
      const result = await analyze(f.session.id, f.file.id, f.revision);
      expect(result.status).toBe(200);
      expect(verify).toHaveBeenCalledTimes(1);
      expect(
        await setup.importObservation.count({
          where: { artifactId: f.artifact.id },
        }),
      ).toBe(1);
    } finally {
      verify.mockRestore();
    }
  });
});
