import { randomUUID } from "node:crypto";
import { appendFileSync, cpSync, promises as fsp } from "node:fs";
import childProcess from "node:child_process";
import type { FileHandle } from "node:fs/promises";
import { NestApplication } from "@nestjs/core";
import { PrismaService } from "../prisma/prisma.service";
import { JwtStrategy } from "../auth/jwt.strategy";
import {
  mkdir,
  mkdtemp,
  open as namedOpen,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  canonicalDir,
  canonicalVaultFixture,
  bootVaultApp,
  connectVaultTestDatabase,
  createVaultTestDatabase,
  vaultTestDatabaseIsSafe,
  VaultFixtureDatabaseError,
  pdfBytes,
  readStoredBlob,
  sha256Hex,
  spyVaultOpen,
  CANONICAL_VAULT,
  fileSeed,
  finishVaultFixture,
  fullDigest,
  getVaultGate,
  MIB,
  putContent,
  reserve,
  seedArtifact,
  seedRef,
  TEN_MIB,
  wire,
  type RecoveryApp,
} from "./import-session-vault-harness";
import { seedImportWorld, seedSession } from "./import-session-harness";
import { fixture as foundationFixture } from "./vault-foundation-harness";

const {
  REPO_ROOT,
}: { REPO_ROOT: string } = require("../../../../scripts/test-db-env.cjs");
const evidenceRoot =
  process.env.VAULT_ATTACHMENT_TEST_EVIDENCE_DIR ??
  join(REPO_ROOT, ".agents/attachment-http-evidence");

describe("HTTP fixture authentication connection ownership", () => {
  it.each(["closed", "failed-boot"] as const)(
    "%s nested app cannot authenticate through its disconnected Prisma client or contaminate the next private DB gate",
    async (mode) => {
      const database = await createVaultTestDatabase();
      let parent: RecoveryApp | undefined;
      let nested: RecoveryApp | undefined;
      let nestedDb: PrismaService | undefined;
      let parentClosed = false;
      let nestedClosed = false;
      let retired = false;
      let nextDatabase:
        | Awaited<ReturnType<typeof createVaultTestDatabase>>
        | undefined;
      const calls: string[] = [];
      const queries: Array<{ model?: string; action: string }> = [];
      const spies: jest.SpyInstance[] = [];
      const bootError = new Error("controlled failure after native Nest init");
      let failure: unknown;
      try {
        const world = await seedImportWorld(
          database.setup,
          `http-connection-${mode}`,
        );
        const session = await seedSession(database.setup, world, {
          ownerUserId: world.users.restricted.id,
        });
        parent = await bootVaultApp(database.setup, { vault: "real" });
        const parentStrategy = parent.app.get(JwtStrategy);
        const validateParent = parentStrategy.validate.bind(parentStrategy);
        spies.push(
          jest
            .spyOn(parentStrategy, "validate")
            .mockImplementation((payload) => {
              calls.push("parent");
              return validateParent(payload);
            }),
        );
        const boot = bootVaultApp(database.setup, {
          vault: "real",
          beforeListen: (app) => {
            const client = app.get<PrismaService>(PrismaService);
            nestedDb = client;
            const strategy = app.get(JwtStrategy);
            const validate = strategy.validate.bind(strategy);
            spies.push(
              jest.spyOn(strategy, "validate").mockImplementation((payload) => {
                calls.push("nested");
                return validate(payload);
              }),
            );
            client.$use(async (params, next) => {
              if (retired)
                queries.push({ model: params.model, action: params.action });
              return next(params);
            });
            if (mode === "failed-boot") throw bootError;
          },
        });
        if (mode === "failed-boot") await expect(boot).rejects.toBe(bootError);
        else {
          nested = await boot;
          await nested.close();
          nestedClosed = true;
        }
        retired = true;
        const token = await parent.tokenFor(world.users.restricted);
        const reply = await parent.call(
          "GET",
          `/import-sessions/${session.id}`,
          {
            token,
          },
        );
        const invalid = await parent.call(
          "GET",
          `/import-sessions/${session.id}`,
          { token: "not-a-jwt" },
        );
        await fsp.writeFile(
          join(database.directory, "authentication-lifetime.json"),
          JSON.stringify({
            mode,
            pid: process.pid,
            calls,
            queries,
            status: reply.status,
            invalidStatus: invalid.status,
          }),
          { flag: "wx", mode: 0o600 },
        );
        expect([reply.status, reply.json.id, invalid.status]).toEqual([
          200,
          session.id,
          401,
        ]);
        await finishVaultFixture(parent.close.bind(parent), database.close);
        parentClosed = true;
        nextDatabase = await createVaultTestDatabase();
        expect(vaultTestDatabaseIsSafe(nextDatabase.setup)).toBe(true);
        expect(calls).toEqual(["parent"]);
        expect(queries).toEqual([]);
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        try {
          await finishVaultFixture(
            () => nextDatabase?.close(),
            () => !nestedClosed && nested?.close(),
            () => !parentClosed && parent?.close(),
            () => nestedDb?.$disconnect(),
            () => !parentClosed && database.close(),
            ...spies.reverse().map((spy) => () => spy.mockRestore()),
          );
        } catch (cleanupError) {
          if (failure !== undefined)
            throw new AggregateError(
              [failure, cleanupError],
              "Authentication ownership control and cleanup failed",
            );
          throw cleanupError;
        }
      }
    },
  );
});

