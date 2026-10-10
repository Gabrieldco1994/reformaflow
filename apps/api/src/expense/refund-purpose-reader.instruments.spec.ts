/**
 * #704 reader — measurement instruments (no GET exists yet; nothing here asserts the future reader).
 * Everything characterizes CODE THAT ALREADY EXISTS (POST preview + `loadRefundFacts`) so the
 * RD8/RG8 contract can be written from measured facts instead of from wishes.
 *
 *  PROBE-1  a preview held inside its `$transaction` blocks an independent writer; releasing frees it.
 *           Barrier = a call-through spy on `RemovalContext.prototype.loadSettlements` that parks
 *           INSIDE the open transaction. Observer = the installed `sqlite3` CLI on the disposable
 *           worker database, running only `BEGIN IMMEDIATE; ROLLBACK;` with a bounded busy timeout,
 *           FKs ON. No financial DML anywhere in the window.
 *  PROBE-2  >900 DISTINCT ids really reach a loader (arguments AND bound SQL parameters), per-loader
 *           call/statement budgets, empty input => zero statements, cache => zero repeat statements.
 *
 * Safety: the spec refuses to run unless DATABASE_URL is a disposable worker/test database inside this
 * worktree (scripts/test-db-env.cjs is already applied by jest `setupFiles`). Nothing touches dev.db.
 * Set P704_EVIDENCE_DIR to persist the traces (mode 0600).
 */
jest.mock("@prisma/client", () => {
  const actual = jest.requireActual("@prisma/client");
  class LoggingPrismaClient extends actual.PrismaClient {
    constructor(options: Record<string, unknown> = {}) {
      super({ ...options, log: [{ emit: "event", level: "query" }] });
    }
  }
  return { ...actual, PrismaClient: LoggingPrismaClient };
});

