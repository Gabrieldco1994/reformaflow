import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const DB_CHECK = join(ROOT, "scripts", "db-check.mjs");

// Bancos temporários fora do worktree, um por execução — nunca prisma/dev.db
// nem prisma/test.db. Por isso este arquivo NÃO carrega scripts/test-db-env.cjs
// (ele recusaria um alvo em os.tmpdir()).
const tempFiles = [];

after(() => {
  for (const file of tempFiles.splice(0)) {
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      rmSync(file + suffix, { force: true });
    }
  }
});

function tempDbPath() {
  const file = join(
    tmpdir(),
    `rf-628-fk-check-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}.db`,
  );
  tempFiles.push(file);
  return file;
}

/**
 * Cria o menor banco possível com uma FK: `child.parent_id` → `parent.id`.
 * Com `orphan: true`, desliga o enforcement (a cicatriz do #628) e insere uma
 * linha `child` apontando para um `parent` inexistente.
 */
async function buildFixture(dbFile, { orphan }) {
  const prisma = new PrismaClient({
    datasources: { db: { url: `file:${dbFile}` } },
  });
  try {
    await prisma.$executeRawUnsafe("CREATE TABLE parent (id TEXT PRIMARY KEY)");
    await prisma.$executeRawUnsafe(
      "CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id))",
    );
    await prisma.$executeRawUnsafe("INSERT INTO parent (id) VALUES ('p1')");
    await prisma.$executeRawUnsafe(
      "INSERT INTO child (id, parent_id) VALUES ('c1', 'p1')",
    );
    if (orphan) {
      await prisma.$executeRawUnsafe("PRAGMA foreign_keys = OFF");
      await prisma.$executeRawUnsafe(
        "INSERT INTO child (id, parent_id) VALUES ('orphan-1', 'ghost-parent')",
      );
      const violations = await prisma.$queryRawUnsafe(
        "PRAGMA foreign_key_check;",
      );
      assert.ok(
        violations.length >= 1,
        "fixture inválida: o órfão não foi inserido (FK enforcement seguiu ligado)",
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

function runDbCheck(dbFile) {
  return spawnSync(process.execPath, [DB_CHECK], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: `file:${dbFile}` },
  });
}

test("db-check passa num banco íntegro e falha apontando o órfão (#628)", async () => {
  const intact = tempDbPath();
  await buildFixture(intact, { orphan: false });
  const ok = runDbCheck(intact);
  assert.equal(
    ok.status,
    0,
    `esperava exit 0 num banco íntegro\nstdout: ${ok.stdout}\nstderr: ${ok.stderr}`,
  );
  assert.match(ok.stdout, /0 violações de FK/);

  const broken = tempDbPath();
  await buildFixture(broken, { orphan: true });
  const bad = runDbCheck(broken);
  assert.notEqual(
    bad.status,
    0,
    `esperava exit != 0 num banco com órfão\nstdout: ${bad.stdout}\nstderr: ${bad.stderr}`,
  );
  const output = `${bad.stdout}\n${bad.stderr}`;
  // A linha órfã é a 2ª inserida em `child` → rowid 2, pai ausente em `parent`.
  assert.match(output, /child \| 2 \| parent\/0/);
  assert.match(output, /1 violação\(ões\) de FK/);
});
