// The database guard must run before PrismaClient is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../../scripts/test-db-env.cjs");

import { createHash, randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import type { ImportSessionViewV1 } from "@reformaflow/domain";
import { assertCardAccess, reauthorize } from "./import-session.auth";
import { parseStoredDraft, projectSession } from "./import-session.projection";
import { ImportSessionCorruptStateError } from "./import-session.errors";
import { PrismaService } from "../../prisma/prisma.service";
import { validateDocumentExtraction } from "../../credit-card/parsers/statement-document";
import { buildImportMaterialization } from "./import-session.extraction";
import { connectVaultTestDatabase } from "../../test-utils/import-session-vault-harness";
import {
  validationDraft,
  validationProposal,
} from "../../test-utils/import-session-validation-fixtures";
import {
  authFor,
  cleanupImportWorld,
  FIXED_NOW,
  seedImportWorld,
  seedSession,
  type ImportWorld,
} from "../../test-utils/import-session-harness";
import {
  addSoftDeletedAnchor,
  sessionRow,
  bootRecoveryApp,
  receiptV1,
  seedApplied,
  SNAPSHOT_SCHEDULE,
  UI_HEADERS,
  type RecoveryApp,
} from "../../test-utils/import-session-recovery-harness";

/**
 * B1b RED — immutable receipt v1: `Receipt.snapshot` is mandatory, strictly parsed, and the
 * receipt is authorised ONLY by the (current) participant projects, never by re-reading
 * Expense/CFE. Real PrismaService/JwtStrategy/guards. The "legacy IDs-only" shape has no
 * fallback: a real legacy receipt must be re-evaluated with evidence, not answered as success.
 */
const PREFIX = "imp-b1b-rcpt";
const setup = new PrismaClient();
let world: ImportWorld;
let api: RecoveryApp;
jest.setTimeout(120_000);

const notFound = {
  code: "NOT_FOUND",
  retryable: false,
  sessionId: null,
  currentRevision: null,
  reason: null,
};
const internal = { statusCode: 500, message: "Internal server error" };

async function silenced<T>(
  run: () => Promise<T>,
): Promise<{ value: T; logged: string }> {
  const lines: string[] = [];
  const spies = (["error", "warn", "log", "debug", "verbose"] as const).map(
    (level) =>
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => {
          lines.push(
            args
              .map((a) =>
                a instanceof Error
                  ? `${a.name} ${a.message} ${a.stack}`
                  : String(a),
              )
              .join(" "),
          );
        }),
  );
  try {
    return { value: await run(), logged: lines.join("\n") };
  } finally {
    spies.forEach((spy) => spy.mockRestore());
  }
}

