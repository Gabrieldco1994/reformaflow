require("../../../../../scripts/test-db-env.cjs");

import { Logger } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
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
const notFound = {
  code: "NOT_FOUND",
  retryable: false,
  sessionId: null,
  currentRevision: null,
  reason: null,
};
const internal = { statusCode: 500, message: "Internal server error" };
let world: ImportWorld;
let api: RecoveryApp;

describe("SEC-B1a-1 independent contract probes", () => {
  beforeAll(async () => {
    await setup.$connect();
    const seedPragma = await setup.$queryRaw<
      Array<{ foreign_keys: bigint }>
    >`PRAGMA foreign_keys`;
    expect(Number(seedPragma[0]!.foreign_keys)).toBe(1);
    world = await seedImportWorld(setup, "imp-sec-b1a1-independent");
    api = await bootRecoveryApp(setup);
    const runtime = api.app.get(PrismaService);
    expect(runtime).toBeInstanceOf(PrismaService);
    const runtimePragma = await runtime.$queryRaw<
      Array<{ foreign_keys: bigint }>
    >`PRAGMA foreign_keys`;
    expect(Number(runtimePragma[0]!.foreign_keys)).toBe(1);
  });

  afterAll(async () => {
    await api.close();
    await setup.$disconnect();
  });

  beforeEach(() => {
    api.clock.current = FIXED_NOW;
  });

  it.each(["draft", "proposal"] as const)(
    "%s: a readable hidden participant remains opaque at 1 MiB + 1 byte",
    async (field) => {
      const seeded = await seedSession(setup, world, {
        ownerUserId: world.users.restricted.id,
      });
      const draft = validationDraft(world.projects.pessoal);
      const proposal = validationProposal(seeded.id, world.projects.pessoal);
      if (field === "draft") {
        draft.lines[0]!.targets![0]!.projectId = world.projects.casa;
      } else {
        const create = proposal.lines[0]!;
        if (create.kind !== "CREATE") throw new Error("fixture must CREATE");
        create.targets[0]!.projectId = world.projects.casa;
      }
      const document = {
        ...(field === "draft" ? draft : proposal),
        evidence: "",
      };
      const baseBytes = Buffer.byteLength(JSON.stringify(document), "utf8");
      const atLimit = JSON.stringify({
        ...document,
        evidence: "x".repeat(1048576 - baseBytes),
      });
      const overLimit = JSON.stringify({
        ...document,
        evidence: "x".repeat(1048577 - baseBytes),
      });
      expect(Buffer.byteLength(atLimit, "utf8")).toBe(1048576);
      expect(Buffer.byteLength(overLimit, "utf8")).toBe(1048577);
      expect(JSON.parse(overLimit).lines[0].targets[0].projectId).toBe(
        world.projects.casa,
      );
      const token = await api.tokenFor(world.users.restricted);
      const missing = await api.call("GET", "/import-sessions/missing", {
        token,
      });
      expect([missing.status, missing.json]).toEqual([404, notFound]);
      const replies: Array<[number, string, number, string]> = [];
      const logs: unknown[][] = [];
      const spy = jest
        .spyOn(Logger.prototype, "error")
        .mockImplementation((...args: unknown[]) => {
          logs.push(args);
        });
      try {
        for (const raw of [atLimit, overLimit]) {
          await setup.importSession.update({
            where: { id: seeded.id },
            data: {
              draftJson: field === "draft" ? raw : JSON.stringify(draft),
              proposalJson:
                field === "proposal" ? raw : JSON.stringify(proposal),
              proposalHash: "c".repeat(64),
            },
          });
          for (const suffix of ["", "/result"]) {
            const reply = await api.call(
              "GET",
              `/import-sessions/${seeded.id}${suffix}`,
              { token },
            );
            replies.push([
              Buffer.byteLength(raw, "utf8"),
              suffix,
              reply.status,
              reply.text,
            ]);
          }
        }
      } finally {
        spy.mockRestore();
      }
      expect({ replies, logs }).toEqual({
        replies: [
          [1048576, "", 404, missing.text],
          [1048576, "/result", 404, missing.text],
          [1048577, "", 404, missing.text],
          [1048577, "/result", 404, missing.text],
        ],
        logs: [],
      });
    },
  );

  it("AC18: deferred retainUntil must equal the inherited deadline, not one millisecond later", async () => {
    const seeded = await seedSession(setup, world);
    const row = await setup.importSession.findUniqueOrThrow({
      where: { id: seeded.id },
    });
    expect(row.expiresAt.toISOString()).toBe("2026-10-05T15:00:00.000Z");
    const draft = validationDraft(world.projects.pessoal);
    const proposal = validationProposal(seeded.id, world.projects.pessoal);
    const token = await api.tokenFor(world.users.owner);
    await setup.importSession.update({
      where: { id: seeded.id },
      data: {
        draftJson: JSON.stringify(draft),
        proposalJson: JSON.stringify(proposal),
        proposalHash: "c".repeat(64),
      },
    });
    const valid = await api.call("GET", `/import-sessions/${seeded.id}`, {
      token,
    });
    expect([valid.status, valid.json.proposal.retainUntil]).toEqual([
      200,
      "2026-10-05T15:00:00.000Z",
    ]);
    proposal.retainUntil = "2026-10-05T15:00:00.001Z";
    await setup.importSession.update({
      where: { id: seeded.id },
      data: { proposalJson: JSON.stringify(proposal) },
    });
    const logs: unknown[][] = [];
    const spy = jest
      .spyOn(Logger.prototype, "error")
      .mockImplementation((...args: unknown[]) => {
        logs.push(args);
      });
    try {
      const replies = [];
      for (const suffix of ["", "/result"]) {
        const reply = await api.call(
          "GET",
          `/import-sessions/${seeded.id}${suffix}`,
          { token },
        );
        replies.push({ suffix, status: reply.status, body: reply.json });
      }
      expect(replies).toEqual([
        { suffix: "", status: 500, body: internal },
        { suffix: "/result", status: 500, body: internal },
      ]);
      expect(logs).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });
});