import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import { APIRequestContext, request } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { execFile } from "child_process";
import { existsSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { promisify } from "util";
import {
  resetTenant,
  seedCardWithClosingDue,
  seedPessoal,
} from "../bank-account/__tests__/invoice-undo.fixtures";
import { JwtStrategy } from "../auth/jwt.strategy";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import { ModulesGuard } from "../common/guards/modules.guard";
import { ProjectAccessGuard } from "../common/guards/project-access.guard";
import { RolesGuard } from "../common/guards/roles.guard";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { ExpenseModule } from "./expense.module";
import { RefundPurposePrivacyInterceptor } from "./refund-purpose-privacy.interceptor";
import { loadRefundFacts, RemovalContext } from "./removal-context";

const exec = promisify(execFile);
const T = "instr-red";
const P = `${T}-personal`;
const R = `${T}-renovation`;
const C = `${T}-third`;
const OWNER = `${T}-owner`;
const SRC = "instr-source";
const DATE = new Date("2026-09-10T00:00:00Z");
const LOADERS = [
  "loadExpenses",
  "loadProjects",
  "loadReferencedProjects",
  "loadAllocations",
  "loadSettlements",
  "loadIncoming",
  "loadCashflow",
  "loadLedgerByExpense",
  "loadLedgerByCashFlow",
  "loadFinancing",
  "loadMarkers",
  "loadImports",
  "loadCards",
  "loadRooms",
] as const;

describe("#704 reader measurement instruments (existing code only)", () => {
  const db = new PrismaClient();
  const prisma = new PrismaService();
  const events: Array<{ query: string; params: string }> = [];
  let sentinels = 0;
  (prisma as any).$on("query", (e: { query: string; params: string }) => {
    if (e.params.includes("p704-sentinel")) {
      sentinels += 1;
      events.push({ query: "SENTINEL", params: "" });
    } else events.push({ query: e.query, params: e.params });
  });
  // A sentinel is issued last on the given client and awaited; once it is logged every earlier statement
  // is logged too (one connection, ordered log). Sentinels and barrier waits are NOT natural latency.
  const flush = async (client: { $queryRaw: PrismaService["$queryRaw"] } = prisma) => {
    const seen = sentinels;
    await client.$queryRaw`SELECT ${`p704-sentinel-${seen + 1}`} AS s`;
    for (let waited = 0; sentinels === seen && waited < 2000; waited += 5) await new Promise((r) => setTimeout(r, 5));
    expect(sentinels).toBe(seen + 1);
  };
  const isTx = (q: string) => /^(BEGIN|COMMIT|ROLLBACK)/.test(q);
  const isDml = (q: string) => /^(INSERT|UPDATE|DELETE)/.test(q);
  // Everything that is not a tx marker, DML or the identified sentinel is a read, even a SELECT without FROM.
  const readEvents = () => events.filter((e) => e.query !== "SENTINEL" && !isTx(e.query) && !isDml(e.query));
  let app: INestApplication;
  let jwt: JwtService;
  let client: APIRequestContext | undefined;
  let cardId: string;
  let importId: string;
  const evidence: Record<string, unknown> = {};

  const dbPath = () => {
    const url = process.env.DATABASE_URL ?? "";
    const path = url.replace(/^file:/, "").split("?")[0];
    return path;
  };
  const assertDisposableDb = () => {
    const path = dbPath();
    const name = basename(path);
    expect(name).not.toBe("dev.db");
    expect(name).toMatch(/^test(-worker-[\w-]+)?\.db$/);
    expect(path).toContain(`${join("prisma", name)}`);
    expect(existsSync(path)).toBe(true);
  };
  const tableOf = (query: string) => (query.match(/FROM `main`\.`(\w+)`/) ?? [])[1] ?? "(no FROM)";
  const idsOf = (params: string) => {
    try {
      return (JSON.parse(params) as unknown[]).filter(
        (value): value is string => typeof value === "string" && /^instr-(source|src-|peer-|cfe-)/.test(value),
      );
    } catch {
      return [];
    }
  };
  const persist = (name: string) => {
    const dir = process.env.P704_EVIDENCE_DIR;
    if (!dir) return;
    writeFileSync(join(dir, `${name}-${(process.env.TZ ?? "local").replace(/\//g, "_")}.json`), JSON.stringify(evidence, null, 1), { mode: 0o600 });
  };

  const seed = async () => {
    await db.user.deleteMany({ where: { tenantId: T } });
    await resetTenant(db, T);
    await seedPessoal(db, { tenantId: T, projectId: P });
    for (const [id, type] of [[R, "REFORMA"], [C, "CASA"]] as const)
      await db.project.create({ data: { id, tenantId: T, type, name: id } });
    await db.user.create({
      data: { id: OWNER, tenantId: T, role: "OWNER", username: "owner", name: "Owner", lastActivityAt: new Date() },
    });
    const card = await seedCardWithClosingDue(db, { tenantId: T, projectId: P, last4: "1234" });
    cardId = card.id;
    importId = (
      await db.creditCardStatementImport.create({
        data: { tenantId: T, cardId, source: "CSV_GENERIC", periodLabel: "2026-09", status: "COMPLETED" },
      })
    ).id;
    await db.expense.create({
      data: {
        id: SRC, tenantId: T, projectId: P, tipoDespesa: "MATERIAL_CONSTRUCAO", valor: -12345, valorTotal: -12345,
        quantidade: 1, formaPagamento: "A_VISTA", status: "PAGO", origin: "import", cardLast4: card.last4, importId,
        externalId: "instr-refund", dataPagamento: DATE, dataCompra: new Date("2026-08-26T00:00:00Z"),
      },
    });
    await db.cashFlowEntry.create({
      data: {
        tenantId: T, projectId: P, expenseId: SRC, valor: -12345, tipo: "DESPESA", data: DATE, categoria: "Material",
        formaPagamento: "CARTAO_CREDITO", status: "PAGO",
      },
    });
  };
  const expenseRow = (id: string, projectId: string, extra: Record<string, unknown> = {}) => ({
    id, tenantId: T, projectId, tipoDespesa: "OUTROS", valor: 100, valorTotal: 100, quantidade: 1,
    formaPagamento: "A_VISTA", status: "PLANEJADO", ...extra,
  });
  const pad = (n: number) => String(n).padStart(4, "0");

  beforeAll(async () => {
    assertDisposableDb();
    const module = await Test.createTestingModule({ imports: [PrismaModule, ExpenseModule], providers: [JwtStrategy] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = module.createNestApplication();
    app.useLogger(false);
    const reflector = new Reflector();
    app.useGlobalGuards(
      new JwtAuthGuard(reflector),
      new RolesGuard(reflector),
      new ModulesGuard(reflector, prisma),
      new ProjectAccessGuard(prisma, reflector),
    );
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    app.useGlobalInterceptors(new RefundPurposePrivacyInterceptor(prisma));
    await app.listen(0, "127.0.0.1");
    jwt = new JwtService({ secret: process.env.JWT_SECRET || "dev-secret-change-me" });
  });
  beforeEach(async () => {
    await seed();
    events.length = 0;
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await client?.dispose();
    client = undefined;
  });
  afterAll(async () => {
    await db.user.deleteMany({ where: { tenantId: T } });
    await resetTenant(db, T);
    await app.close();
    await prisma.$disconnect();
    await db.$disconnect();
  });

  const http = async () => {
    client ??= await request.newContext({
      baseURL: await app.getUrl(),
      extraHTTPHeaders: { Authorization: `Bearer ${jwt.sign({ sub: OWNER, tenantId: T, sv: 0 })}` },
    });
    return client;
  };

  // ------------------------------------------------------------------ PROBE-1
  it("PROBE-1 a preview parked inside its transaction blocks an independent writer; releasing it frees the writer", async () => {
    assertDisposableDb();
    const path = dbPath();
    const trace: Array<Record<string, unknown>> = [];
    const started = Date.now();
    const mark = (step: string, extra: Record<string, unknown> = {}) => trace.push({ atMs: Date.now() - started, step, ...extra });

    const version = (await exec("sqlite3", ["--version"])).stdout.trim();
    const [{ v }] = await prisma.$queryRaw<Array<{ v: string }>>`SELECT sqlite_version() AS v`;
    const [{ journal_mode }] = await prisma.$queryRaw<Array<{ journal_mode: string }>>`PRAGMA journal_mode`;
    const [{ foreign_keys }] = await prisma.$queryRaw<Array<{ foreign_keys: bigint | number }>>`PRAGMA foreign_keys`;
    const compileOptions = (await prisma.$queryRaw<Array<{ compile_options: string }>>`PRAGMA compile_options`).map((r) => r.compile_options);
    expect(Number(foreign_keys)).toBe(1);

    const observerArgs = ["-bail", "-cmd", ".timeout 300", "-cmd", "PRAGMA foreign_keys=ON;", path, "BEGIN IMMEDIATE; ROLLBACK;"];
    const observe = async (label: string) => {
      const at = Date.now();
      try {
        const done = await exec("sqlite3", observerArgs, { timeout: 5000 });
        mark(label, { exit: 0, ms: Date.now() - at, stdout: done.stdout.trim(), stderr: done.stderr.trim() });
        return { exit: 0, stderr: done.stderr.trim() };
      } catch (error: any) {
        mark(label, { exit: error.code, ms: Date.now() - at, stderr: String(error.stderr ?? "").trim() });
        return { exit: error.code as number, stderr: String(error.stderr ?? "") };
      }
    };

    let entered!: () => void;
    const inTx = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = RemovalContext.prototype.loadSettlements;
    let parked = false;
    jest.spyOn(RemovalContext.prototype, "loadSettlements").mockImplementation(async function (this: RemovalContext, ...args: any[]) {
      parked = true;
      entered();
      await Promise.race([gate, new Promise((resolve) => setTimeout(resolve, 10_000))]);
      return (original as any).apply(this, args);
    });

    const idle = await observe("observer-idle-before");
    expect(idle.exit).toBe(0);

    events.length = 0;
    const api = await http();
    let preview: Promise<{ status: number }> | undefined;
    try {
      preview = api
        .post(`/projects/${P}/expenses/${SRC}/refund-purpose`, { data: { mode: "preview", targetProjectId: R, roomId: null } })
        .then((response) => ({ status: response.status() }));
      await Promise.race([inTx, new Promise((_, reject) => setTimeout(() => reject(new Error("barrier never reached")), 8000))]);
      mark("preview-parked-inside-transaction");
      expect(parked).toBe(true);
      const held = await observe("observer-while-held");
      expect(held.exit).not.toBe(0);
      expect(held.stderr).toMatch(/database is locked/i);
      const stillHeld = await Promise.race([preview.then(() => "done"), new Promise((r) => setTimeout(() => r("pending"), 20))]);
      expect(stillHeld).toBe("pending");
      mark("preview-still-pending-after-observer");
    } finally {
      release();
    }
    const response = await preview!;
    mark("preview-finished", { status: response.status });
    expect(response.status).toBe(201);
    const freed = await observe("observer-after-release");
    expect(freed.exit).toBe(0);
    await flush();

    const statements = events.map((e) => e.query.split(/\s+/).slice(0, 4).join(" ").slice(0, 60));
    const dml = events.filter((e) => isDml(e.query));
    expect(dml).toEqual([]);
    expect(events.some((e) => e.query === "BEGIN IMMEDIATE")).toBe(true);
    Object.assign(evidence, {
      probe1: {
        command: ["sqlite3", ...observerArgs.map((a) => (a === path ? "<worker-db>" : a))],
        versions: { sqlite3Cli: version, prismaEngineSqlite: v, node: process.version },
        journal_mode, foreignKeys: Number(foreign_keys), dbFile: basename(path), compileOptions,
        note: "barrier/sentinel timings are not natural latency; nothing here is a production limit",
        trace, transactionOpening: events.filter((e) => /^(BEGIN|COMMIT|ROLLBACK)/.test(e.query)).map((e) => e.query),
        dmlStatements: dml.length, statementHeads: statements,
      },
    });
    persist("rd8-probe1-writer-lock");
  }, 60_000);

  // ------------------------------------------------------------------ PROBE-2
  type Interval = { loader: string; start: number; end: number };
  type LoaderCall = { loader: string; ids: number; distinct: number };
  // Call-through spies. Each loader is bracketed by two sentinels ISSUED ON ITS OWN tx CLIENT, so the
  // statements between them are attributed to that loader by log position (innermost interval wins for
  // nested loaders), not inferred from table names.
  const spyLoaders = () => {
    const calls: LoaderCall[] = [];
    const intervals: Interval[] = [];
    for (const name of LOADERS) {
      const original = (RemovalContext.prototype as any)[name];
      jest.spyOn(RemovalContext.prototype as any, name).mockImplementation(async function (this: RemovalContext, ...args: any[]) {
        const ids = (args[1] ?? []) as string[];
        calls.push({ loader: name, ids: ids.length, distinct: new Set(ids).size });
        await flush(args[0]);
        const start = events.length;
        try {
          return await original.apply(this, args);
        } finally {
          await flush(args[0]);
          intervals.push({ loader: name, start, end: events.length - 1 });
        }
      });
    }
    return { calls, intervals };
  };
  type Statement = { cols: string[]; params: number; distinct: number };
  const statementsOf = (list: Array<{ query: string; params: string }> = readEvents()) => {
    const out: Record<string, Statement[]> = {};
    for (const e of list) {
      const table = tableOf(e.query);
      const ids = idsOf(e.params);
      let all = 0;
      try {
        all = (JSON.parse(e.params) as unknown[]).length;
      } catch {
        all = -1;
      }
      const cols = [...e.query.matchAll(/`main`\.`\w+`\.`(\w+)` IN \(/g)].map((m) => m[1]);
      (out[table] ??= []).push({ cols, params: all, distinct: new Set(ids).size });
    }
    return out;
  };
  const perTable = (list?: Array<{ query: string; params: string }>) => {
    const out: Record<string, { statements: number; maxParams: number; maxDistinct: number; shape: string[]; distinct: number[] }> = {};
    for (const [table, rows] of Object.entries(statementsOf(list)))
      out[table] = {
        statements: rows.length,
        maxParams: Math.max(...rows.map((s) => s.params)),
        maxDistinct: Math.max(...rows.map((s) => s.distinct)),
        shape: rows.map((s) => `${s.cols.join("+")}:${s.distinct}/${s.params}`),
        distinct: rows.map((s) => s.distinct),
      };
    return out;
  };
  const perLoader = (calls: LoaderCall[]) => {
    const out: Record<string, { calls: number; maxDistinct: number }> = {};
    for (const call of calls) {
      const bucket = (out[call.loader] ??= { calls: 0, maxDistinct: 0 });
      bucket.calls += 1;
      bucket.maxDistinct = Math.max(bucket.maxDistinct, call.distinct);
    }
    return out;
  };
  const attribute = (intervals: Interval[]) => {
    const out: Record<string, number> = {};
    events.forEach((e, index) => {
      if (e.query === "SENTINEL" || isTx(e.query) || isDml(e.query)) return;
      const owner = intervals
        .filter((i) => i.start <= index && index < i.end)
        .sort((x, y) => y.start - x.start)[0];
      const key = owner?.loader ?? "(outside loaders)";
      out[key] = (out[key] ?? 0) + 1;
    });
    return out;
  };

  it("PROBE-2a preview with 950 distinct participants: 950 ids reach loadExpenses and are chunked at 900 without repeats", async () => {
    assertDisposableDb();
    const peers = Array.from({ length: 950 }, (_, i) => expenseRow(`instr-peer-${pad(i)}`, C));
    await db.expense.createMany({ data: peers });
    await db.rateioAllocation.createMany({
      data: peers.map((peer) => ({ tenantId: T, sourceExpenseId: SRC, targetExpenseId: peer.id, allocation: 100, plannedStatus: "PLANEJADO" })),
    });
    const { calls, intervals } = spyLoaders();
    await flush();
    events.length = 0;
    intervals.length = 0;
    const api = await http();
    const response = await api.post(`/projects/${P}/expenses/${SRC}/refund-purpose`, {
      data: { mode: "preview", targetProjectId: R, roomId: null },
    });
    await flush();
    expect(response.status()).toBe(409);
    const loaders = perLoader(calls);
    const tables = perTable();
    const byLoader = attribute(intervals);
    Object.assign(evidence, { probe2a: { httpStatus: response.status(), loaders, tables, statementsByLoader: byLoader } });
    persist("rd8-probe2a-950-participants");
    // Characterization of the EXISTING preview path; the future GET budget is not derived from it.
    expect(loaders.loadExpenses).toEqual({ calls: 3, maxDistinct: 951 });
    expect(tables["(no FROM)"]).toBeUndefined();
    expect(Object.fromEntries(Object.entries(tables).filter(([k]) => !["users", "tenants", "projects"].includes(k)).map(([k, v]) => [k, v.statements]))).toEqual({
      expenses: 4, rateio_allocations: 1, cash_flow_entries: 1, cross_project_settlements: 1, imported_invoice_liquidations: 2,
      financing_installments: 1, floor_plan_markers: 1, credit_card_imports: 1, credit_cards: 1,
    });
    expect(tables.expenses.distinct).toEqual([1, 1, 900, 50]);
    expect(tables.expenses.maxParams).toBe(902);
    const flat = events.filter((e) => tableOf(e.query) === "expenses" && /`id` IN/.test(e.query)).flatMap((e) => idsOf(e.params));
    expect(new Set(flat).size).toBe(flat.length);
    expect(flat.length).toBe(951);
    expect(events.filter((e) => isDml(e.query))).toEqual([]);
    expect(byLoader.loadExpenses).toBe(3);
  }, 120_000);

  it("PROBE-2b 1000 distinct sources through loadRefundFacts: every id-bearing loader receives >900 ids, empty input costs no statement, a second identical load costs none", async () => {
    assertDisposableDb();
    const sources = Array.from({ length: 1000 }, (_, i) => expenseRow(`instr-src-${pad(i)}`, P, { importId, cardLast4: "1234" }));
    await db.expense.createMany({ data: sources });
    await db.cashFlowEntry.createMany({
      data: sources.map((s) => ({
        id: `instr-cfe-${s.id.slice(-4)}`, tenantId: T, projectId: P, expenseId: s.id, valor: 100, tipo: "DESPESA", data: DATE,
        categoria: "Outros", formaPagamento: "CARTAO_CREDITO", status: "PLANEJADO",
      })),
    });
    const ids = sources.map((s) => s.id);
    const { calls, intervals } = spyLoaders();
    const ctx = new RemovalContext(T);
    await flush();
    events.length = 0;
    await prisma.$transaction(async (tx) => {
      await loadRefundFacts(tx as any, ctx, ids, {});
    });
    await flush();
    const first = { loaders: perLoader(calls), tables: perTable(), byLoader: attribute(intervals) };
    calls.length = 0;
    intervals.length = 0;
    events.length = 0;
    await prisma.$transaction(async (tx) => {
      await loadRefundFacts(tx as any, ctx, ids, {});
    });
    await flush();
    const second = { statements: readEvents().length, tables: perTable(), loaders: perLoader(calls), byLoader: attribute(intervals) };
    Object.assign(evidence, { probe2b: { sources: ids.length, first, second } });
    persist("rd8-probe2b-1000-sources");
    // Characterization of the EXISTING loaders (chunk = 900); it does not authorize a GET budget.
    expect(Object.fromEntries(Object.entries(first.loaders).map(([k, v]) => [k, `${v.calls}x${v.maxDistinct}`]))).toEqual({
      loadExpenses: "3x1000", loadAllocations: "2x1000", loadCashflow: "1x1000", loadIncoming: "1x1000", loadSettlements: "1x1000",
      loadLedgerByExpense: "1x1000", loadLedgerByCashFlow: "1x1000", loadFinancing: "1x1000", loadMarkers: "1x1000",
      loadImports: "1x1", loadCards: "1x1", loadRooms: "1x0", loadReferencedProjects: "1x0", loadProjects: "1x1",
    });
    // Statements per loader by log position (bracketing sentinels), not by table inference.
    expect(first.byLoader).toEqual({
      loadExpenses: 2, loadAllocations: 2, loadCashflow: 2, loadIncoming: 2, loadSettlements: 2, loadLedgerByExpense: 2,
      loadLedgerByCashFlow: 2, loadFinancing: 2, loadMarkers: 2, loadImports: 1, loadCards: 1, loadProjects: 1,
    });
    expect(first.tables["(no FROM)"]).toBeUndefined();
    expect(first.tables.rooms).toBeUndefined();
    expect(Object.fromEntries(Object.entries(first.tables).map(([k, v]) => [k, v.statements]))).toEqual({
      expenses: 4, rateio_allocations: 2, cash_flow_entries: 2, cross_project_settlements: 2, imported_invoice_liquidations: 4,
      financing_installments: 2, floor_plan_markers: 2, credit_card_imports: 1, credit_cards: 1, projects: 1,
    });
    expect(first.tables.expenses.distinct).toEqual([900, 100, 900, 100]);
    for (const table of ["rateio_allocations", "cash_flow_entries", "cross_project_settlements", "financing_installments", "floor_plan_markers"])
      expect({ table, distinct: first.tables[table].distinct }).toEqual({ table, distinct: [900, 100] });
    expect(first.tables.imported_invoice_liquidations.distinct).toEqual([900, 100, 900, 100]);
    expect(Math.max(...Object.values(first.tables).map((v) => v.maxParams))).toBe(2703);
    expect(second.statements).toBe(0);
    expect(second.byLoader).toEqual({});
    expect(events.filter((e) => isDml(e.query))).toEqual([]);
  }, 180_000);
});