describe("B1b RED — receipt snapshot v1", () => {
  beforeAll(async () => {
    await connectVaultTestDatabase(setup);
    world = await seedImportWorld(setup, PREFIX);
    api = await bootRecoveryApp(setup, {
      beforeListen: async (app) => {
        await app.init();
        await connectVaultTestDatabase(app.get(PrismaService));
      },
    });
  });
  afterAll(async () => {
    await api.close();
    await cleanupImportWorld(setup, PREFIX);
    await setup.$disconnect();
  });
  beforeEach(async () => {
    api.clock.current = FIXED_NOW;
    await setup.importSessionArtifact.deleteMany({
      where: { tenantId: world.tenantId },
    });
    await setup.importSession.deleteMany({
      where: { tenantId: world.tenantId },
    });
    await setup.user.updateMany({
      where: { id: { in: [world.users.restricted.id] } },
      data: {
        allowedModules: JSON.stringify(["creditCards", "expenses"]),
        allowedProjects: JSON.stringify([world.projects.pessoal]),
      },
    });
  });

  const owner = () => world.users.owner;
  const get = async (id: string, suffix = "", who = owner()) =>
    api.call("GET", `/import-sessions/${id}${suffix}`, {
      token: await api.tokenFor(who),
    });

  describe("valid v1 receipt", () => {
    it("is returned by GET session and GET result exactly as stored, snapshot included", async () => {
      const applied = await seedApplied(setup, world, {
        owner: owner(),
        participants: [
          {
            sourceProjectId: world.projects.pessoal,
            targets: [{ projectId: world.projects.casa, amountCents: 4000 }],
          },
          {
            lineId: "line-2",
            outcome: "KEPT_EXISTING",
            sourceProjectId: world.projects.pessoal,
          },
        ],
      });
      const session = await get(applied.id);
      const result = await get(applied.id, "/result");
      expect([session.status, result.status]).toEqual([200, 200]);
      expect(session.json.receipt).toEqual(JSON.parse(applied.receipt));
      expect(result.json).toEqual({
        state: "APPLIED",
        receipt: JSON.parse(applied.receipt),
      });
      expect(session.json.receipt.snapshot.participantProjectIds).toEqual(
        [world.projects.casa, world.projects.pessoal].sort(),
      );
    });

    it("returns bounded signed cents exactly for audit-only items while financial totals stay non-negative", async () => {
      const amounts = [null, -45_002, 0, 45_002];
      const applied = await seedApplied(setup, world, {
        owner: owner(),
        mutate: (receipt) => {
          receipt.auditItems = amounts.map((amountCents, index) => ({
            lineId: `audit-${index}`,
            outcome: "IGNORED",
            reason: "INVOICE_PAYMENT",
            title: `Pagamento ${index}`,
            amountCents,
          }));
        },
      });
      const session = await get(applied.id);
      const result = await get(applied.id, "/result");
      expect([session.status, result.status]).toEqual([200, 200]);
      for (const receipt of [session.json.receipt, result.json.receipt]) {
        expect(
          receipt.auditItems.map(
            (item: { amountCents: number | null }) => item.amountCents,
          ),
        ).toEqual(amounts);
        expect(
          receipt.snapshot.createdEconomicTotalCents,
        ).toBeGreaterThanOrEqual(0);
        expect(
          receipt.snapshot.lines.every(
            (line: { totalCents: number }) => line.totalCents >= 0,
          ),
        ).toBe(true);
        expect(
          receipt.snapshot.invoiceDeltas.every(
            (delta: { amountCents: number }) => delta.amountCents >= 0,
          ),
        ).toBe(true);
      }
    });

    it.each([-2_147_483_648, 2_147_483_648, 0.5, "-45002"])(
      "rejects out-of-domain audit-only cents %p with a sanitized 500",
      async (amountCents) => {
        const applied = await seedApplied(setup, world, {
          owner: owner(),
          mutate: (receipt) => {
            receipt.auditItems = [
              {
                lineId: "audit-invalid",
                outcome: "IGNORED",
                reason: "INVOICE_PAYMENT",
                title: "Pagamento",
                amountCents,
              },
            ];
          },
        });
        const { value } = await silenced(async () => [
          await get(applied.id),
          await get(applied.id, "/result"),
        ]);
        for (const reply of value) {
          expect([reply.status, reply.text]).toEqual([
            500,
            JSON.stringify(internal),
          ]);
        }
      },
    );

    it("does not change nor depend on Expense/CFE: ids that no longer exist (or never did) still read 200 when the participant projects are authorised", async () => {
      const applied = await seedApplied(setup, world, {
        owner: world.users.restricted,
        participants: [{ sourceProjectId: world.projects.pessoal }],
      });
      // exp-line-1 never existed as an Expense row: the B1a expense-based access check would answer 404.
      const session = await get(applied.id, "", world.users.restricted);
      expect(session.status).toBe(200);
      expect(session.json.receipt).toEqual(JSON.parse(applied.receipt));
      const before = JSON.stringify(
        (
          await setup.importSession.findUniqueOrThrow({
            where: { id: applied.id },
          })
        ).receiptJson,
      );
      await setup.expense.deleteMany({ where: { tenantId: world.tenantId } });
      expect(
        (await get(applied.id, "/result", world.users.restricted)).status,
      ).toBe(200);
      expect(
        JSON.stringify(
          (
            await setup.importSession.findUniqueOrThrow({
              where: { id: applied.id },
            })
          ).receiptJson,
        ),
      ).toBe(before);
    });
  });

  describe("cycle contract: immutable receipt without a proposal", () => {
    it.each(["CREATED", "KEPT_EXISTING"] as const)(
      "%s preserves its cycle contract on both read endpoints without writes",
      async (outcome) => {
        const applied = await seedApplied(setup, world, {
          owner: owner(),
          participants: [
            {
              outcome,
              sourceProjectId: world.projects.pessoal,
              targets: [{ projectId: world.projects.casa, amountCents: 4000 }],
            },
          ],
          mutate: (receipt) => {
            receipt.snapshot.lines[0].schedule.occurrences[0].invoiceDueMonth =
              null;
          },
        });
        const before = await setup.importSession.findUniqueOrThrow({
          where: { id: applied.id },
        });
        expect(before.proposalJson).toBeNull();
        const { value, logged } = await silenced(async () => [
          await get(applied.id),
          await get(applied.id, "/result"),
        ]);
        for (const reply of value) {
          if (outcome === "CREATED") {
            expect([reply.status, reply.text]).toEqual([
              500,
              JSON.stringify(internal),
            ]);
          } else {
            expect(reply.status).toBe(200);
            expect(reply.json.receipt).toEqual(JSON.parse(applied.receipt));
            expect(reply.json.receipt.snapshot.lines[0].targets).toEqual([
              { projectId: world.projects.casa, amountCents: 4000 },
            ]);
          }
        }
        if (outcome === "CREATED") {
          expect(logged).toContain(applied.id);
          expect(logged).toContain("receipt");
          expect(logged).not.toContain("Mercado");
        } else expect(logged).toBe("");
        expect(
          await setup.importSession.findUniqueOrThrow({
            where: { id: applied.id },
          }),
        ).toEqual(before);
      },
    );

    it("authorizes every receipt participant before validating historical receipt cycles", async () => {
      const applied = await seedApplied(setup, world, {
        owner: world.users.restricted,
        participants: [
          {
            sourceProjectId: world.projects.pessoal,
            targets: [{ projectId: world.projects.casa, amountCents: 4000 }],
          },
        ],
        mutate: (receipt) => {
          receipt.snapshot.lines[0].schedule.occurrences[0].invoiceDueMonth =
            null;
        },
      });
      const { value, logged } = await silenced(async () => [
        await get(applied.id, "", world.users.restricted),
        await get(applied.id, "/result", world.users.restricted),
      ]);
      for (const reply of value) {
        expect([reply.status, reply.json]).toEqual([404, notFound]);
      }
      expect(logged).not.toContain(applied.id);
      expect(logged).not.toContain("receipt");
    });
  });

  describe("strict parser: 500 sanitised, never partial, never a fallback", () => {
    type Mutation = (receipt: Record<string, any>) => void;
    const invalid: Array<[string, Mutation]> = [
      [
        "snapshot absent (legacy IDs-only)",
        (r) => {
          delete r["snapshot"];
        },
      ],
      [
        "snapshot null",
        (r) => {
          r["snapshot"] = null;
        },
      ],
      [
        "snapshot is an array",
        (r) => {
          r["snapshot"] = [];
        },
      ],
      [
        "extra key on the receipt",
        (r) => {
          r["ownerUserId"] = "vazamento";
        },
      ],
      [
        "extra key on an item",
        (r) => {
          r["items"][0].note = "x";
        },
      ],
      [
        "extra key on snapshot",
        (r) => {
          r["snapshot"].extra = 1;
        },
      ],
      [
        "OCR/evidence key on snapshot",
        (r) => {
          r["snapshot"].evidence = "texto do OCR";
        },
      ],
      [
        "extra key on a line",
        (r) => {
          r["snapshot"].lines[0].fornecedor = "x";
        },
      ],
      [
        "extra key on a target",
        (r) => {
          r["snapshot"].lines[0].targets = [
            { projectId: "p", amountCents: 1, note: "x" },
          ];
        },
      ],
      [
        "lines not an array",
        (r) => {
          r["snapshot"].lines = {};
        },
      ],
      [
        "fewer lines than items",
        (r) => {
          r["snapshot"].lines = [];
        },
      ],
      [
        "more lines than items",
        (r) => {
          r["snapshot"].lines.push({
            ...r["snapshot"].lines[0],
            lineId: "line-9",
          });
        },
      ],
      [
        "line order differs from items",
        (r) => {
          r["items"].push({
            ...r["items"][0],
            lineId: "line-2",
            sourceExpenseId: "exp-line-2",
          });
          r["snapshot"].lines.push({
            ...r["snapshot"].lines[0],
            lineId: "line-2",
          });
          r["snapshot"].lines.reverse();
        },
      ],
      [
        "lineId differs from the item",
        (r) => {
          r["snapshot"].lines[0].lineId = "other";
        },
      ],
      [
        "KEEP outcome carrying a title",
        (r) => {
          r["items"][0].outcome = "KEPT_EXISTING";
          r["snapshot"].lines[0].dataCompra = null;
        },
      ],
      [
        "KEEP outcome carrying a purchase date",
        (r) => {
          r["items"][0].outcome = "KEPT_EXISTING";
          r["snapshot"].lines[0].titulo = null;
        },
      ],
      [
        "CREATE outcome without a title",
        (r) => {
          r["snapshot"].lines[0].titulo = null;
        },
      ],
      [
        "targets null (partial redaction)",
        (r) => {
          r["snapshot"].lines[0].targets = null;
        },
      ],
      [
        "fractional cents on a line",
        (r) => {
          r["snapshot"].lines[0].totalCents = 100.5;
        },
      ],
      [
        "string cents on a line",
        (r) => {
          r["snapshot"].lines[0].totalCents = "10000";
        },
      ],
      [
        "negative or NaN-like cents",
        (r) => {
          r["snapshot"].lines[0].totalCents = -1;
        },
      ],
      [
        "fractional cents on a target",
        (r) => {
          r["snapshot"].lines[0].targets = [
            {
              projectId: r["snapshot"].participantProjectIds[0],
              amountCents: 0.5,
            },
          ];
        },
      ],
      [
        "schedule invalid (not v1)",
        (r) => {
          r["snapshot"].lines[0].schedule = { version: 2, occurrences: [] };
        },
      ],
      [
        "schedule total differs from the line total",
        (r) => {
          r["snapshot"].lines[0].schedule = SNAPSHOT_SCHEDULE(1);
        },
      ],
      [
        "createdEconomicTotalCents differs from the CREATED lines",
        (r) => {
          r["snapshot"].createdEconomicTotalCents += 1;
        },
      ],
      [
        "bankCashDeltaCents not zero",
        (r) => {
          r["snapshot"].bankCashDeltaCents = 1;
        },
      ],
      [
        "invoice delta with an invalid month",
        (r) => {
          r["snapshot"].invoiceDeltas = [
            { invoiceDueMonth: "2026-13", amountCents: 1 },
          ];
        },
      ],
      [
        "participants not an array",
        (r) => {
          r["snapshot"].participantProjectIds = "p";
        },
      ],
      [
        "participants empty",
        (r) => {
          r["snapshot"].participantProjectIds = [];
        },
      ],
      [
        "participants with a non-string member",
        (r) => {
          r["snapshot"].participantProjectIds = [
            r["snapshot"].participantProjectIds[0],
            7,
          ];
        },
      ],
      [
        "participants unsorted",
        (r) => {
          r["snapshot"].participantProjectIds = [
            ...r["snapshot"].participantProjectIds,
            world.projects.casa,
          ]
            .sort()
            .reverse();
          r["snapshot"].lines[0].targets = [
            { projectId: world.projects.casa, amountCents: 1 },
          ];
        },
      ],
      [
        "participants with a duplicate",
        (r) => {
          r["snapshot"].participantProjectIds = [
            r["snapshot"].participantProjectIds[0],
            r["snapshot"].participantProjectIds[0],
          ];
        },
      ],
      [
        "participants missing a target project (union differs)",
        (r) => {
          r["snapshot"].lines[0].targets = [
            { projectId: "zz-not-in-union", amountCents: 1 },
          ];
        },
      ],
      [
        "participants with an extra project outside the union",
        (r) => {
          r["snapshot"].participantProjectIds = [
            ...r["snapshot"].participantProjectIds,
            world.projects.casa,
          ].sort();
        },
      ],
    ];
    it.each(invalid)("%s", async (_label, mutate) => {
      const applied = await seedApplied(setup, world, {
        owner: owner(),
        mutate,
      });
      const { value, logged } = await silenced(async () => [
        await get(applied.id),
        await get(applied.id, "/result"),
      ]);
      for (const reply of value) {
        expect([reply.status, reply.json]).toEqual([500, internal]);
        expect(reply.text).not.toContain("texto do OCR");
        expect(reply.text).not.toContain("snapshot");
      }
      expect(logged).toContain(applied.id);
      expect(logged).toContain("receipt");
      expect(logged).not.toContain("texto do OCR");
    });

    it('a valid JSON of the wrong shape (the DB CHECK only proves syntax) is corruption, not "no receipt"', async () => {
      for (const json of ["[]", '"x"', "1", "null", "{}"]) {
        const applied = await seedApplied(setup, world, {
          owner: owner(),
          receiptJson: json,
        });
        const { value } = await silenced(() => get(applied.id));
        expect([json, value.status]).toEqual([json, 500]);
      }
    });
  });

  describe("current participant and bound-card authorisation", () => {
    const readBoth = async (id: string, who = owner()) => {
      const [session, result] = [
        await get(id, "", who),
        await get(id, "/result", who),
      ];
      return { session, result };
    };
    it.each([
      {
        label: "soft-deleted",
        actor: () => owner(),
        participant: async () =>
          (
            await addSoftDeletedAnchor(
              setup,
              world,
              `x${randomUUID().slice(0, 6)}`,
            )
          ).projectId,
      },
      {
        label: "foreign",
        actor: () => owner(),
        participant: async () => world.projects.foreign,
      },
      {
        label: "missing",
        actor: () => owner(),
        participant: async () => "no-such-project",
      },
      {
        label: "outside the project grant",
        actor: () => world.users.restricted,
        participant: async () => world.projects.casa,
      },
      {
        label: "outside the expenses module",
        actor: () => world.users.restricted,
        participant: async () => world.projects.pessoal,
        revokeExpenses: true,
      },
    ])(
      "an APPLIED receipt is opaque when a participant is $label",
      async ({ actor, participant: participantFor, revokeExpenses }) => {
        const who = actor();
        const participant = await participantFor();
        const applied = await seedApplied(setup, world, {
          owner: who,
          participants: [
            {
              sourceProjectId: world.projects.pessoal,
              targets: [{ projectId: participant, amountCents: 500 }],
            },
          ],
        });
        if (revokeExpenses) {
          await setup.user.update({
            where: { id: world.users.restricted.id },
            data: { allowedModules: JSON.stringify(["creditCards"]) },
          });
        }
        const { session, result } = await readBoth(applied.id, who);
        const missingId = randomUUID();
        const missing = await readBoth(missingId, who);
        for (const reply of [session, result]) {
          expect([reply.status, reply.json]).toEqual([404, notFound]);
          expect(reply.text).not.toMatch(
            /snapshot|totalCents|participantProjectIds|line-1|Mercado/,
          );
        }
        expect(session.text).toBe(missing.session.text);
        expect(result.text).toBe(missing.result.text);
      },
    );

    it("a soft-deleted bound card hides detail and result even when the anchor remains active", async () => {
      const applied = await seedApplied(setup, world, {
        owner: owner(),
      });
      await setup.creditCard.update({
        where: { id: world.cards.pessoal },
        data: { deletedAt: FIXED_NOW },
      });
      try {
        const { session, result } = await readBoth(applied.id);
        expect([session.status, result.status]).toEqual([404, 404]);
        expect([session.json, result.json]).toEqual([notFound, notFound]);
      } finally {
        await setup.creditCard.update({
          where: { id: world.cards.pessoal },
          data: { deletedAt: null },
        });
      }
    });

    it("another owner (even OWNER/ADMIN class of the same tenant) never reads it", async () => {
      const applied = await seedApplied(setup, world, {
        owner: world.users.restricted,
      });
      expect((await get(applied.id, "", owner())).json).toEqual(notFound);
      expect(
        (await get(applied.id, "/result", world.users.foreign)).json,
      ).toEqual(notFound);
    });
  });

  describe("reads share one snapshot and write nothing", () => {
    it("GET session/result on an applied receipt leave every import_sessions and tenant row untouched", async () => {
      const applied = await seedApplied(setup, world, { owner: owner() });
      const before = JSON.stringify(
        await setup.importSession.findMany({
          where: { tenantId: world.tenantId },
          orderBy: { id: "asc" },
        }),
      );
      const tenantBefore = JSON.stringify(
        await setup.tenant.findUniqueOrThrow({ where: { id: world.tenantId } }),
      );
      await get(applied.id);
      await get(applied.id, "/result");
      expect(
        JSON.stringify(
          await setup.importSession.findMany({
            where: { tenantId: world.tenantId },
            orderBy: { id: "asc" },
          }),
        ),
      ).toBe(before);
      expect(
        JSON.stringify(
          await setup.tenant.findUniqueOrThrow({
            where: { id: world.tenantId },
          }),
        ),
      ).toBe(tenantBefore);
    });
  });

  describe("ACL envelope first, deep financial parse only afterwards", () => {
    const appliedList = async (who = owner()) =>
      api.call("GET", "/import-sessions?state=applied", {
        token: await api.tokenFor(who),
      });
    const corruptMoney = (r: Record<string, any>) => {
      r["snapshot"].lines[0].totalCents = 100.5;
    };

    it("hidden receipt participants win over corrupt receipt contents", async () => {
      const gone = await addSoftDeletedAnchor(
        setup,
        world,
        `e${randomUUID().slice(0, 6)}`,
      );
      const visible = await seedApplied(setup, world, {
        owner: owner(),
        index: 9,
      });
      for (const hidden of [
        gone.projectId,
        world.projects.foreign,
        "missing",
      ]) {
        const bad = await seedApplied(setup, world, {
          owner: owner(),
          index: 1,
          participants: [
            {
              sourceProjectId: world.projects.pessoal,
              targets: [{ projectId: hidden, amountCents: 1 }],
            },
          ],
          mutate: corruptMoney,
        });
        const { value, logged } = await silenced(async () => [
          await get(bad.id),
          await get(bad.id, "/result"),
          await appliedList(),
        ]);
        const [session, result, page] = value;
        expect([hidden, session.status, session.json]).toEqual([
          hidden,
          404,
          notFound,
        ]);
        expect([hidden, result.status, result.json]).toEqual([
          hidden,
          404,
          notFound,
        ]);
        expect([hidden, page.status]).toEqual([hidden, 200]);
        expect(page.json.items.map((item: { id: string }) => item.id)).toEqual([
          visible.id,
        ]);
        expect(logged).not.toContain(bad.id);
        expect(logged).not.toContain("receipt");
        expect(logged).not.toContain("100.5");
        await setup.importSession.delete({ where: { id: bad.id } });
      }
      expect((await get(visible.id)).status).toBe(200);
    });

    it("a restricted source owner gets opaque omission before corruption when a target is outside the grant", async () => {
      const bad = await seedApplied(setup, world, {
        owner: world.users.restricted,
        participants: [
          {
            sourceProjectId: world.projects.pessoal,
            targets: [{ projectId: world.projects.casa, amountCents: 1 }],
          },
        ],
        mutate: corruptMoney,
      });
      const { value, logged } = await silenced(async () => [
        await get(bad.id, "", world.users.restricted),
        await get(bad.id, "/result", world.users.restricted),
        await appliedList(world.users.restricted),
      ]);
      expect(value.map((reply) => reply.status)).toEqual([404, 404, 200]);
      expect(value[0].json).toEqual(notFound);
      expect(value[1].json).toEqual(notFound);
      expect(value[2].json.items).toEqual([]);
      expect(value[2].json.nextCursor).toBeNull();
      expect(logged).not.toContain(bad.id);
      expect(logged).not.toContain("receipt");
    });

    it.each([
      [
        "array absent",
        (r: Record<string, any>) => {
          delete r["snapshot"].participantProjectIds;
        },
      ],
      [
        "array is a string",
        (r: Record<string, any>) => {
          r["snapshot"].participantProjectIds = "x";
        },
      ],
      [
        "array is empty",
        (r: Record<string, any>) => {
          r["snapshot"].participantProjectIds = [];
        },
      ],
      [
        "array has a non-text member",
        (r: Record<string, any>) => {
          r["snapshot"].participantProjectIds = [7];
        },
      ],
    ])(
      "a malformed envelope (%s) is corruption: 500 on GET and on the list, never 404/omission",
      async (_label, mutate) => {
        const bad = await seedApplied(setup, world, { owner: owner(), mutate });
        const { value } = await silenced(async () => [
          await get(bad.id),
          await get(bad.id, "/result"),
          await appliedList(),
        ]);
        for (const reply of value)
          expect([reply.status, reply.json]).toEqual([500, internal]);
      },
    );

    it("valid participants all authorised + corrupt money on a VISIBLE row: sanitised 500 on GET and list, never []", async () => {
      const bad = await seedApplied(setup, world, {
        owner: owner(),
        mutate: corruptMoney,
      });
      const { value, logged } = await silenced(async () => [
        await get(bad.id),
        await get(bad.id, "/result"),
        await appliedList(),
      ]);
      for (const reply of value)
        expect([reply.status, reply.json]).toEqual([500, internal]);
      expect(logged).toContain(bad.id);
    });
  });

  describe("SEC-B1a-1: stored nested validation before any writer", () => {
    const sentinel = "PRIVATE-OCR-NONCE-SENTINEL";
    type Payload = {
      draft: ReturnType<typeof validationDraft>;
      proposal: ReturnType<typeof validationProposal>;
    };
    type Mutation = (payload: Payload) => void;
    const extra = (value: object) =>
      Object.assign(value, { privateEvidence: sentinel });
    const invalid: Array<[string, Mutation]> = [
      [
        "draft line extra key",
        ({ draft }) => {
          extra(draft.lines[0]!);
        },
      ],
      [
        "question extra key",
        ({ draft }) => {
          extra(draft.questions[0]!);
        },
      ],
      [
        "decision extra key",
        ({ draft }) => {
          extra(draft.lines[0]!.decision);
        },
      ],
      [
        "draft target extra key",
        ({ draft }) => {
          extra(draft.lines[0]!.targets![0]!);
        },
      ],
      [
        "scope extra key",
        ({ draft }) => {
          extra(draft.scope);
        },
      ],
      [
        "proposal extra key",
        ({ proposal }) => {
          extra(proposal);
        },
      ],
      [
        "proposal line extra key",
        ({ proposal }) => {
          extra(proposal.lines[0]!);
        },
      ],
      [
        "proposal target extra key",
        ({ proposal }) => {
          const line = proposal.lines[0]!;
          if (line.kind === "CREATE") extra(line.targets[0]!);
        },
      ],
      [
        "schedule occurrence extra key",
        ({ proposal }) => {
          extra(proposal.lines[0]!.schedule.occurrences[0]!);
        },
      ],
      [
        "invoice delta extra key",
        ({ proposal }) => {
          extra(proposal.invoiceDeltas[0]!);
        },
      ],
      [
        "fractional cents",
        ({ draft }) => {
          draft.lines[0]!.amountCents = 1.5;
        },
      ],
      [
        "numeric string is not cents",
        ({ draft }) => {
          Object.assign(draft.lines[0]!, { amountCents: "101" });
        },
      ],
      [
        "cents overflow",
        ({ draft }) => {
          draft.lines[0]!.amountCents = 2147483648;
        },
      ],
      [
        "installment limit",
        ({ draft }) => {
          draft.lines[0]!.installmentCount = 25;
        },
      ],
      [
        "invalid id",
        ({ draft }) => {
          draft.lines[0]!.id = "invalid/id";
        },
      ],
      [
        "duplicate target project",
        ({ draft }) => {
          draft.lines[0]!.targets!.push({ ...draft.lines[0]!.targets![0]! });
        },
      ],
      [
        "non-positive target",
        ({ draft }) => {
          draft.lines[0]!.targets![0]!.amountCents = 0;
        },
      ],
      [
        "text limit",
        ({ draft }) => {
          draft.lines[0]!.titulo = "x".repeat(161);
        },
      ],
      [
        "text is not NFC",
        ({ draft }) => {
          draft.lines[0]!.titulo = "Cafe\u0301";
        },
      ],
      [
        "invalid date",
        ({ draft }) => {
          draft.lines[0]!.dataCompra = "2026-02-30";
        },
      ],
      [
        "missing nullable field",
        ({ draft }) => {
          Reflect.deleteProperty(draft.lines[0]!, "fornecedor");
        },
      ],
      [
        "unknown enum",
        ({ draft }) => {
          Object.assign(draft.lines[0]!, { amountMeaning: "INFERRED" });
        },
      ],
      [
        "question field is not a field id",
        ({ draft }) => {
          Object.assign(draft.questions[0]!, { field: "titulo" });
        },
      ],
      [
        "question foreign line reference",
        ({ draft }) => {
          draft.questions[0]!.lineIds = ["outside-line"];
        },
      ],
      [
        "selected foreign line reference",
        ({ draft }) => {
          draft.selectedLineIds = ["outside-line"];
        },
      ],
      [
        "observation outside scope",
        ({ draft }) => {
          draft.lines[0]!.observationIds = ["outside-observation"];
        },
      ],
      [
        "same observation in two selected lines",
        ({ draft }) => {
          draft.lines[1]!.observationIds = ["observation-create"];
        },
      ],
      [
        "duplicate line id",
        ({ draft }) => {
          draft.lines[1]!.id = draft.lines[0]!.id;
        },
      ],
      [
        "invalid proposal revision",
        ({ proposal }) => {
          proposal.revision = 0;
        },
      ],
      [
        "proposal session cross-binding",
        ({ proposal }) => {
          proposal.sessionId = "another-session";
        },
      ],
      [
        "proposal hash cross-binding",
        ({ proposal }) => {
          proposal.proposalHash = "d".repeat(64);
        },
      ],
      [
        "proposal line cross-binding",
        ({ proposal }) => {
          proposal.lines[0]!.lineId = "outside-line";
        },
      ],
      [
        "kept expense cross-binding",
        ({ proposal }) => {
          const line = proposal.lines[1]!;
          if (line.kind === "KEEP_EXISTING")
            line.sourceExpenseId = "another-expense";
        },
      ],
      [
        "proposal schedule limit",
        ({ proposal }) => {
          const line = proposal.lines[0]!;
          line.schedule = {
            version: 1,
            occurrences: Array.from({ length: 25 }, (_, index) => ({
              index,
              parcela: null,
              valor: index === 24 ? 101 : 0,
              data: "2026-10-05",
              invoiceDueMonth: "2026-10",
            })),
          };
        },
      ],
      [
        "deferred observation cross-binding",
        ({ proposal }) => {
          proposal.deferredObservationIds = ["observation-create"];
        },
      ],
      [
        "invalid retention instant",
        ({ proposal }) => {
          proposal.retainUntil = "2026-02-30T00:00:00.000Z";
        },
      ],
    ];

    const seedPayload = async (
      mutate?: Mutation,
      applied = false,
      hidden = false,
    ) => {
      const seeded = applied
        ? await seedApplied(setup, world, {
            owner: world.users.restricted,
            participants: [
              {
                sourceProjectId: world.projects.pessoal,
                targets: hidden
                  ? [{ projectId: world.projects.casa, amountCents: 1 }]
                  : [],
              },
            ],
          })
        : await seedSession(setup, world);
      const payload: Payload = {
        draft: validationDraft(world.projects.pessoal),
        proposal: validationProposal(seeded.id, world.projects.pessoal),
      };
      mutate?.(payload);
      await setup.importSession.update({
        where: { id: seeded.id },
        data: {
          draftJson: JSON.stringify(payload.draft),
          proposalJson: JSON.stringify(payload.proposal),
          proposalHash: "c".repeat(64),
        },
      });
      return { id: seeded.id, ...payload };
    };

    it.each(["source", "target"] as const)(
      "cycle contract: historical APPLIED unknown CREATE %s is corrupt despite read-only actions",
      async (where) => {
        const seeded = await seedPayload(({ proposal }) => {
          const line = proposal.lines[0]!;
          if (line.kind !== "CREATE") throw new Error("fixture must CREATE");
          line.titulo = sentinel;
        }, true);
        const valid = await get(seeded.id, "", world.users.restricted);
        expect([valid.status, valid.json.state, valid.json.actions]).toEqual([
          200,
          "APPLIED",
          ["READ_RESULT"],
        ]);
        expect(valid.json.proposal).toBeNull();
        const line = seeded.proposal.lines[0]!;
        if (line.kind !== "CREATE") throw new Error("fixture must CREATE");
        line.schedule = structuredClone(line.schedule);
        line.targets[0]!.schedule = structuredClone(line.targets[0]!.schedule);
        const schedule =
          where === "source" ? line.schedule : line.targets[0]!.schedule;
        schedule.occurrences[1]!.invoiceDueMonth = null;
        const before = await setup.importSession.update({
          where: { id: seeded.id },
          data: { proposalJson: JSON.stringify(seeded.proposal) },
        });
        const { value, logged } = await silenced(async () => [
          await get(seeded.id, "", world.users.restricted),
          await get(seeded.id, "/result", world.users.restricted),
        ]);
        for (const reply of value) {
          expect([reply.status, reply.text]).toEqual([
            500,
            JSON.stringify(internal),
          ]);
        }
        expect(logged).toContain(seeded.id);
        expect(logged).toContain("proposal");
        expect(logged).not.toContain(sentinel);
        expect(
          await setup.importSession.findUniqueOrThrow({
            where: { id: seeded.id },
          }),
        ).toEqual(before);
      },
    );

    it.each(invalid)(
      "%s: authorised HTTP reads return only sanitised 500",
      async (_label, mutate) => {
        const seeded = await seedPayload(mutate);
        const { value, logged } = await silenced(async () => [
          await get(seeded.id),
          await get(seeded.id, "/result"),
        ]);
        for (const reply of value) {
          expect([reply.status, reply.json]).toEqual([500, internal]);
          expect(reply.text).toBe(JSON.stringify(internal));
        }
        expect(logged).toContain(seeded.id);
        expect(logged).not.toContain(sentinel);
        expect(logged).not.toContain("privateEvidence");
      },
    );

    const seedProjectionMaterial = async (
      seeded: Awaited<ReturnType<typeof seedPayload>>,
      unknownFacts: {
        amountCents: number | null;
        installmentCount: number | null;
        dateOnly: string | null;
      },
    ) => {
      const row = await setup.importSession.findUniqueOrThrow({
        where: { id: seeded.id },
      });
      const bytes = Buffer.from(
        `Synthetic structural projection fixture ${row.id}: ${unknownFacts.amountCents}`,
      );
      const extraction = validateDocumentExtraction({
        version: 1,
        parserVersion: "card-local-text-v1",
        documentKind: "UNKNOWN",
        invoiceDueMonth: null,
        metrics: {
          pages: 0,
          rows: 3,
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
            amountMeaning: "UNKNOWN",
            ...unknownFacts,
          },
        ].map((facts, sourceOrdinal) => ({
          ...facts,
          sourceOrdinal,
          section: "UNKNOWN",
          raw: {
            date: null,
            description: null,
            amount: null,
            installment: null,
          },
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
          scope: {
            observationIds: [],
            pendingAttachmentIds: [attachment.id],
          },
        },
        observations: [],
        newIds: new Map([
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
        ]),
      });
      await setup.importObservation.deleteMany({
        where: {
          tenantId: world.tenantId,
          id: { in: seeded.draft.scope.observationIds },
        },
      });
      await setup.importObservation.createMany({ data: plan.observations });
      return { attachmentId: attachment.id, declaredBytes: bytes.length };
    };

    it("preserves the full typed projection, unknown origin/money, field ids and historical labels exactly; never writes finances", async () => {
      const seeded = await seedPayload();
      const material = await seedProjectionMaterial(seeded, {
        amountCents: null,
        installmentCount: null,
        dateOnly: null,
      });
      const before = await setup.importSession.findUniqueOrThrow({
        where: { id: seeded.id },
      });
      const scope = { tenantId: world.tenantId };
      const money = async () => [
        await setup.expense.findMany({ where: scope }),
        await setup.cashFlowEntry.findMany({ where: scope }),
        await setup.rateioAllocation.findMany({ where: scope }),
      ];
      const financialBefore = await money();
      const expected = {
        version: 1,
        id: seeded.id,
        ownerProjectId: world.projects.pessoal,
        cardId: world.cards.pessoal,
        state: "DRAFT",
        revision: 1,
        expiresAt: before.expiresAt.toISOString(),
        attachments: [
          {
            id: material.attachmentId,
            fileName: "synthetic.csv",
            declaredBytes: material.declaredBytes,
            state: "ATTACHED",
            materializedInSession: true,
            canAnalyze: false,
          },
        ],
        lines: seeded.draft.lines,
        selectedLineIds: seeded.draft.selectedLineIds,
        questions: [
          ...seeded.draft.questions,
          ...[
            [
              "line-create",
              "observation-create",
              "merchant",
              "Nome do estabelecimento",
            ],
            ["line-keep", "observation-keep", "dataCompra", "Data da compra"],
            [
              "line-keep",
              "observation-keep",
              "merchant",
              "Nome do estabelecimento",
            ],
            [
              "line-keep",
              "observation-keep",
              "installmentCount",
              "Total de parcelas",
            ],
            [
              "line-keep",
              "observation-keep",
              "installmentIndex",
              "Número desta parcela",
            ],
            [
              "line-unknown",
              "observation-unknown",
              "dataCompra",
              "Data da compra",
            ],
            [
              "line-unknown",
              "observation-unknown",
              "merchant",
              "Nome do estabelecimento",
            ],
            [
              "line-unknown",
              "observation-unknown",
              "amountMeaning",
              "Significado do valor",
            ],
            [
              "line-unknown",
              "observation-unknown",
              "installmentCount",
              "Total de parcelas",
            ],
            [
              "line-unknown",
              "observation-unknown",
              "installmentIndex",
              "Número desta parcela",
            ],
          ].map(([lineId, observationId, field, text]) => ({
            id: expect.stringMatching(/^oq_[0-9a-f]{64}$/),
            lineIds: [lineId],
            field,
            text,
            subject: {
              kind: "OBSERVATION",
              observationId,
              meaningContext: null,
            },
            answerState: "UNANSWERED",
          })),
        ],
        reviewBlockers: [
          {
            lineId: "line-create",
            code: "ORIGINAL_IDENTITY_INCOMPLETE",
            resolution: "NEEDS_DECLARATION",
          },
          {
            lineId: "line-keep",
            code: "ORIGINAL_IDENTITY_INCOMPLETE",
            resolution: "NEEDS_DECLARATION",
          },
          {
            lineId: "line-keep",
            code: "ORIGINAL_OCCURRENCE_INCOMPLETE",
            resolution: "NEEDS_DECLARATION",
          },
          {
            lineId: "line-unknown",
            code: "ORIGINAL_IDENTITY_INCOMPLETE",
            resolution: "NEEDS_DECLARATION",
          },
          {
            lineId: "line-unknown",
            code: "ORIGINAL_OCCURRENCE_INCOMPLETE",
            resolution: "NEEDS_DECLARATION",
          },
        ],
        declaredFacts: [],
        searchComplete: false,
        proposal: null,
        confirmation: null,
        receipt: null,
        actions: ["CANCEL"],
      };
      const reply = await get(seeded.id);
      expect([reply.status, reply.json]).toEqual([200, expected]);
      const view: ImportSessionViewV1 = reply.json;
      const questionIds = view.questions.map((question) => question.id);
      expect(questionIds).toHaveLength(11);
      expect(new Set(questionIds).size).toBe(11);
      const reloaded = await get(seeded.id);
      expect([reloaded.status, reloaded.json]).toEqual([200, expected]);
      const reloadedView: ImportSessionViewV1 = reloaded.json;
      expect(reloadedView.questions.map((question) => question.id)).toEqual(
        questionIds,
      );
      expect((await get(seeded.id, "/result")).json).toEqual({
        state: "DRAFT",
        receipt: null,
      });
      expect(await money()).toEqual(financialBefore);
      expect(
        await setup.importSession.findUniqueOrThrow({
          where: { id: seeded.id },
        }),
      ).toEqual(before);
    });

    it.each([-2147483647, 0, 2147483647])(
      "keeps observed cents %s and unknown fields without inferring a purchase or a default",
      async (amountCents) => {
        const seeded = await seedPayload(({ draft }) => {
          const line = draft.lines[2]!;
          line.amountCents = amountCents;
          line.installmentCount = 24;
          line.titulo = "x".repeat(160);
          line.dataCompra = "1900-01-01";
          line.firstDueDate = "2199-12-31";
        });
        await seedProjectionMaterial(seeded, {
          amountCents,
          installmentCount: 24,
          dateOnly: "1900-01-01",
        });
        const reply = await get(seeded.id);
        expect(reply.status).toBe(200);
        expect(reply.json.lines[2]).toEqual(seeded.draft.lines[2]);
      },
    );

    it("bounded JSON rejects oversize before projection, never an empty success", async () => {
      const seeded = await seedPayload();
      await setup.importSession.update({
        where: { id: seeded.id },
        data: {
          draftJson: JSON.stringify({
            ...seeded.draft,
            evidence: "x".repeat(1048576),
          }),
        },
      });
      const { value } = await silenced(() => get(seeded.id));
      expect([value.status, value.json]).toEqual([500, internal]);
    });

    it("accepts exact draft count limits; each one-over fails with otherwise valid references", () => {
      const draft = validationDraft("target-0");
      const template = draft.lines[0]!;
      draft.lines = Array.from({ length: 100 }, (_, index) => ({
        ...template,
        id: `line-${index}`,
        observationIds: Array.from(
          { length: 20 },
          (_, offset) => `obs-${index * 20 + offset}`,
        ),
        targets: [
          {
            projectId: "target-0",
            roomId: null,
            amountCents: template.amountCents!,
          },
        ],
      }));
      draft.selectedLineIds = draft.lines.slice(0, 10).map((line) => line.id);
      draft.questions = [
        {
          id: "question-all",
          lineIds: draft.lines.map((line) => line.id),
          field: "decision",
          text: "x".repeat(500),
        },
      ];
      draft.scope.observationIds = draft.lines.flatMap(
        (line) => line.observationIds,
      );
      draft.scope.pendingAttachmentIds = Array.from(
        { length: 10 },
        (_, index) => `attachment-${index}`,
      );
      expect(parseStoredDraft(JSON.stringify(draft))).toEqual(draft);
      const over: Array<(value: typeof draft) => void> = [
        (value) => {
          value.selectedLineIds.push("line-10");
        },
        (value) => {
          value.lines.push({ ...value.lines[99]!, id: "line-100" });
        },
        (value) => {
          value.lines[99]!.observationIds.push("obs-0");
        },
        (value) => {
          value.lines[99]!.targets!.push({
            projectId: "target-1",
            roomId: null,
            amountCents: 1,
          });
        },
        (value) => {
          value.scope.pendingAttachmentIds.push("attachment-10");
        },
      ];
      for (const mutate of over) {
        const invalid = structuredClone(draft);
        mutate(invalid);
        expect(() => parseStoredDraft(JSON.stringify(invalid))).toThrow(
          ImportSessionCorruptStateError,
        );
      }
    });

    it("an out-of-grant participant masks corrupt draft/proposal content from the source owner with opaque 404", async () => {
      const seeded = await seedPayload(
        ({ draft, proposal }) => {
          extra(draft.lines[0]!);
          extra(proposal.lines[0]!);
        },
        true,
        true,
      );
      const { value, logged } = await silenced(async () => [
        await get(seeded.id, "", world.users.restricted),
        await get(seeded.id, "/result", world.users.restricted),
      ]);
      for (const reply of value)
        expect([reply.status, reply.json]).toEqual([404, notFound]);
      expect(logged).not.toContain(seeded.id);
      expect(logged).not.toContain(sentinel);
    });

    it.each(["draft", "proposal"])(
      "a %s target outside the grant masks corruption in the active payload",
      async (where) => {
        const seeded = await seedPayload(({ draft, proposal }) => {
          if (where === "draft")
            draft.lines[0]!.targets![0]!.projectId = world.projects.casa;
          else {
            const line = proposal.lines[0]!;
            if (line.kind === "CREATE")
              line.targets[0]!.projectId = world.projects.casa;
          }
          extra(draft.questions[0]!);
        });
        await setup.importSession.update({
          where: { id: seeded.id },
          data: { ownerUserId: world.users.restricted.id },
        });
        const { value, logged } = await silenced(async () => [
          await get(seeded.id, "", world.users.restricted),
          await get(seeded.id, "/result", world.users.restricted),
        ]);
        for (const reply of value)
          expect([reply.status, reply.json]).toEqual([404, notFound]);
        expect(logged).not.toContain(seeded.id);
        expect(logged).not.toContain("ImportSessionCorruptStateError");
        expect(logged).not.toContain(sentinel);
      },
    );

    it("cancel with writes disabled discards corrupt unused nested content, including CONFIRMED", async () => {
      const seeded = await seedPayload(({ draft, proposal }) => {
        extra(draft.lines[0]!);
        extra(proposal.lines[0]!);
      });
      await setup.importSession.update({
        where: { id: seeded.id },
        data: {
          state: "CONFIRMED",
          financialRequestId: randomUUID(),
          confirmedRevision: 1,
          confirmedSessionVersion: 0,
          confirmedAt: FIXED_NOW,
        },
      });
      const reply = await api.call(
        "POST",
        `/import-sessions/${seeded.id}/cancel`,
        {
          token: await api.tokenFor(owner()),
          headers: UI_HEADERS,
          body: { expectedRevision: 1 },
        },
      );
      expect([
        reply.status,
        reply.json.state,
        reply.json.lines,
        reply.json.proposal,
      ]).toEqual([200, "CANCELLED", [], null]);
    });
  });

  describe("card must belong to the anchor project", () => {
    it("the database itself refuses a session whose card belongs to another project (composite FK, real constraint)", async () => {
      await expect(
        setup.importSession.create({
          data: sessionRow(world, owner().id, 0, {
            cardId: world.cards.casa,
          }) as never,
        }),
      ).rejects.toMatchObject({ code: "P2003" });
    });

    it("the access helper refuses a card of another project and accepts the matching one (no corrupt row fabricated)", async () => {
      const actor = await reauthorize(setup, authFor(owner()), FIXED_NOW);
      await expect(
        assertCardAccess(
          setup,
          actor,
          world.cards.casa,
          world.projects.pessoal,
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        assertCardAccess(
          setup,
          actor,
          world.cards.pessoal,
          world.projects.pessoal,
        ),
      ).resolves.toEqual({
        cardId: world.cards.pessoal,
        projectId: world.projects.pessoal,
      });
    });
  });

  describe("recovery cancel and the receipt", () => {
    it("cancel of a session with a corrupt UNUSED draft closes it with zero financial writes, keeps reserved bytes and releases refs (never touches the reaper's job)", async () => {
      const seeded = await seedSession(setup, world, {
        ownerUserId: owner().id,
        draftJson: '{"version":1,"lines":"x"}',
      });
      await setup.importSessionArtifact.createMany({
        data: [0, 1].map((position) => ({
          id: randomUUID(),
          tenantId: world.tenantId,
          sessionId: seeded.id,
          ownerProjectId: world.projects.pessoal,
          position,
          fileName: `f${position}.pdf`,
          declaredMime: "application/pdf",
          declaredBytes: 10,
          state: "RESERVED",
          reservedBytes: 10,
          temporaryStorageKey: position === 0 ? `k-${seeded.id}` : null,
        })),
      });
      const money = async () => [
        await setup.expense.count({ where: { tenantId: world.tenantId } }),
        await setup.cashFlowEntry.count({
          where: { tenantId: world.tenantId },
        }),
      ];
      const before = await money();
      const reply = await api.call(
        "POST",
        `/import-sessions/${seeded.id}/cancel`,
        {
          token: await api.tokenFor(owner()),
          headers: UI_HEADERS,
          body: { expectedRevision: 1 },
        },
      );
      expect([reply.status, reply.json.state, reply.json.receipt]).toEqual([
        200,
        "CANCELLED",
        null,
      ]);
      expect(await money()).toEqual(before);
      const refs = await setup.importSessionArtifact.findMany({
        where: { sessionId: seeded.id },
        orderBy: { position: "asc" },
      });
      expect(
        refs.map((r) => [r.state, r.reservedBytes, r.temporaryPurgePending]),
      ).toEqual([
        ["RELEASED", 10, true],
        ["RELEASED", 10, false],
      ]);
      expect(refs[0]!.temporaryStorageKey).toBe(`k-${seeded.id}`);
      const row = await setup.importSession.findUniqueOrThrow({
        where: { id: seeded.id },
      });
      expect([row.state, row.draftJson]).toEqual([
        "CANCELLED",
        JSON.stringify({
          version: 1,
          lines: [],
          selectedLineIds: [],
          questions: [],
          scope: { observationIds: [], pendingAttachmentIds: [] },
        }),
      ]);
    });

    it("a projection without a completed ACL gate (actor = null, cancel/recovery) never emits a receipt", async () => {
      const applied = await seedApplied(setup, world, { owner: owner() });
      const row = await setup.importSession.findUniqueOrThrow({
        where: { id: applied.id },
      });
      expect(
        projectSession(row, [], FIXED_NOW, { includeReceipt: false }).view
          .receipt,
      ).toBeNull();
      expect(
        projectSession(row, [], FIXED_NOW, { includeReceipt: true }).view
          .receipt,
      ).not.toBeNull();
      const cancel = await api.call(
        "POST",
        `/import-sessions/${applied.id}/cancel`,
        {
          token: await api.tokenFor(owner()),
          headers: UI_HEADERS,
          body: { expectedRevision: 1 },
        },
      );
      expect(cancel.status).toBe(409);
      expect(cancel.json.code).toBe("ALREADY_APPLIED");
      expect(cancel.text).not.toMatch(/receipt|snapshot|totalCents/);
    });
  });
});
