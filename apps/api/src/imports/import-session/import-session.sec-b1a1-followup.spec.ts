require("../../../../../scripts/test-db-env.cjs");

import { Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { ImportSessionCorruptStateError } from "./import-session.errors";
import { parseProposal, parseStoredDraft } from "./import-session.projection";
import { PrismaService } from "../../prisma/prisma.service";
import { validateDocumentExtraction } from "../../credit-card/parsers/statement-document";
import { buildImportMaterialization } from "./import-session.extraction";
import {
  connectVaultTestDatabase,
  seedRef,
} from "../../test-utils/import-session-vault-harness";
import {
  cleanupImportWorld,
  FIXED_NOW,
  seedImportWorld,
  seedSession,
  type ImportWorld,
} from "../../test-utils/import-session-harness";
import {
  bootRecoveryApp,
  type RecoveryApp,
} from "../../test-utils/import-session-recovery-harness";
import {
  validationDraft,
  validationProposal,
} from "../../test-utils/import-session-validation-fixtures";

const setup = new PrismaClient();
const prefix = "imp-sec-b1a1-followup";
const internal = { statusCode: 500, message: "Internal server error" };
let world: ImportWorld;
let api: RecoveryApp;

describe("cycle contract: proposal reader", () => {
  it("preserves resolved CREATE, unknown KEEP and deferred draft facts without defaults", () => {
    const proposal = validationProposal("cycle-session", "cycle-project");
    expect(
      parseProposal(
        JSON.stringify(proposal),
        proposal.sessionId,
        proposal.proposalHash,
      ),
    ).toEqual(proposal);
    expect(
      proposal.lines[0]!.schedule.occurrences.map(
        (item) => item.invoiceDueMonth,
      ),
    ).toEqual(["2026-10", "2026-11"]);
    expect(
      proposal.lines[1]!.schedule.occurrences[1]!.invoiceDueMonth,
    ).toBeNull();
    const draft = validationDraft("cycle-project");
    expect(parseStoredDraft(JSON.stringify(draft))).toEqual(draft);
    expect(draft.lines[2]).toMatchObject({
      amountMeaning: "UNKNOWN",
      amountCents: null,
      firstDueDate: null,
      decision: { kind: "UNRESOLVED" },
    });
  });

  it.each(["source", "target", "contradictory-source"] as const)(
    "rejects unknown CREATE %s cycles instead of projecting a partial invoice",
    (where) => {
      const proposal = validationProposal("cycle-session", "cycle-project");
      const line = proposal.lines[0]!;
      if (line.kind !== "CREATE") throw new Error("fixture must CREATE");
      line.schedule = structuredClone(line.schedule);
      line.targets[0]!.schedule = structuredClone(line.targets[0]!.schedule);
      const schedule =
        where === "target" ? line.targets[0]!.schedule : line.schedule;
      schedule.occurrences[1]!.invoiceDueMonth = null;
      if (where === "contradictory-source")
        proposal.invoiceDeltas = [
          { invoiceDueMonth: "2026-10", amountCents: 999 },
        ];
      const before = JSON.stringify(proposal);
      expect(() =>
        parseProposal(before, proposal.sessionId, proposal.proposalHash),
      ).toThrow(new ImportSessionCorruptStateError("proposal"));
      expect(JSON.stringify(proposal)).toBe(before);
    },
  );
});

function draftAtBytes(projectId: string, bytes: number): string {
  const draft = validationDraft(projectId);
  draft.questions = [];
  const question = (index: number, text: string) => ({
    id: `padding-${String(index).padStart(4, "0")}`,
    lineIds: ["line-unknown"],
    field: "amountCents" as const,
    text,
  });
  const entryBytes =
    Buffer.byteLength(JSON.stringify(question(0, "x".repeat(500)))) + 1;
  const count = Math.floor(
    (bytes - Buffer.byteLength(JSON.stringify(draft)) + 1) / entryBytes,
  );
  draft.questions = Array.from({ length: count }, (_, index) =>
    question(index, "x".repeat(500)),
  );
  let remaining = bytes - Buffer.byteLength(JSON.stringify(draft));
  const minimum = Buffer.byteLength(JSON.stringify(question(count, "x"))) + 1;
  if (remaining < minimum) {
    draft.questions[count - 1]!.text = "x".repeat(500 - (minimum - remaining));
    remaining = minimum;
  }
  draft.questions.push(question(count, "x".repeat(remaining - minimum + 1)));
  return JSON.stringify(draft);
}

async function withLogs<T>(
  run: () => Promise<T>,
): Promise<{ value: T; logs: unknown[][] }> {
  const logs: unknown[][] = [];
  const spy = jest
    .spyOn(Logger.prototype, "error")
    .mockImplementation((...args: unknown[]) => {
      logs.push(args);
    });
  try {
    return { value: await run(), logs };
  } finally {
    spy.mockRestore();
  }
}

async function seedProjectionMaterial(
  row: Awaited<ReturnType<typeof seedSession>>,
  draft: ReturnType<typeof validationDraft>,
) {
  const bytes = Buffer.from(
    `Synthetic structural projection fixture ${row.id}`,
  );
  const newIds = new Map([
    [
      "csv:record:2",
      { observationId: "observation-create", lineId: "line-create" },
    ],
    [
      "csv:record:3",
      { observationId: "observation-keep", lineId: "line-keep" },
    ],
    [
      "csv:record:4",
      { observationId: "observation-unknown", lineId: "line-unknown" },
    ],
  ]);
  const extraction = validateDocumentExtraction({
    version: 1,
    parserVersion: "card-local-text-v1",
    documentKind: "UNKNOWN",
    invoiceDueMonth: null,
    metrics: {
      pages: 0,
      rows: draft.lines.length,
      expandedBytes: 0,
      archiveEntries: 0,
      imagePixels: 0,
      frames: 0,
    },
    occurrences: [
      {
        reference: "csv:record:2",
        amountCents: 101,
        amountMeaning: "TOTAL_PURCHASE",
        installmentCount: 2,
        dateOnly: "2026-09-28",
      },
      {
        reference: "csv:record:3",
        amountCents: 50,
        amountMeaning: "INSTALLMENT_CHARGE",
        installmentCount: null,
        dateOnly: null,
      },
      {
        reference: "csv:record:4",
        amountCents: null,
        amountMeaning: "UNKNOWN",
        installmentCount: null,
        dateOnly: null,
      },
    ]
      .filter((facts) =>
        draft.scope.observationIds.includes(
          newIds.get(facts.reference)!.observationId,
        ),
      )
      .map((facts, sourceOrdinal) => ({
        ...facts,
        sourceOrdinal,
        section: "UNKNOWN",
        raw: { date: null, description: null, amount: null, installment: null },
        cycle: null,
        merchant: null,
        installmentIndex: null,
        fitId: null,
        identityOrdinal: null,
      })),
    diagnostics: [],
  });
  const artifact = await setup.importArtifact.create({
    data: {
      tenantId: world.tenantId,
      ownerProjectId: world.projects.pessoal,
      documentSha256: createHash("sha256").update(bytes).digest("hex"),
      verifiedBytes: bytes.length,
      detectedFormat: "CSV",
      state: "EXTRACTED",
      parserVersion: extraction.parserVersion,
      extractionJson: JSON.stringify(extraction),
    },
  });
  const attachment = await setup.importSessionArtifact.create({
    data: {
      tenantId: world.tenantId,
      ownerProjectId: world.projects.pessoal,
      sessionId: row.id,
      artifactId: artifact.id,
      position: 0,
      state: "ATTACHED",
      fileName: "synthetic.csv",
      declaredMime: "text/csv",
      declaredBytes: bytes.length,
      reservedBytes: 0,
      verifiedAt: FIXED_NOW,
    },
  });
  const plan = buildImportMaterialization({
    session: row,
    attachment,
    artifact,
    extraction,
    draft: {
      version: 1,
      lines: [],
      selectedLineIds: [],
      questions: [],
      scope: { observationIds: [], pendingAttachmentIds: [attachment.id] },
    },
    observations: [],
    newIds,
  });
  await setup.importObservation.deleteMany({
    where: { tenantId: world.tenantId, id: { in: draft.scope.observationIds } },
  });
  await setup.importObservation.createMany({ data: plan.observations });
  for (const id of draft.scope.pendingAttachmentIds) {
    await setup.importSessionArtifact.deleteMany({
      where: { tenantId: world.tenantId, id },
    });
    await seedRef(setup, row, world.users.owner, { id, position: 1 });
  }
}

describe("SEC-B1a-1 F1/F2 complementary controls", () => {
  beforeAll(async () => {
    await connectVaultTestDatabase(setup);
    world = await seedImportWorld(setup, prefix);
    api = await bootRecoveryApp(setup, {
      beforeListen: async (app) => {
        await app.init();
        await connectVaultTestDatabase(app.get(PrismaService));
      },
    });
  });
  afterAll(async () => {
    await api.close();
    await cleanupImportWorld(setup, prefix);
    await setup.$disconnect();
  });

  it.each(["draft", "proposal"] as const)(
    "%s: otherwise valid authorised JSON accepts exactly 1 MiB and rejects one byte more",
    async (field) => {
      const seeded = await seedSession(setup, world);
      const draft = validationDraft(world.projects.pessoal);
      const proposal = validationProposal(seeded.id, world.projects.pessoal);
      await seedProjectionMaterial(seeded, draft);
      const token = await api.tokenFor(world.users.owner);
      for (const bytes of [1048576, 1048577]) {
        let raw: string;
        if (field === "draft") {
          raw = draftAtBytes(world.projects.pessoal, bytes);
        } else {
          const line = proposal.lines[0]!;
          line.schedule = {
            ...line.schedule,
            occurrences: line.schedule.occurrences.map((item) => ({ ...item })),
          };
          line.schedule.occurrences[0]!.parcela = "";
          line.schedule.occurrences[0]!.parcela = "x".repeat(
            bytes - Buffer.byteLength(JSON.stringify(proposal)),
          );
          raw = JSON.stringify(proposal);
        }
        expect(Buffer.byteLength(raw, "utf8")).toBe(bytes);
        await setup.importSession.update({
          where: { id: seeded.id },
          data: {
            draftJson: field === "draft" ? raw : JSON.stringify(draft),
            proposalJson: field === "proposal" ? raw : JSON.stringify(proposal),
            proposalHash: "c".repeat(64),
          },
        });
        const before = await setup.importSession.findUniqueOrThrow({
          where: { id: seeded.id },
        });
        const { value, logs } = await withLogs(async () => {
          const replies = [];
          for (const suffix of ["", "/result"]) {
            replies.push(
              await api.call("GET", `/import-sessions/${seeded.id}${suffix}`, {
                token,
              }),
            );
          }
          return replies;
        });
        expect(value.map((reply) => reply.status)).toEqual(
          bytes === 1048576 ? [200, 200] : [500, 500],
        );
        if (bytes === 1048577) {
          expect(value.map((reply) => reply.text)).toEqual([
            JSON.stringify(internal),
            JSON.stringify(internal),
          ]);
          expect(logs).toHaveLength(2);
          expect(JSON.stringify(logs)).not.toContain("xxxxxxxx");
        } else {
          expect(logs).toEqual([]);
        }
        expect(
          await setup.importSession.findUniqueOrThrow({
            where: { id: seeded.id },
          }),
        ).toEqual(before);
      }
    },
  );

  it.each(["observations", "attachments", "none"] as const)(
    "AC18: %s deferred uses only the inherited deadline, +/-1ms is corruption after ACL",
    async (deferred) => {
      const expiresAt = new Date(FIXED_NOW.getTime() + 123456);
      const seeded = await seedSession(setup, world, {
        ownerUserId: world.users.restricted.id,
        expiresAt,
      });
      const draft = validationDraft(world.projects.pessoal);
      const proposal = validationProposal(seeded.id, world.projects.pessoal);
      if (deferred !== "observations") {
        draft.lines = draft.lines.slice(0, 2);
        draft.questions = [];
        draft.scope.observationIds = ["observation-create", "observation-keep"];
        proposal.deferredObservationIds = [];
      }
      if (deferred !== "attachments") {
        draft.scope.pendingAttachmentIds = [];
        proposal.deferredAttachmentIds = [];
      }
      await seedProjectionMaterial(seeded, draft);
      const token = await api.tokenFor(world.users.restricted);
      const missing = await api.call("GET", "/import-sessions/missing", {
        token,
      });
      const persist = async () => {
        await setup.importSession.update({
          where: { id: seeded.id },
          data: {
            draftJson: JSON.stringify(draft),
            proposalJson: JSON.stringify(proposal),
            proposalHash: "c".repeat(64),
          },
        });
        return setup.importSession.findUniqueOrThrow({
          where: { id: seeded.id },
        });
      };
      proposal.retainUntil =
        deferred === "none" ? null : expiresAt.toISOString();
      const validBefore = await persist();
      const valid = await api.call("GET", `/import-sessions/${seeded.id}`, {
        token,
      });
      expect([valid.status, valid.json.proposal.retainUntil]).toEqual([
        200,
        proposal.retainUntil,
      ]);
      expect(valid.json.proposal.lines).toEqual(proposal.lines);
      expect(
        await setup.importSession.findUniqueOrThrow({
          where: { id: seeded.id },
        }),
      ).toEqual(validBefore);
      if (deferred === "none") return;
      for (const shift of [-1, 1]) {
        proposal.retainUntil = new Date(
          expiresAt.getTime() + shift,
        ).toISOString();
        for (const hidden of [false, true]) {
          draft.lines[0]!.targets![0]!.projectId = hidden
            ? world.projects.casa
            : world.projects.pessoal;
          const before = await persist();
          const { value, logs } = await withLogs(async () => {
            const replies = [];
            for (const suffix of ["", "/result"]) {
              replies.push(
                await api.call(
                  "GET",
                  `/import-sessions/${seeded.id}${suffix}`,
                  { token },
                ),
              );
            }
            return replies;
          });
          expect(value.map((reply) => [reply.status, reply.text])).toEqual(
            Array.from({ length: 2 }, () =>
              hidden ? [404, missing.text] : [500, JSON.stringify(internal)],
            ),
          );
          expect(logs).toHaveLength(hidden ? 0 : 2);
          expect(
            await setup.importSession.findUniqueOrThrow({
              where: { id: seeded.id },
            }),
          ).toEqual(before);
        }
      }
    },
  );
});
