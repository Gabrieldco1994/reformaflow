require("../../../../../scripts/test-db-env.cjs");

import { promises as fs } from "node:fs";
import { Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import {
  authFor,
  cleanupImportWorld,
  createBody,
  seedImportWorld,
  seedSession,
  type ImportWorld,
} from "../../test-utils/import-session-harness";
import {
  bootVaultApp,
  CANONICAL_VAULT,
  connectVaultTestDatabase,
  UI_HEADERS,
  type RecoveryApp,
} from "../../test-utils/import-session-vault-harness";
import {
  DefaultImportSessionCapability,
  IMPORT_SESSION_CAPABILITY,
} from "./import-session.capability";
import { ImportSessionService } from "./import-session.service";
import { ImportSessionExtractionService } from "./import-session.extraction.service";
import * as extraction from "./import-session.extraction";
import { IMPORT_VAULT_GATE, ImportVaultGate } from "./vault/vault-state";
import type { VaultBootHandle } from "./vault/vault-boot";

const PREFIX = "public-entry-own";
// Qualified formats are a test-only producer, not an available RAW executor.
const capability = {
  writesEnabled: () => true,
  newImportFormats: () => ["CSV"] as const,
};

describe("public entry: real list projection, inactive production", () => {
  const setup = new PrismaService();
  let world: ImportWorld;
  let off: RecoveryApp;
  let active: RecoveryApp;
  let token: string;
  let gate: ImportVaultGate;

  beforeAll(async () => {
    await connectVaultTestDatabase(setup);
    world = await seedImportWorld(setup, PREFIX);
    off = await bootVaultApp(setup, {
      writes: false,
      vault: "real",
      overrides: [
        {
          token: IMPORT_SESSION_CAPABILITY,
          value: new DefaultImportSessionCapability(),
        },
      ],
    });
    active = await bootVaultApp(setup, {
      vault: CANONICAL_VAULT,
      overrides: [{ token: IMPORT_SESSION_CAPABILITY, value: capability }],
    });
    gate = active.app.get<ImportVaultGate>(IMPORT_VAULT_GATE);
    token = await active.tokenFor(world.users.owner);
  });

  afterAll(async () => {
    await active?.close();
    await off?.close();
    await cleanupImportWorld(setup, PREFIX);
    await setup.$disconnect();
  });

  const list = () => active.call("GET", "/import-sessions", { token });

  async function withBoot(
    patch: Partial<VaultBootHandle>,
    check: () => Promise<void>,
  ) {
    const original = gate.boot;
    const boot: VaultBootHandle = { ...original, ...patch };
    expect(Reflect.set(gate, "boot", boot)).toBe(true);
    try {
      await check();
    } finally {
      expect(Reflect.set(gate, "boot", original)).toBe(true);
    }
  }

  it("default_off_projects_unavailable_and_preserves_recovery", async () => {
    const row = await seedSession(setup, world);
    expect(
      off.app
        .get<DefaultImportSessionCapability>(IMPORT_SESSION_CAPABILITY)
        .writesEnabled(),
    ).toBe(false);
    const page = await off.call("GET", "/import-sessions", { token });
    expect(page.status).toBe(200);
    expect(Object.keys(page.json).sort()).toEqual([
      "entry",
      "items",
      "nextCursor",
    ]);
    expect(page.json.entry).toEqual({
      kind: "UNAVAILABLE",
      version: 1,
      reason: "NOT_ENABLED",
    });
    expect(page.json.items.map((item: { id: string }) => item.id)).toEqual([
      row.id,
    ]);
    const detail = await off.call("GET", `/import-sessions/${row.id}`, {
      token,
    });
    expect(detail.status).toBe(200);
    expect(detail.json.actions).toEqual(["CANCEL"]);
    const result = await off.call("GET", `/import-sessions/${row.id}/result`, {
      token,
    });
    expect(result.json).toEqual({ state: "DRAFT", receipt: null });
    const cancel = await off.call("POST", `/import-sessions/${row.id}/cancel`, {
      token,
      headers: UI_HEADERS,
      body: { expectedRevision: row.revision },
    });
    expect(cancel.status).toBe(200);
    expect(cancel.json.state).toBe("CANCELLED");
    const create = await off.call("POST", "/import-sessions", {
      token,
      headers: UI_HEADERS,
      body: {},
    });
    expect([create.status, create.json.code]).toEqual([
      503,
      "CAPABILITY_DISABLED",
    ]);
  });

  it("boot snapshot ignores later environment, header, and query activation values", async () => {
    const previous = {
      current: process.env.IMPORT_SESSION_INTAKE_MODE,
      legacy: process.env.IMPORT_SESSION_WRITES_ENABLED,
    };
    try {
      process.env.IMPORT_SESSION_INTAKE_MODE = "csv";
      process.env.IMPORT_SESSION_WRITES_ENABLED = "true";
      const reply = await off.call(
        "POST",
        "/import-sessions?IMPORT_SESSION_INTAKE_MODE=csv",
        {
          token,
          headers: {
            ...UI_HEADERS,
            "x-import-session-intake-mode": "csv",
            "x-import-session-writes-enabled": "true",
          },
          body: createBody(
            world.cards.pessoal,
            "66666666-6666-4666-8666-666666666666",
          ),
        },
      );
      expect(reply.status).toBe(503);
      expect(reply.json).toMatchObject({
        code: "CAPABILITY_DISABLED",
        reason: null,
      });
      expect(
        await setup.importSession.count({
          where: {
            createRequestId: "66666666-6666-4666-8666-666666666666",
          },
        }),
      ).toBe(0);
    } finally {
      for (const [key, value] of [
        ["IMPORT_SESSION_INTAKE_MODE", previous.current],
        ["IMPORT_SESSION_WRITES_ENABLED", previous.legacy],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("positive_entry_requires_writes_live_runtime_and_qualified_raw_formats", async () => {
    expect(gate.boot.runtime()).not.toBeNull();
    expect(gate.boot.stopped.aborted).toBe(false);
    const page = await list();
    expect(page.status).toBe(200);
    expect(page.json).toEqual({
      items: [],
      nextCursor: null,
      entry: { kind: "CARD_INVOICE", version: 1, formats: ["CSV"] },
    });
    const writes = jest
      .spyOn(capability, "writesEnabled")
      .mockReturnValue(false);
    try {
      expect((await list()).json.entry).toEqual({
        kind: "UNAVAILABLE",
        version: 1,
        reason: "NOT_ENABLED",
      });
    } finally {
      writes.mockRestore();
    }
  });

  it("stopped_runtime_is_unavailable_even_when_runtime_is_non_null", async () => {
    const stopped = new AbortController();
    stopped.abort();
    await withBoot({ stopped: stopped.signal }, async () => {
      expect(gate.boot.runtime()).not.toBeNull();
      expect((await list()).json.entry).toEqual({
        kind: "UNAVAILABLE",
        version: 1,
        reason: "RUNTIME_UNAVAILABLE",
      });
    });
  });

  it("null_runtime_is_unavailable_even_when_not_stopped", async () => {
    await withBoot({ runtime: () => null }, async () => {
      expect(gate.boot.stopped.aborted).toBe(false);
      expect((await list()).json.entry).toEqual({
        kind: "UNAVAILABLE",
        version: 1,
        reason: "RUNTIME_UNAVAILABLE",
      });
    });
  });

  it("extracted_support_does_not_qualify_raw_formats", async () => {
    expect(
      extraction.supportsImportExtraction({
        detectedFormat: "CSV",
        parserVersion: "card-local-text-v1",
      }),
    ).toBe(true);
    const original = capability.newImportFormats;
    expect(Reflect.set(capability, "newImportFormats", () => [])).toBe(true);
    try {
      expect((await list()).json.entry).toEqual({
        kind: "UNAVAILABLE",
        version: 1,
        reason: "NO_QUALIFIED_FORMAT",
      });
    } finally {
      expect(Reflect.set(capability, "newImportFormats", original)).toBe(true);
    }
  });

  it.each([
    ["null", null],
    ["object", { formats: ["CSV"] }],
    ["string", "CSV"],
    ["sparse", Array(1)],
    ["duplicate", ["CSV", "CSV"]],
    ["out-of-set", ["PNG"]],
    ["unknown", ["PRIVATE_INVALID_FORMAT"]],
    ["undefined-member", ["CSV", undefined]],
  ])(
    "invalid_formats_fail_loud_without_positive_projection: %s",
    async (_name, bad) => {
      const original = capability.newImportFormats;
      expect(Reflect.set(capability, "newImportFormats", () => bad)).toBe(true);
      const log = jest
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => undefined);
      try {
        const page = await list();
        expect(page.status).toBe(500);
        expect(page.json).toEqual({
          statusCode: 500,
          message: "Internal server error",
        });
        expect(log).toHaveBeenCalledWith(
          "import-sessions request failed: TypeError",
        );
        expect(page.text).not.toContain("PRIVATE_INVALID_FORMAT");
      } finally {
        log.mockRestore();
        expect(Reflect.set(capability, "newImportFormats", original)).toBe(
          true,
        );
      }
    },
  );

  it("entry_projection_follows_reauthorization", async () => {
    const formats = jest.spyOn(capability, "newImportFormats");
    await setup.user.update({
      where: { id: world.users.owner.id },
      data: { sessionVersion: 1 },
    });
    try {
      await expect(
        active.app
          .get(ImportSessionService)
          .list(authFor(world.users.owner), {}),
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      expect(formats).not.toHaveBeenCalled();
    } finally {
      formats.mockRestore();
      await setup.user.update({
        where: { id: world.users.owner.id },
        data: { sessionVersion: 0 },
      });
    }
  });

  it("CREATE preflight precedes body validation and exposes no catalog reason", async () => {
    const writes = jest
      .spyOn(capability, "writesEnabled")
      .mockReturnValue(false);
    try {
      const reply = await active.call("POST", "/import-sessions", {
        token,
        headers: UI_HEADERS,
        body: {},
      });
      expect(reply.status).toBe(503);
      expect(reply.json).toEqual({
        code: "CAPABILITY_DISABLED",
        retryable: true,
        sessionId: null,
        currentRevision: null,
        reason: null,
      });
    } finally {
      writes.mockRestore();
    }
  });

  it("malformed producer wins over normal CREATE unavailability", async () => {
    const originalFormats = capability.newImportFormats;
    expect(
      Reflect.set(capability, "newImportFormats", () => ["CSV", "CSV"]),
    ).toBe(true);
    const writes = jest
      .spyOn(capability, "writesEnabled")
      .mockReturnValue(false);
    const log = jest
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    try {
      const reply = await active.call("POST", "/import-sessions", {
        token,
        headers: UI_HEADERS,
        body: {},
      });
      expect(reply.status).toBe(500);
      expect(reply.json).toEqual({
        statusCode: 500,
        message: "Internal server error",
      });
      expect(log).toHaveBeenCalledWith(
        "import-sessions request failed: TypeError",
      );
    } finally {
      log.mockRestore();
      writes.mockRestore();
      expect(Reflect.set(capability, "newImportFormats", originalFormats)).toBe(
        true,
      );
    }
  });

  it.each([
    ["before persistence", 3],
    ["before successful return", 4],
  ])(
    "CREATE revocation %s returns closed 503 and rolls back",
    async (_phase, rejectedProof) => {
      const runtime = gate.boot.runtime();
      if (!runtime) throw new Error("expected live vault runtime");
      const recheck = jest.fn().mockImplementation(async () => {
        return recheck.mock.calls.length === rejectedProof
          ? { ok: false }
          : { ok: true, runtime };
      });
      const requestId =
        rejectedProof === 3
          ? "88888888-8888-4888-8888-888888888888"
          : "99999999-9999-4999-8999-999999999999";
      await withBoot({ recheckLock: recheck }, async () => {
        const before = await setup.importSession.count({
          where: { createRequestId: requestId },
        });
        const reply = await active.call("POST", "/import-sessions", {
          token,
          headers: UI_HEADERS,
          body: createBody(world.cards.pessoal, requestId),
        });
        expect([reply.status, reply.json]).toEqual([
          503,
          {
            code: "CAPABILITY_DISABLED",
            retryable: true,
            sessionId: null,
            currentRevision: null,
            reason: null,
          },
        ]);
        expect(recheck).toHaveBeenCalledTimes(rejectedProof);
        expect(
          await setup.importSession.count({
            where: { createRequestId: requestId },
          }),
        ).toBe(before);
      });
    },
  );

  it("CREATE keeps cross-tenant card denial opaque after live gate checks", async () => {
    const requestId = "77777777-7777-4777-8777-777777777777";
    const reply = await active.call("POST", "/import-sessions", {
      token,
      headers: UI_HEADERS,
      body: createBody(world.cards.foreign, requestId),
    });
    expect(reply.status).toBe(404);
    expect(reply.json).toEqual({
      code: "NOT_FOUND",
      retryable: false,
      sessionId: null,
      currentRevision: null,
      reason: null,
    });
    expect(
      await setup.importSession.count({
        where: { createRequestId: requestId },
      }),
    ).toBe(0);
  });

  it("list_entry_performs_no_documentary_io_or_writes", async () => {
    const methods = [
      jest.spyOn(fs, "open"),
      jest.spyOn(fs, "readFile"),
      jest.spyOn(fs, "writeFile"),
      jest.spyOn(extraction, "supportsImportExtraction"),
      jest.spyOn(
        active.app.get(ImportSessionExtractionService),
        "analyzeAttached",
      ),
    ];
    const recheck = jest.fn(gate.boot.recheckLock);
    const writes: string[] = [];
    let observing = true;
    active.app.get(PrismaService).$use(async (params, next) => {
      if (observing && /^(create|update|delete|upsert)/.test(params.action))
        writes.push(`${params.model}.${params.action}`);
      return next(params);
    });
    try {
      await withBoot({ recheckLock: recheck }, async () => {
        expect((await list()).status).toBe(200);
        expect(recheck).not.toHaveBeenCalled();
        for (const method of methods) expect(method).not.toHaveBeenCalled();
        expect(writes).toEqual([]);
      });
    } finally {
      observing = false;
      for (const method of methods) method.mockRestore();
    }
  });
});
