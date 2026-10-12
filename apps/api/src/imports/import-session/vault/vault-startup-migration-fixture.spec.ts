require("../../../../../../scripts/test-db-env.cjs");
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

it("regular-file parent reliably forces real migration failure without replacing fixture bytes", () => {
  const root = resolve(__dirname, "../../../../../..");
  const directory = mkdtempSync(
    join(root, "prisma/test-vault-migration-failure-"),
  );
  try {
    const parent = join(directory, "migration-failure-parent");
    const marker = "synthetic-not-a-directory";
    const url = `file:${join(parent, "test.db")}`;
    const guard = require("../../../../../../scripts/test-db-env.cjs");
    expect(guard.forbiddenReason(url)).toBeNull();
    writeFileSync(parent, marker);
    const result = spawnSync(
      process.execPath,
      [
        require.resolve("prisma/build/index.js"),
        "migrate",
        "deploy",
        "--schema",
        join(root, "prisma/schema.prisma"),
      ],
      {
        cwd: root,
        env: { ...process.env, DATABASE_URL: url },
        encoding: "utf8",
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Prisma schema loaded");
    expect(result.stderr).toContain("Not a directory");
    expect(readFileSync(parent, "utf8")).toBe(marker);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);