describe("sequential vault fixture isolation", () => {
  it("real lifecycle predecessor closes before the private successor and global quota N/N+1", async () => {
    await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
    const evidence = await mkdtemp(join(evidenceRoot, "sequential-control-"));
    const trace = join(evidence, "sequential-ownership.jsonl");
    let phase = "predecessor";
    let ordinal = 0;
    const clients = new WeakMap<PrismaService, string>();
    const spies: jest.SpyInstance[] = [];
    const note = (event: string, data: Record<string, unknown> = {}) => {
      appendFileSync(
        trace,
        JSON.stringify({ event, phase, pid: process.pid, ...data }) + "\n",
        { mode: 0o600 },
      );
    };
    const files = (event: string, data: Record<string, unknown> = {}) => {
      const args = ["-nP", "-a", "-p", String(process.pid), "-F0pftn"];
      const result = childProcess.spawnSync("lsof", args, {
        encoding: "utf8",
        timeout: 2500,
      });
      note(event, {
        ...data,
        command: "lsof",
        args,
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    };
    const observe = (client: PrismaService, role: string) => {
      if (clients.has(client)) return;
      const id = `${role}-${++ordinal}`;
      clients.set(client, id);
      let disconnected = false;
      note("owned", { id, role, stack: new Error().stack });
      for (const method of ["$connect", "$disconnect"] as const) {
        const native = client[method].bind(client);
        spies.push(
          jest.spyOn(client, method).mockImplementation(async () => {
            note(`${method}:enter`, { id, stack: new Error().stack });
            await native();
            disconnected = method === "$disconnect";
            files(`${method}:resolved`, { id });
          }),
        );
      }
      client.$use(async (params, next) => {
        note("query:enter", {
          id,
          disconnected,
          model: params.model,
          action: params.action,
        });
        try {
          return await next(params);
        } finally {
          note("query:settled", {
            id,
            disconnected,
            model: params.model,
            action: params.action,
          });
        }
      });
    };
    let predecessorDatabase:
      | Awaited<ReturnType<typeof createVaultTestDatabase>>
      | undefined;
    let predecessor: PrismaService | undefined;
    let predecessorApp: RecoveryApp | undefined;
    let predecessorClosed = false;
    let successor: Awaited<ReturnType<typeof foundationFixture>> | undefined;
    let successorClosed = false;
    let quota: PrismaService | undefined;
    let quotaDatabase:
      | Awaited<ReturnType<typeof createVaultTestDatabase>>
      | undefined;
    let quotaApp: RecoveryApp | undefined;
    let primaryError: unknown;
    try {
      predecessorDatabase = await createVaultTestDatabase();
      predecessor = predecessorDatabase.setup;
      observe(predecessor, "lifecycle-setup");
      const nativeInit = PrismaService.prototype.onModuleInit;
      spies.push(
        jest
          .spyOn(PrismaService.prototype, "onModuleInit")
          .mockImplementation(async function (this: PrismaService) {
            observe(this, `${phase}-app`);
            await nativeInit.call(this);
          }),
      );
      files("predecessor:admitted", { database: predecessorDatabase.file });
      const world = await seedImportWorld(predecessor, "lifecycle-sequential");
      predecessorApp = await bootVaultApp(predecessor, {
        writes: true,
        vault: CANONICAL_VAULT,
      });
      const owner = world.users.restricted;
      const session = await seedSession(predecessor, world, {
        ownerUserId: owner.id,
      });
      const id = await seedRef(predecessor, session, owner);
      const payload = pdfBytes(1000, "sequential-lifecycle");
      const uploaded = await putContent(predecessorApp, session.id, id, {
        token: await predecessorApp.tokenFor(owner),
        body: payload,
      });
      expect(uploaded.status).toBe(200);
      const ref = await predecessor.importSessionArtifact.findUniqueOrThrow({
        where: { id },
      });
      const artifact = await predecessor.importArtifact.findUniqueOrThrow({
        where: { id: ref.artifactId! },
      });
      expect(ref).toMatchObject({
        state: "ATTACHED",
        reservedBytes: 0,
        temporaryStorageKey: null,
      });
      expect(artifact).toMatchObject({
        verifiedBytes: 1000,
        documentSha256: sha256Hex(payload),
      });
      const root = getVaultGate(predecessorApp).boot.runtime()!.config.rootDir;
      expect(await readStoredBlob(root, artifact.storageKey!)).toEqual(payload);
      files("predecessor:before-close", {
        artifactId: artifact.id,
        tenantId: world.tenantId,
      });
      await finishVaultFixture(
        predecessorApp.close.bind(predecessorApp),
        predecessorDatabase.close,
      );
      predecessorClosed = true;
      files("predecessor:closed");

      phase = "private-successor";
      successor = await foundationFixture();
      observe(successor.db, "private-successor");
      files("successor:admitted", { directory: successor.dir });
      expect(vaultTestDatabaseIsSafe(successor.db)).toBe(true);
      expect(await successor.db.importArtifact.count()).toBe(0);
      await successor.finish();
      successorClosed = true;
      files("successor:closed");

      phase = "quota";
      quotaDatabase = await createVaultTestDatabase();
      quota = quotaDatabase.setup;
      observe(quota, "quota-setup");
      files("quota:admitted", { database: quotaDatabase.file });
      expect(quotaDatabase.file).not.toBe(predecessorDatabase.file);
      const fk = await quota.$queryRaw<
        Array<{ foreign_keys: bigint }>
      >`PRAGMA foreign_keys`;
      expect(fk.map((row) => Number(row.foreign_keys))).toEqual([1]);
      const main = await seedImportWorld(quota, "quota-sequential");
      quotaApp = await bootVaultApp(quota, {
        writes: true,
        vault: CANONICAL_VAULT,
      });
      const orphans = async (
        scope: { tenantId: string; ownerProjectId: string },
        mib: number,
      ) => {
        for (let left = mib; left > 0; left -= 10)
          await seedArtifact(quota!, scope, {
            verifiedBytes: Math.min(left, 10) * MIB,
          });
      };
      for (let n = 0; n < 5; n++) {
        const other = await seedImportWorld(
          quota,
          `quota-sequential-global-${n}`,
        );
        await orphans(
          { tenantId: other.tenantId, ownerProjectId: other.projects.pessoal },
          200,
        );
      }
      await orphans(
        { tenantId: main.tenantId, ownerProjectId: main.projects.pessoal },
        14,
      );
      const physical = async () => {
        const rows = await quota!.$queryRaw<
          Array<{ kind: string; tenant: string; bytes: bigint }>
        >`
          SELECT 'artifact' AS kind, tenant_id AS tenant, SUM(verified_bytes) AS bytes
          FROM import_artifacts WHERE storage_key IS NOT NULL GROUP BY tenant_id
          UNION ALL SELECT 'temporary' AS kind, tenant_id AS tenant, SUM(reserved_bytes) AS bytes
          FROM import_session_artifacts WHERE temporary_storage_key IS NOT NULL GROUP BY tenant_id`;
        return rows.map((row) => ({ ...row, bytes: Number(row.bytes) }));
      };
      const token = await quotaApp.tokenFor(main.users.restricted);
      const attempt = async (sizes: number[]) => {
        const target = await seedSession(quota!, main, {
          ownerUserId: main.users.restricted.id,
        });
        const before = await fullDigest(quota!, target.id);
        const rows = await physical();
        const response = await reserve(
          quotaApp!,
          token,
          target.id,
          sizes.map((declaredBytes) => fileSeed({ declaredBytes })),
        );
        const after = await fullDigest(quota!, target.id);
        note("quota:attempt", {
          sizes,
          rows,
          sum: rows.reduce((sum, row) => sum + row.bytes, 0),
          response,
          before,
          after,
        });
        return { rows, response, before, after };
      };
      const over = await attempt([TEN_MIB, 1]);
      const exact = await attempt([TEN_MIB]);
      expect([over.response.status, over.response.json]).toEqual([
        422,
        wire("LIMIT_EXCEEDED"),
      ]);
      expect(over.after).toEqual(over.before);
      expect(exact.response.status).toBe(200);
      expect(exact.rows.reduce((sum, row) => sum + row.bytes, 0)).toBe(
        1063256064,
      );
    } catch (error) {
      primaryError = error;
      note("control:failure", {
        message: String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    } finally {
      phase = "cleanup";
      try {
        await finishVaultFixture(
          () => quotaApp?.close(),
          () => quotaDatabase?.close(),
          () => !successorClosed && successor?.finish(),
          () => !predecessorClosed && predecessorApp?.close(),
          () => !predecessorClosed && predecessorDatabase?.close(),
          ...spies.reverse().map((spy) => () => spy.mockRestore()),
          () => files("control:cleanup-complete"),
        );
      } catch (cleanupError) {
        note("cleanup:failure", {
          message: String(cleanupError),
          stack: cleanupError instanceof Error ? cleanupError.stack : undefined,
        });
        if (primaryError !== undefined)
          throw new AggregateError(
            [primaryError, cleanupError],
            "Sequential control and cleanup failed",
          );
        throw cleanupError;
      }
    }
  });
});

describe("isolated vault database cleanup controls", () => {
  it("a fresh world does not inherit the closed parent database or erase its retained charge", async () => {
    const previous = process.env.TEST_DATABASE_URL;
    const parent = await createVaultTestDatabase();
    let child: Awaited<ReturnType<typeof createVaultTestDatabase>> | undefined;
    let failure: unknown;
    try {
      const world = await seedImportWorld(
        parent.setup,
        "isolation-retained-owner",
      );
      const id = await seedArtifact(
        parent.setup,
        {
          tenantId: world.tenantId,
          ownerProjectId: world.projects.pessoal,
        },
        { verifiedBytes: 1000 },
      );
      const before = await parent.setup.importArtifact.findUniqueOrThrow({
        where: { id },
      });
      await parent.setup.$disconnect();
      child = await createVaultTestDatabase();
      expect(child.file).not.toBe(parent.file);
      expect(await child.setup.importArtifact.count()).toBe(0);
      const fk = await child.setup.$queryRaw<
        Array<{ foreign_keys: bigint }>
      >`PRAGMA foreign_keys`;
      expect(fk.map((row) => Number(row.foreign_keys))).toEqual([1]);
      await child.close();
      child = undefined;
      expect(process.env.TEST_DATABASE_URL).toBe(`file:${parent.file}`);
      await parent.setup.$connect();
      expect(
        await parent.setup.importArtifact.findUniqueOrThrow({ where: { id } }),
      ).toEqual(before);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      try {
        await finishVaultFixture(
          () => child?.close(),
          () => parent.close(),
        );
      } catch (cleanupError) {
        if (failure !== undefined)
          throw new AggregateError(
            [failure, cleanupError],
            "Isolation control and cleanup failed",
          );
        throw cleanupError;
      }
      expect(process.env.TEST_DATABASE_URL).toBe(previous);
    }
  });

  it("failed admission preserves the DB-file gate error and real disconnect error, then restores the environment", async () => {
    const previous = process.env.TEST_DATABASE_URL;
    const originalUrl = process.env.DATABASE_URL;
    const queries: string[] = [];
    const cleanupError = new Error("synthetic post-disconnect failure");
    const nativeConnect = PrismaService.prototype.$connect;
    const nativeDisconnect = PrismaService.prototype.$disconnect;
    let disconnects = 0;
    const spies: jest.SpyInstance[] = [];
    let unexpected:
      | Awaited<ReturnType<typeof createVaultTestDatabase>>
      | undefined;
    let assertionError: unknown;
    try {
      spies.push(
        jest
          .spyOn(PrismaService.prototype, "$connect")
          .mockImplementation(async function (this: PrismaService) {
            this.$use(async (params, next) => {
              queries.push(params.action);
              return next(params);
            });
            await nativeConnect.call(this);
          }),
      );
      spies.push(
        jest
          .spyOn(PrismaService.prototype, "$disconnect")
          .mockImplementation(async function (this: PrismaService) {
            await nativeDisconnect.call(this);
            if (++disconnects === 1) throw cleanupError;
          }),
      );
      spies.push(
        jest.spyOn(childProcess, "spawnSync").mockReturnValueOnce({
          pid: process.pid,
          output: [],
          stdout: "",
          stderr: "synthetic lsof unavailable",
          status: 1,
          signal: null,
        }),
      );
      let failure: unknown;
      try {
        unexpected = await createVaultTestDatabase();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) throw failure;
      expect(failure.errors).toEqual([
        expect.any(VaultFixtureDatabaseError),
        cleanupError,
      ]);
      expect(disconnects).toBe(2);
      expect(queries).toEqual([]);
      expect(process.env.TEST_DATABASE_URL).toBe(previous);
      expect(process.env.DATABASE_URL).toBe(originalUrl);
    } catch (error) {
      assertionError = error;
      throw error;
    } finally {
      try {
        await finishVaultFixture(
          ...spies.reverse().map((spy) => () => spy.mockRestore()),
          () => unexpected?.close(),
        );
      } catch (cleanupFailure) {
        if (assertionError !== undefined)
          throw new AggregateError(
            [assertionError, cleanupFailure],
            "Admission control and cleanup failed",
          );
        throw cleanupFailure;
      }
    }
  });

  it("close restores the parent URL even when a real completed disconnect reports a cleanup error", async () => {
    const previous = process.env.TEST_DATABASE_URL;
    const originalUrl = process.env.DATABASE_URL;
    const database = await createVaultTestDatabase();
    const native = database.setup.$disconnect.bind(database.setup);
    const error = new Error("synthetic close report after native disconnect");
    let disconnect: jest.SpyInstance | undefined;
    let assertionError: unknown;
    try {
      disconnect = jest
        .spyOn(database.setup, "$disconnect")
        .mockImplementation(async () => {
          await native();
          throw error;
        });
      await expect(database.close()).rejects.toMatchObject({
        errors: [error],
      });
      expect(process.env.TEST_DATABASE_URL).toBe(previous);
      expect(process.env.DATABASE_URL).toBe(originalUrl);
    } catch (failure) {
      assertionError = failure;
      throw failure;
    } finally {
      try {
        await finishVaultFixture(
          () => disconnect?.mockRestore(),
          () => database.close(),
        );
      } catch (cleanupError) {
        if (assertionError !== undefined)
          throw new AggregateError(
            [assertionError, cleanupError],
            "Close control and cleanup failed",
          );
        throw cleanupError;
      }
    }
  });
});

describe("G4 database-file evidence before seed and HTTP listen", () => {
  async function initializedEvidence(evidence: string, directory: string) {
    const records = await fsp.readdir(evidence);
    const after: unknown[] = [];
    for (const name of records.filter((value) => value.startsWith("http-"))) {
      const file = join(
        evidence,
        name,
        "initialized-before-listen-db-files.json",
      );
      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch (error) {
        if (
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
          continue;
        throw error;
      }
      const value = JSON.parse(raw);
      if (value.connectionEvidence === directory) after.push(value);
    }
    return after;
  }

  async function database() {
    const guard: {
      REPO_ROOT: string;
      TEST_DB_PATH: string;
      applyTestDatabaseUrl(): string;
    } = require("../../../../scripts/test-db-env.cjs");
    const scratch = join(guard.REPO_ROOT, ".agents/attachment-qa");
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(join(scratch, "db-gate-"));
    const file = join(dir, "test.db");
    await fsp.copyFile(guard.TEST_DB_PATH, file);
    await fsp.chmod(file, 0o600);
    await mkdir(join(dir, "other"), { mode: 0o700 });
    const unexpected = join(dir, "other/test.db");
    await fsp.copyFile(guard.TEST_DB_PATH, unexpected);
    await fsp.chmod(unexpected, 0o600);
    const previous = process.env.TEST_DATABASE_URL;
    process.env.TEST_DATABASE_URL = `file:${file}`;
    guard.applyTestDatabaseUrl();
    const setup = new PrismaService();
    return {
      file,
      unexpected,
      setup,
      async close() {
        await setup.$disconnect();
        if (previous === undefined) delete process.env.TEST_DATABASE_URL;
        else process.env.TEST_DATABASE_URL = previous;
        guard.applyTestDatabaseUrl();
      },
    };
  }

  it("G4 CONTROL positive evidence observes the actual expected SQLite file before seed and after real Nest init", async () => {
    const f = await database();
    let api: RecoveryApp | undefined;
    try {
      const directory = await connectVaultTestDatabase(f.setup);
      const evidence = dirname(directory);
      const incomplete = await mkdtemp(join(evidence, "http-incomplete-"));
      const missing = join(
        incomplete,
        "initialized-before-listen-db-files.json",
      );
      let nativeError: unknown;
      try {
        await readFile(missing, "utf8");
      } catch (error) {
        nativeError = error;
      }
      expect(nativeError).toMatchObject({ code: "ENOENT", path: missing });
      await fsp.writeFile(
        join(incomplete, "native-enoent.json"),
        JSON.stringify({
          pid: process.pid,
          missing,
          localInstanceOfError: nativeError instanceof Error,
          tag: Object.prototype.toString.call(nativeError),
          message: String(nativeError),
          nativeError,
        }),
        { mode: 0o600 },
      );
      const first = JSON.parse(
        await readFile(
          join(directory, "connected-before-seed-db-files.json"),
          "utf8",
        ),
      );
      expect(first).toMatchObject({
        phase: "connected-before-seed",
        pid: process.pid,
        status: 0,
        observed: expect.arrayContaining([canonicalDir(f.file)]),
        failure: null,
      });
      expect(first.allowed).toEqual([
        canonicalDir(f.file),
        `${canonicalDir(f.file)}-journal`,
        `${canonicalDir(f.file)}-wal`,
        `${canonicalDir(f.file)}-shm`,
      ]);
      await f.setup.tenant.create({
        data: { id: randomUUID(), name: "Synthetic after evidence" },
      });
      api = await bootVaultApp(f.setup, { writes: false, vault: "real" });
      expect(api.app.getHttpServer().listening).toBe(true);
      expect(vaultTestDatabaseIsSafe(f.setup)).toBe(true);
      const after = await initializedEvidence(evidence, directory);
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({
        phase: "initialized-before-listen",
        status: 0,
        observed: expect.arrayContaining([canonicalDir(f.file)]),
        failure: null,
      });
    } finally {
      await api?.close();
      await f.close();
    }
  });

  it.each(["directory", "invalid-json"] as const)(
    "G4 CONTROL evidence scan propagates real %s errors instead of treating them as incomplete attempts",
    async (fault) => {
      await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
      const scope = await mkdtemp(join(evidenceRoot, "scan-control-"));
      const attempt = join(scope, "http-attempt");
      await mkdir(attempt, { mode: 0o700 });
      const file = join(attempt, "initialized-before-listen-db-files.json");
      if (fault === "directory") await mkdir(file, { mode: 0o700 });
      else await fsp.writeFile(file, "{invalid", { mode: 0o600 });
      const scan = initializedEvidence(scope, "unrelated-connection");
      if (fault === "directory")
        await expect(scan).rejects.toMatchObject({ code: "EISDIR" });
      else await expect(scan).rejects.toBeInstanceOf(SyntaxError);
    },
  );

  it.each(
    (["connected-before-seed", "initialized-before-listen"] as const).flatMap(
      (phase) =>
        (["unexpected", "unavailable", "ambiguous"] as const).map((fault) => ({
          phase,
          fault,
        })),
    ),
  )(
    "G4 CONTROL $phase fails closed for $fault capture without seed, SQL cleanup or DB copy",
    async ({ phase, fault }) => {
      const f = await database();
      const queries: string[] = [];
      f.setup.$use(async (params, next) => {
        queries.push(params.action);
        return next(params);
      });
      let handle: FileHandle | undefined;
      let capture: jest.SpyInstance | undefined;
      let init: jest.SpyInstance | undefined;
      const listen = jest.spyOn(NestApplication.prototype, "listen");
      const copy = jest.spyOn(fsp, "copyFile");
      const seed = jest.fn(async () => {
        await f.setup.tenant.create({
          data: { id: randomUUID(), name: "Must not seed" },
        });
      });
      const inject = async () => {
        if (fault === "unexpected") handle = await fsp.open(f.unexpected, "r");
        else {
          capture = jest.spyOn(childProcess, "spawnSync").mockReturnValueOnce({
            pid: process.pid,
            output: [],
            stdout:
              fault === "ambiguous"
                ? `p${process.pid}\0\nf101\0tREG\0n${canonicalDir(f.file)}\0\nf102\0n${canonicalDir(f.unexpected)}\0\n`
                : "",
            stderr: fault === "unavailable" ? "synthetic capture failure" : "",
            status: fault === "unavailable" ? 1 : 0,
            signal: null,
          });
        }
      };
      try {
        let failure: unknown;
        if (phase === "connected-before-seed") {
          await inject();
          try {
            await connectVaultTestDatabase(f.setup);
            await seed();
          } catch (error) {
            failure = error;
          }
        } else {
          await connectVaultTestDatabase(f.setup);
          const nativeInit = PrismaService.prototype.onModuleInit;
          init = jest
            .spyOn(PrismaService.prototype, "onModuleInit")
            .mockImplementation(async function (this: PrismaService) {
              this.$use(async (params, next) => {
                queries.push(params.action);
                return next(params);
              });
              await nativeInit.call(this);
              await inject();
            });
          try {
            const api = await bootVaultApp(f.setup, {
              vault: "real",
              writes: false,
            });
            await api.close();
            await seed();
          } catch (error) {
            failure = error;
          }
        }
        expect(failure).toBeInstanceOf(VaultFixtureDatabaseError);
        expect(vaultTestDatabaseIsSafe(f.setup)).toBe(false);
        expect(listen).not.toHaveBeenCalled();
        expect(seed).not.toHaveBeenCalled();
        expect(queries).toEqual([]);
        expect(copy).not.toHaveBeenCalled();
        expect(failure).toEqual(
          expect.objectContaining({
            message: expect.stringContaining("evidence:"),
          }),
        );
      } finally {
        capture?.mockRestore();
        init?.mockRestore();
        listen.mockRestore();
        copy.mockRestore();
        await handle?.close();
        await f.close();
      }
    },
  );
});

/** The fixtures the vault REDs stand on must be right, or every "200" assertion is blind. */
describe("vault harness fixtures", () => {
  it("CONTROL canonical fixture uses the real boot, real borrowed FD and real private filesystem", async () => {
    const fixture = await canonicalVaultFixture();
    try {
      const boot = fixture.startBoot();
      await boot.settled;
      expect(boot.state()).toBe("ON");
      expect(boot.runtime()?.config.rootDir).toBe(fixture.root);
      expect(boot.runtime()?.lockIdentity).toEqual({
        dev: fixture.identity.dev,
        ino: fixture.identity.ino,
      });
      expect(await fixture.borrowed.stat({ bigint: true })).toMatchObject({
        dev: fixture.identity.dev,
        ino: fixture.identity.ino,
      });
      expect(fixture.env.IMPORT_VAULT_DRAIN_TIMEOUT_MS).toBe("37");
      expect(fixture.borrowed.fd).toBeGreaterThanOrEqual(3);
    } finally {
      await fixture.close();
    }
    expect(fixture.borrowed.fd).toBe(-1);
  });

  it.each([
    "FLAG_OFF",
    "NO_LOCK_FD",
    "HEADROOM_UNSET",
    "IDLE_TIMEOUT_UNSET",
  ] as const)(
    "CONTROL %s is induced through canonical configuration, not a state-only ON/OFF object",
    async (reason) => {
      const fixture = await canonicalVaultFixture();
      try {
        fixture.arrangeOff(reason);
        const boot = fixture.startBoot();
        await boot.settled;
        expect(boot.state()).toBe("OFF");
        expect(boot.reason).toBe(reason);
        expect(boot.runtime()).toBeNull();
        expect(fixture.borrowed.fd).toBeGreaterThanOrEqual(3);
      } finally {
        await fixture.close();
      }
    },
  );
  it.each([400, 401, 999, 1000, 65_536, 10_485_760])(
    "pdfBytes(%i) is exactly that long, sniffs as PDF, ends with %%%%EOF and points startxref at the xref table",
    (size) => {
      const pdf = pdfBytes(size, "s");
      expect(pdf.length).toBe(size);
      expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(pdf.subarray(-6).toString("latin1")).toBe("%%EOF\n");
      const text = pdf.toString("latin1");
      const offset = Number(/startxref\n(\d+)/.exec(text)![1]);
      expect(text.slice(offset, offset + 4)).toBe("xref");
    },
  );

  it("a different salt gives a different sha256 of the same size", () => {
    expect(sha256Hex(pdfBytes(1000, "a"))).not.toBe(
      sha256Hex(pdfBytes(1000, "b")),
    );
    expect(sha256Hex(pdfBytes(1000, "a"))).toBe(sha256Hex(pdfBytes(1000, "a")));
  });

  describe("spyVaultOpen: the instrument the slot-until-close spec stands on", () => {
    let root: string;
    beforeEach(async () => {
      root = canonicalDir(await mkdtemp(join(tmpdir(), "rf-b2a-spy-")));
    });
    afterEach(async () => {
      const evidence = process.env.VAULT_ATTACHMENT_TEST_EVIDENCE_DIR;
      if (evidence) {
        await mkdir(evidence, { recursive: true, mode: 0o700 });
        cpSync(root, join(evidence, basename(root)), {
          recursive: true,
          dereference: false,
          verbatimSymlinks: true,
        });
      }
      await rm(root, { recursive: true, force: true });
    });

    it("sees a NAMED import of fs/promises.open under <root>/t/<refId>/, holds the handle's close, and leaves other paths alone", async () => {
      const refId = randomUUID();
      await mkdir(join(root, "t", refId, "g2"), { recursive: true });
      const seen: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let closeEntered = false;
      const spy = spyVaultOpen(root, (id, handle) => {
        seen.push(id);
        const close = handle.close.bind(handle);
        handle.close = async () => {
          closeEntered = true;
          await gate;
          return close();
        };
      });
      try {
        const file = join(root, "t", refId, "g2", "blob");
        const handle = await namedOpen(file, "wx");
        await handle.write(Buffer.from("abc"));
        const closing = handle.close();
        await new Promise((r) => setTimeout(r, 30));
        expect(closeEntered).toBe(true);
        let done = false;
        void closing.then(() => (done = true));
        await new Promise((r) => setTimeout(r, 30));
        expect(done).toBe(false); // held: the FD is still open
        release();
        await closing;
        expect(seen).toEqual([refId]);
        expect(
          (await readStoredBlob(root, `t/${refId}/g2/blob`)).toString(),
        ).toBe("abc");
        const other = await namedOpen(join(root, "other"), "wx");
        await other.close();
        expect(seen).toEqual([refId]);
      } finally {
        release();
        spy.mockRestore();
      }
      expect(await readFile(join(root, "other"), "utf8")).toBe("");
    });
  });
});
