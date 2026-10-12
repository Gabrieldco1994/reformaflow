import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  linkSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  withImageFixture,
  ON,
  IMAGE,
  docker,
  until,
} from "./image-fixture.mjs";

test("OFF default migrates/starts without touching absent vault or holding FD9", async () => {
  await withImageFixture(async (f) => {
    const before = f.snapshotVault();
    const api = await f.start();
    await api.ready();
    assert.equal((await api.request("/auth/me")).status, 401);
    assert.deepEqual(f.snapshotVault(), before);
    // Node may allocate internal epoll/pipe descriptors numbered 9 itself. OFF must
    // not inherit a vault flock, not prohibit Node's unrelated internal descriptors.
    assert.equal(
      api.exec(
        "sh",
        "-c",
        "if test -e /proc/1/fdinfo/9; then grep -c FLOCK /proc/1/fdinfo/9 || true; else echo 0; fi",
      ),
      "0",
    );
    f.assertMigrations(api);
    await api.login();
    const disabled = await api.request("/import-sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${api.token}`,
        origin: "http://localhost:3000",
        "x-rf-import-ui": "1",
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(disabled.status, 503);
    assert.deepEqual(await disabled.json(), {
      code: "CAPABILITY_DISABLED",
      retryable: true,
      sessionId: null,
      currentRevision: null,
      reason: null,
    });
  });
});

for (const flag of ["false", "TRUE", "1", ""]) {
  test(`OFF ${JSON.stringify(flag)} ignores unsafe vault and bad config`, async () => {
    await withImageFixture(async (f) => {
      symlinkSync("synthetic-absent-target", f.vault);
      const before = f.snapshotVault();
      const api = await f.start({
        IMPORT_VAULT_ENABLED: flag,
        VAULT_DIR: "/tmp/invalid",
        IMPORT_VAULT_LOCK_FD: "bad",
        IMPORT_VAULT_DRAIN_TIMEOUT_MS: "-1",
      });
      await api.ready();
      assert.deepEqual(f.snapshotVault(), before);
    });
  });
}

test("OFF after ON retains persisted bytes and fences RAW/maintenance through two real cron ticks", async () => {
  await withImageFixture(async (f) => {
    const on = await f.start(ON);
    await on.ready();
    const stored = await on.uploadDocuments();
    await on.stop();
    const before = f.snapshotVault();
    const off = await f.start(
      {
        NODE_OPTIONS: "--require=/qa/off-retention.cjs",
      },
      [
        "--mount",
        `type=bind,src=${resolve("deploy/vault-startup/test/off-retention-preload.cjs")},dst=/qa/off-retention.cjs,readonly`,
      ],
    );
    await off.ready();
    await off.login();
    const headers = {
      authorization: `Bearer ${off.token}`,
      origin: "http://localhost:3000",
      "x-rf-import-ui": "1",
      "content-type": "application/json",
    };
    for (const path of [
      "/import-sessions",
      `/import-sessions/${stored.sessionId}/attachments`,
      `/import-sessions/${stored.sessionId}/attachments/${stored.docs[0].id}/analyze`,
    ]) {
      const res = await off.request(path, {
        method: "POST",
        headers,
        body: "{}",
      });
      assert.equal(res.status, 503);
      assert.equal((await res.json()).code, "CAPABILITY_DISABLED");
    }
    const documentarySnapshot = () =>
      off.exec(
        "sqlite3",
        "-json",
        "/data/test.db",
        "SELECT * FROM import_sessions ORDER BY id; SELECT * FROM import_artifacts ORDER BY id; SELECT * FROM import_session_artifacts ORDER BY id; SELECT * FROM import_observations ORDER BY id;",
      );
    const beforeRows = documentarySnapshot();
    await until(
      () => off.logs().includes("QA_OFF_CRON_FENCED_2"),
      "two real EVERY_MINUTE cron callbacks must retain OFF fences",
      150000,
    );
    assert.doesNotMatch(
      off.logs(),
      /QA_OFF_AUTOMATED_REAPER_ENTERED|QA_OFF_FENCE_LOST/,
    );
    assert.equal(documentarySnapshot(), beforeRows);
    assert.deepEqual(
      f.snapshotVault(),
      before,
      "no automated purge, rename or lock replacement",
    );
    assert.equal(f.tryLock(), "ACQUIRED", "OFF does not own the vault flock");
    await off.stop(); // Actual PID1 SIGTERM hooks, existing persisted layout unchanged.
    assert.deepEqual(f.snapshotVault(), before);
  });
});

test("ON API inherits exclusive FD9, migrates, serves private CSV/PDF only authenticated, restarts preserving inode", async () => {
  await withImageFixture(async (f) => {
    const first = await f.start(ON);
    await first.ready();
    first.assertLockProof();
    assert.equal(f.tryLock(), "COLLISION");
    f.assertMigrations(first);
    const docs = await first.uploadDocuments();
    await first.readDocuments(docs);
    mkdirSync(join(f.dir, "uploads"), { recursive: true });
    writeFileSync(
      join(f.dir, "uploads/public-control.txt"),
      "SYNTHETIC_PUBLIC",
    );
    assert.equal(
      (await first.request("/uploads/public-control.txt")).status,
      200,
    );
    for (const path of [
      "/uploads/../import-vault/.lock",
      "/uploads/import-vault/t/synthetic.csv",
      "/uploads/%2e%2e/import-vault/t/synthetic.pdf",
      "/import-vault/t/synthetic.csv",
    ]) {
      const res = await first.request(path);
      assert.notEqual(res.status, 200);
      assert.equal((await res.text()).includes("SYNTHETIC_STARTUP"), false);
    }
    assert.equal(
      first.exec(
        "sqlite3",
        "/data/test.db",
        "SELECT (SELECT COUNT(*) FROM expenses)+(SELECT COUNT(*) FROM cash_flow_entries)+(SELECT COUNT(*) FROM receipts);",
      ),
      "0",
    );
    const before = f.snapshotVault();
    const loser = await f.start(ON);
    assert.match(await loser.failed(), /LOCK_COLLISION/);
    assert.deepEqual(f.snapshotVault(), before);
    assert.equal((await first.request("/api/docs-json")).status, 200);
    await first.stop();
    assert.equal(f.tryLock(), "ACQUIRED");
    const second = await f.start(ON);
    await second.ready();
    second.assertLockProof();
    assert.deepEqual(f.snapshotVault(), before);
    await second.readDocuments(docs);
  });
});

for (const override of [
  { VAULT_DIR: "/tmp/vault" },
  { VAULT_DIR: "/data" },
  { VAULT_DIR: "/data/uploads" },
  { VAULT_DIR: "/data/private-uploads" },
  { VAULT_DIR: "/data/import-vault/." },
  { VAULT_DIR: "relative" },
  { IMPORT_VAULT_LOCK_FD: "8" },
  { IMPORT_VAULT_IDLE_TIMEOUT_MS: undefined },
  { IMPORT_VAULT_HEADROOM_BYTES: undefined },
  { IMPORT_VAULT_DRAIN_TIMEOUT_MS: undefined },
]) {
  test(`ON rejects invalid explicit settings before migration: ${JSON.stringify(override)}`, async () => {
    await withImageFixture(async (f) => {
      const api = await f.start({ ...ON, ...override });
      await api.failed();
      assert.deepEqual(f.snapshotVault(), []);
    });
  });
}

for (const node of ["", "t", "trash", ".lock"]) {
  test(`ON rejects existing symlink ${node} without repair`, async () => {
    await withImageFixture(async (f) => {
      const initial = await f.start(ON);
      await initial.ready();
      await initial.stop();
      rmSync(join(f.vault, node), { recursive: true });
      symlinkSync("synthetic-missing-target", join(f.vault, node));
      const before = f.snapshotVault();
      await (await f.start(ON)).failed();
      assert.deepEqual(f.snapshotVault(), before);
    });
  });
}
for (const [node, mode] of [
  ["", 0o755],
  ["t", 0o777],
  ["trash", 0o1700],
  [".lock", 0o644],
]) {
  test(`ON rejects existing mode ${node}/${mode} without chmod`, async () => {
    await withImageFixture(async (f) => {
      const first = await f.start(ON);
      await first.ready();
      await first.stop();
      chmodSync(join(f.vault, node), mode);
      const before = f.snapshotVault();
      await (await f.start(ON)).failed();
      assert.deepEqual(f.snapshotVault(), before);
    });
  });
}
for (const root of ["uploads", "private-uploads"]) {
  test(`ON rejects descendant ${root} symlink and hard-linked lock`, async () => {
    await withImageFixture(async (f) => {
      const first = await f.start(ON);
      await first.ready();
      await first.stop();
      mkdirSync(join(f.dir, root), { recursive: true });
      const alias = join(f.dir, root, "alias");
      symlinkSync(f.vault, alias);
      const before = f.snapshotVault();
      await (await f.start(ON)).failed();
      assert.deepEqual(f.snapshotVault(), before);
      rmSync(alias);
      linkSync(join(f.vault, ".lock"), alias);
      const linked = f.snapshotVault();
      await (await f.start(ON)).failed();
      assert.deepEqual(f.snapshotVault(), linked);
    });
  });
}

test("migration failure never executes API and releases unchanged lock", async () => {
  await withImageFixture(async (f) => {
    const first = await f.start(ON);
    await first.ready();
    await first.stop();
    const before = f.snapshotVault();
    // Prisma creates missing parents, so an absent directory is NOT a failure
    // fixture. A regular-file parent forces ENOTDIR without touching the valid DB.
    writeFileSync(
      join(f.dir, "migration-failure-parent"),
      "synthetic-not-a-directory",
    );
    const failed = await f.start({
      ...ON,
      DATABASE_URL: "file:/data/migration-failure-parent/test.db",
    });
    await until(() => !failed.running(), "migration failure exit");
    assert.notEqual(failed.exitCode(), 0);
    assert.match(failed.logs(), /Prisma schema loaded/);
    assert.doesNotMatch(failed.logs(), /Starting Nest application/);
    assert.deepEqual(f.snapshotVault(), before);
    assert.equal(f.tryLock(), "ACQUIRED");
  });
});

const faultMount = () => [
  "--mount",
  `type=bind,src=${resolve("deploy/vault-startup/test/fault-preload.cjs")},dst=/qa/fault.cjs,readonly`,
];
test("test-derived runtime missing flock fails explicitly before migration/API", async () => {
  await withImageFixture(async (f) => {
    const api = await f.start(
      ON,
      ["--entrypoint", "bash"],
      ["-c", "rm /usr/bin/flock; exec /entrypoint.sh"],
    );
    assert.match(await api.failed(), /FLOCK_MISSING/);
  });
});
test("simultaneous first starts use a creation barrier and keep a single lock inode", async () => {
  await withImageFixture(async (f) => {
    const settings = {
      ...ON,
      NODE_OPTIONS: "--require=/qa/fault.cjs",
      QA_STARTUP_FAULT: "first-start",
    };
    const first = await f.start(settings, faultMount());
    const second = await f.start(settings, faultMount());
    await until(
      () =>
        [first, second].every((api) => api.logs().includes("QA_BEFORE_CREATE")),
      "creation barrier",
    );
    writeFileSync(join(f.dir, "qa-release"), "synthetic");
    await until(
      () => [first, second].some((api) => !api.running()),
      "single bounded loser",
    );
    const winner = first.running() ? first : second;
    const loser = first.running() ? second : first;
    await winner.ready();
    assert.match(await loser.failed(), /LOCK_COLLISION/);
    winner.assertLockProof();
    assert.equal(f.tryLock(), "COLLISION");
  });
});
test("missing lock between provision and open is not recreated", async () => {
  await withImageFixture(async (f) => {
    const api = await f.start(
      {
        ...ON,
        NODE_OPTIONS: "--require=/qa/fault.cjs",
        QA_STARTUP_FAULT: "missing-lock",
      },
      faultMount(),
    );
    await until(() => api.logs().includes("QA_PREPARED"), "provision barrier");
    rmSync(join(f.vault, ".lock"));
    const before = f.snapshotVault();
    writeFileSync(join(f.dir, "qa-release"), "synthetic");
    assert.match(await api.failed(), /LOCK_OPEN_FAILED/);
    assert.deepEqual(f.snapshotVault(), before);
  });
});
for (const fault of ["closed-fd", "fsync", "statfs", "timeout"]) {
  test(`actual requested-ON gate ${fault} failure cannot listen`, async () => {
    await withImageFixture(async (f) => {
      const api = await f.start(
        {
          ...ON,
          NODE_OPTIONS: "--require=/qa/fault.cjs",
          QA_STARTUP_FAULT: fault,
        },
        faultMount(),
      );
      await until(() => !api.running(), "actual gate failure must exit", 15000);
      assert.notEqual(api.exitCode(), 0);
      assert.match(api.logs(), /vault_startup_gate[\s\S]*?"state": "OFF"/);
      assert.doesNotMatch(api.logs(), /Nest application successfully started/);
      assert.equal(f.tryLock(), "ACQUIRED");
    });
  });
}

test("actual image contains util-linux flock; ON refuses image layer and tmpfs /data", async () => {
  assert.match(
    docker("run", "--rm", "--entrypoint", "flock", IMAGE, "--version"),
    /util-linux/,
  );
  for (const mounts of [[], ["--tmpfs", "/data"]]) {
    const name = docker(
      "run",
      "-d",
      ...mounts,
      ...Object.entries(ON).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      IMAGE,
    );
    try {
      await until(
        () => docker("inspect", "-f", "{{.State.Running}}", name) === "false",
        "mount rejection",
      );
      assert.notEqual(
        docker("inspect", "-f", "{{.State.ExitCode}}", name),
        "0",
      );
      assert.doesNotMatch(
        docker("logs", name),
        /Prisma schema loaded|Starting Nest application/,
      );
    } finally {
      docker("rm", "-f", name);
    }
  }
});

for (const drain of ["cooperative", "timeout", "zero"]) {
  test(`SIGTERM ${drain} fences real injected registry, holds lock through drain, never replaces lock`, async () => {
    await withImageFixture(async (f) => {
      const instrumentation = resolve(
        "deploy/vault-startup/test/drain-preload.cjs",
      );
      const api = await f.start(
        {
          ...ON,
          NODE_OPTIONS: "--require=/qa/drain.cjs",
          QA_DRAIN_MODE: drain,
          IMPORT_VAULT_DRAIN_TIMEOUT_MS:
            drain === "zero" ? "0" : drain === "cooperative" ? "15000" : "2000",
        },
        [
          "--mount",
          `type=bind,src=${instrumentation},dst=/qa/drain.cjs,readonly`,
        ],
      );
      await api.ready();
      await until(
        () => api.logs().includes("QA_LEASE_ACTIVE"),
        "active lease barrier",
      );
      const before = f.snapshotVault();
      docker("kill", "--signal=TERM", api.name);
      if (drain === "cooperative") {
        await until(
          () => api.logs().includes("QA_FENCED"),
          "shutdown fencing barrier",
        );
        assert.equal(f.tryLock(), "COLLISION");
        writeFileSync(join(f.dir, "qa-release"), "synthetic");
      }
      await until(() => !api.running(), "bounded SIGTERM drain", 10000);
      assert.match(api.logs(), /QA_FENCED/);
      if (drain !== "cooperative") assert.match(api.logs(), /TIMEOUT/);
      assert.equal(f.tryLock(), "ACQUIRED");
      assert.deepEqual(f.snapshotVault(), before);
    });
  });
}
