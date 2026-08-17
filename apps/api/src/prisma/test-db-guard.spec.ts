/**
 * Testa a própria trava que impede a suíte de escrever no dev.db real.
 * Ver scripts/test-db-env.cjs.
 */
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const guard = require("../../../../scripts/test-db-env.cjs");

describe("trava de DATABASE_URL em testes", () => {
  it("a suíte roda contra o banco descartável do worktree, nunca o dev.db", () => {
    expect(process.env.DATABASE_URL).toBe(guard.TEST_DB_URL);
    expect(path.basename(guard.TEST_DB_PATH)).not.toBe("dev.db");
    expect(guard.TEST_DB_PATH.startsWith(guard.REPO_ROOT)).toBe(true);
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

  it("recusa symlink pendente que criaria o banco fora do worktree", () => {
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "rf-db-guard-dangling-"),
    );
    const target = path.join(outside, "test.db");
    const link = path.join(
      guard.REPO_ROOT,
      "prisma",
      `guard-dangling-${process.pid}-${Date.now()}.db`,
    );
    fs.symlinkSync(target, link, "file");
    try {
      expect(fs.existsSync(link)).toBe(false);
      expect(guard.forbiddenReason(`file:${link}`)).toMatch(/symlink/);
    } finally {
      fs.unlinkSync(link);
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

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
    expect(process.env.DATABASE_URL).toBe(guard.TEST_DB_URL);
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
    expect(process.env.DATABASE_URL).toBe(guard.TEST_DB_URL);
  });
});
