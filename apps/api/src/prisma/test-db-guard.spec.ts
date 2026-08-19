/**
 * Testa a própria trava que impede a suíte de escrever no dev.db real.
 * Ver scripts/test-db-env.cjs.
 */
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const guard = require("../../../../scripts/test-db-env.cjs");

// A trava precisa aplicar ANTES de o PrismaClient ser importado.
// eslint-disable-next-line import/first
import { PrismaClient } from "@prisma/client";

describe("trava de DATABASE_URL em testes", () => {
  it("a suíte roda contra o banco descartável do worktree, nunca o dev.db", () => {
    expect(process.env.DATABASE_URL).toBe(guard.ACTIVE_DB_URL);
    expect(path.basename(guard.TEST_DB_PATH)).not.toBe("dev.db");
    expect(path.basename(guard.ACTIVE_DB_PATH)).not.toBe("dev.db");
    expect(guard.TEST_DB_PATH.startsWith(guard.REPO_ROOT)).toBe(true);
    expect(guard.ACTIVE_DB_PATH.startsWith(guard.REPO_ROOT)).toBe(true);
  });

  it("recusa qualquer URL que aponte para um dev.db", () => {
    expect(
      guard.forbiddenReason("file:/Users/alguem/reformaflow/prisma/dev.db"),
    ).toMatch(/dev\.db/);
    expect(guard.forbiddenReason("file:./dev.db")).toMatch(/dev\.db/);
    expect(guard.forbiddenReason("file:dev.db")).toMatch(/dev\.db/);
    expect(guard.forbiddenReason("file:DEV.DB")).toMatch(/dev\.db/);
    expect(guard.forbiddenReason("file:DeV.dB")).toMatch(/dev\.db/);
  });

  it("recusa alias cujo caminho real tem basename dev.db sem diferenciar maiúsculas", () => {
    const directory = fs.mkdtempSync(
      path.join(guard.REPO_ROOT, "prisma", "guard-canonical-devdb-"),
    );
    const target = path.join(directory, "dEv.Db");
    const alias = path.join(directory, "alias.db");
    fs.writeFileSync(target, "");
    fs.symlinkSync(target, alias);
    try {
      expect(path.basename(guard.resolveSqlitePath(`file:${alias}`))).toBe(
        "alias.db",
      );
      expect(path.basename(guard.resolveRealSqlitePath(`file:${alias}`))).toBe(
        "dEv.Db",
      );
      expect(guard.forbiddenReason(`file:${alias}`)).toMatch(/dev\.db/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recusa URL apontando para fora do worktree atual", () => {
    expect(
      guard.forbiddenReason("file:/tmp/outro-checkout/prisma/test.db"),
    ).toMatch(/fora do worktree/);
    expect(guard.resolveSqlitePath("file://tmp/outside.db")).toBe(
      "/tmp/outside.db",
    );
    expect(guard.forbiddenReason("file://tmp/outside.db")).toMatch(
      /fora do worktree/,
    );
  });

  it("aceita o banco de teste do worktree", () => {
    expect(guard.forbiddenReason(guard.TEST_DB_URL)).toBeNull();
    expect(guard.forbiddenReason("file:test.db")).toBeNull();
  });

  it("recusa TEST_DATABASE_URL não-file e sqlite sem arquivo persistido", () => {
    expect(
      guard.forbiddenReason("postgresql://localhost/reformaflow_test"),
    ).toMatch(/URL file:/);
    expect(guard.forbiddenReason("https://example.test/test.db")).toMatch(
      /URL file:/,
    );
    expect(guard.forbiddenReason("file::memory:")).toMatch(/arquivo SQLite/);
  });

  it("recusa caminho lexical interno que escapa do worktree por symlink", () => {
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "rf-db-guard-outside-"),
    );
    const link = path.join(
      guard.REPO_ROOT,
      "prisma",
      `guard-symlink-${process.pid}-${Date.now()}`,
    );
    fs.symlinkSync(outside, link, "dir");
    try {
      const requested = `file:${path.join(link, "test.db")}`;
      const realOutside = fs.realpathSync.native(outside);
      expect(
        guard.resolveSqlitePath(requested).startsWith(guard.REPO_ROOT),
      ).toBe(true);
      expect(
        guard.resolveRealSqlitePath(requested).startsWith(realOutside),
      ).toBe(true);
      expect(guard.forbiddenReason(requested)).toMatch(/symlink/);
    } finally {
      fs.unlinkSync(link);
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it.each(["dev.db", "test.db"])(
    "recusa antes do Prisma symlink pendente para %s externo",
    (databaseName: string) => {
      const previous = process.env.TEST_DATABASE_URL;
      const outside = fs.mkdtempSync(
        path.join(os.tmpdir(), "rf-db-guard-dangling-"),
      );
      const target = path.join(outside, databaseName);
      const link = path.join(
        guard.REPO_ROOT,
        "prisma",
        `guard-dangling-${process.pid}-${Date.now()}.db`,
      );
      fs.symlinkSync(target, link, "file");
      process.env.TEST_DATABASE_URL = `file:${link}`;
      try {
        expect(fs.existsSync(link)).toBe(false);
        expect(() => guard.applyTestDatabaseUrl()).toThrow(/symlink/);
        expect(fs.existsSync(target)).toBe(false);
      } finally {
        if (previous === undefined) delete process.env.TEST_DATABASE_URL;
        else process.env.TEST_DATABASE_URL = previous;
        guard.applyTestDatabaseUrl();
        fs.unlinkSync(link);
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it("explode de forma legível se TEST_DATABASE_URL apontar para o dev.db", () => {
    const anterior = process.env.TEST_DATABASE_URL;
    process.env.TEST_DATABASE_URL =
      "file:/Users/alguem/reformaflow/prisma/dev.db";
    try {
      expect(() => guard.applyTestDatabaseUrl()).toThrow(
        /TESTE ABORTADO: DATABASE_URL inseguro/,
      );
    } finally {
      if (anterior === undefined) delete process.env.TEST_DATABASE_URL;
      else process.env.TEST_DATABASE_URL = anterior;
      guard.applyTestDatabaseUrl();
    }
    expect(process.env.DATABASE_URL).toBe(guard.ACTIVE_DB_URL);
  });

  it("explode antes do cliente Prisma para TEST_DATABASE_URL não-file", () => {
    const anterior = process.env.TEST_DATABASE_URL;
    process.env.TEST_DATABASE_URL = "postgresql://localhost/reformaflow_test";
    try {
      expect(() => guard.applyTestDatabaseUrl()).toThrow(/URL file:/);
    } finally {
      if (anterior === undefined) delete process.env.TEST_DATABASE_URL;
      else process.env.TEST_DATABASE_URL = anterior;
      guard.applyTestDatabaseUrl();
    }
    expect(process.env.DATABASE_URL).toBe(guard.ACTIVE_DB_URL);
  });
});

/**
 * Isolamento por worker (#486).
 *
 * A suíte era vermelha 1 em 4 em paralelo e verde em `--runInBand` porque todos
 * os workers escreviam no MESMO `prisma/test.db`: o `beforeAll` de um spec
 * apagava, via `deleteMany` por tenant, a fixture que outro worker ainda estava
 * lendo. Estes testes fixam o contrato que impede a regressão — se alguém
 * remover o sharding, eles ficam vermelhos ANTES de a suíte voltar a piscar.
 */
describe("isolamento de banco por worker do jest (#486)", () => {
  const prisma = new PrismaClient();

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("dá a cada worker um arquivo SQLite distinto, nunca o template compartilhado", () => {
    // O contrato que realmente elimina a corrida: ids diferentes ⇒ arquivos diferentes.
    const paths = [1, 2, 3, 14].map((id) => guard.workerDbPath(id));
    expect(new Set(paths).size).toBe(4);
    expect(paths.map((p) => path.basename(p))).toEqual([
      "test-worker-1.db",
      "test-worker-2.db",
      "test-worker-3.db",
      "test-worker-14.db",
    ]);
    for (const candidate of paths) {
      expect(candidate).not.toBe(guard.TEST_DB_PATH);
      expect(path.dirname(candidate)).toBe(
        path.join(guard.REPO_ROOT, "prisma"),
      );
      expect(guard.forbiddenReason(`file:${candidate}`)).toBeNull();
    }
  });

  it("este spec está lendo o banco do seu próprio worker, já materializado", () => {
    // Dentro do jest JEST_WORKER_ID sempre existe (com --runInBand vale "1").
    expect(guard.WORKER_ID).toBe(Number(process.env.JEST_WORKER_ID));
    expect(guard.WORKER_ID).toBeGreaterThanOrEqual(1);
    expect(guard.ACTIVE_DB_PATH).toBe(guard.workerDbPath(guard.WORKER_ID));
    expect(guard.ACTIVE_DB_PATH).not.toBe(guard.TEST_DB_PATH);
    expect(process.env.DATABASE_URL).toBe(`file:${guard.ACTIVE_DB_PATH}`);
    // Materializado de verdade: sem o arquivo o Prisma criaria um SQLite vazio.
    expect(fs.existsSync(guard.ACTIVE_DB_PATH)).toBe(true);
    expect(fs.statSync(guard.ACTIVE_DB_PATH).size).toBeGreaterThan(0);
  });

  it("o banco do worker carrega as 63 migrations do template, não um SQLite vazio", async () => {
    // Prova que a cópia é do template migrado — o modo de falha silencioso
    // seria um arquivo novo e vazio, com "no such table" em todo query.
    const rows = await prisma.$queryRaw<Array<{ total: bigint | number }>>`
      SELECT COUNT(*) AS total FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    expect(Number(rows[0].total)).toBe(63);
  });

  it("resolveWorkerId aceita só inteiro positivo — o resto cai no template", () => {
    // Fronteiras: um valor estranho jamais pode virar nome de arquivo.
    expect(guard.resolveWorkerId("1")).toBe(1);
    expect(guard.resolveWorkerId("14")).toBe(14);
    expect(guard.resolveWorkerId(" 7 ")).toBe(7);
    expect(guard.resolveWorkerId("0")).toBeNull();
    expect(guard.resolveWorkerId("-1")).toBeNull();
    expect(guard.resolveWorkerId("1.5")).toBeNull();
    expect(guard.resolveWorkerId("01")).toBeNull();
    expect(guard.resolveWorkerId("2x")).toBeNull();
    expect(guard.resolveWorkerId("")).toBeNull();
    expect(guard.resolveWorkerId(undefined)).toBeNull();
    expect(guard.resolveWorkerId(3)).toBeNull();
  });

  it("ensureWorkerDatabase é idempotente e não sobrescreve dados do worker em curso", async () => {
    // Arquivos de um mesmo worker rodam em série e reaproveitam o banco; uma
    // segunda cópia no meio da suíte apagaria a fixture de quem está rodando.
    const inodeBefore = fs.statSync(guard.ACTIVE_DB_PATH).ino;
    const sentinelTenant = `guard-sentinel-${process.env.JEST_WORKER_ID}`;
    await prisma.tenant.create({
      data: { id: sentinelTenant, name: "sentinel" },
    });

    try {
      expect(guard.ensureWorkerDatabase()).toBe(guard.ACTIVE_DB_PATH);
      expect(guard.applyTestDatabaseUrl()).toBe(guard.ACTIVE_DB_URL);

      const survived = await prisma.tenant.findUnique({
        where: { id: sentinelTenant },
        select: { id: true, name: true },
      });
      expect(survived).toEqual({ id: sentinelTenant, name: "sentinel" });
      expect(fs.statSync(guard.ACTIVE_DB_PATH).ino).toBe(inodeBefore);
    } finally {
      // PrismaClient cru (sem o middleware de soft delete do PrismaService):
      // isto é um DELETE de verdade, o sentinela não sobra para o próximo spec.
      await prisma.tenant.delete({ where: { id: sentinelTenant } });
    }
  });

  it("cleanWorkerDatabases varre só o prefixo — template e dev.db ficam de fora", () => {
    const workerFiles = fs
      .readdirSync(path.join(guard.REPO_ROOT, "prisma"))
      .filter((entry) => entry.startsWith(guard.WORKER_DB_PREFIX));
    expect(workerFiles).toContain(path.basename(guard.ACTIVE_DB_PATH));

    expect(guard.WORKER_DB_PREFIX).toBe("test-worker-");
    expect(
      path.basename(guard.TEST_DB_PATH).startsWith(guard.WORKER_DB_PREFIX),
    ).toBe(false);
    expect("dev.db".startsWith(guard.WORKER_DB_PREFIX)).toBe(false);
  });
});
