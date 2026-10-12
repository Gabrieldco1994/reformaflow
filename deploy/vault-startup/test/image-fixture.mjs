import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { join, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const IMAGE = process.env.VAULT_STARTUP_IMAGE ?? "vault-startup:test";
export const ON = {
  IMPORT_VAULT_ENABLED: "true",
  VAULT_DIR: "/data/import-vault",
  IMPORT_VAULT_IDLE_TIMEOUT_MS: "10000",
  IMPORT_VAULT_HEADROOM_BYTES: "1048576",
  IMPORT_VAULT_DRAIN_TIMEOUT_MS: "2000",
}; // Explicit disposable test settings ONLY, never production sizing.
export function docker(...args) {
  if (args[0] === "logs") {
    const result = spawnSync("docker", args, {
      encoding: "utf8",
      timeout: 120000,
    });
    assert.equal(result.status, 0);
    return `${result.stdout}${result.stderr}`.trim();
  }
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120000,
  }).trim();
}
export async function until(work, message, timeout = 60000) {
  const end = Date.now() + timeout;
  do {
    if (await work()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < end);
  assert.fail(message);
}
export function lazyPublishedOrigin(name, runDocker = docker) {
  let origin;
  return () => {
    if (origin === undefined) {
      const publication = runDocker("port", name, "3001/tcp");
      const port = publication.split(":").at(-1);
      assert.match(port ?? "", /^[1-9][0-9]*$/);
      origin = `http://127.0.0.1:${port}`;
    }
    return origin;
  };
}
export function snapshot(root) {
  const result = [];
  function walk(target, relative) {
    const s = lstatSync(target, { bigint: true });
    result.push([
      relative,
      s.mode.toString(),
      s.uid.toString(),
      s.dev.toString(),
      s.ino.toString(),
      s.nlink.toString(),
      s.isFile()
        ? createHash("sha256").update(readFileSync(target)).digest("hex")
        : s.isSymbolicLink()
          ? readlinkSync(target)
          : null,
    ]);
    if (s.isDirectory())
      readdirSync(target)
        .sort()
        .forEach((n) => walk(join(target, n), join(relative, n)));
  }
  try {
    walk(root, ".");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return result;
}
export async function withImageFixture(work) {
  assert.equal(
    process.platform,
    "linux",
    "Linux image evidence cannot be skipped",
  );
  const mount = process.env.VAULT_IMAGE_DATA_DIR;
  assert.ok(mount?.startsWith("/"), "CI must supply disposable ext4 mount");
  const dir = mkdtempSync(join(mount, "fixture-"));
  const database = join(dir, "test.db");
  assert.equal(basename(database), "test.db");
  const containers = [];
  const vault = join(dir, "import-vault");
  const f = {
    dir,
    vault,
    containers,
    snapshotVault: () => snapshot(vault),
    async start(settings = {}, extra = [], command = []) {
      const name = `vault-startup-${randomUUID()}`;
      containers.push(name);
      const env = {
        DATABASE_URL: "file:/data/test.db",
        JWT_SECRET: "synthetic-image-qa-not-a-production-secret-20261010",
        ADMIN_USERNAME: "startup.qa",
        ADMIN_PASSWORD: "Synthetic-test-only-20261010",
        CORS_ORIGIN: "http://localhost:3000",
        ...settings,
      };
      docker(
        "run",
        "-d",
        "--name",
        name,
        "-p",
        "127.0.0.1::3001",
        "--mount",
        `type=bind,src=${dir},dst=/data`,
        ...Object.entries(env)
          .filter(([, v]) => v !== undefined)
          .flatMap(([k, v]) => ["-e", `${k}=${v}`]),
        ...extra,
        IMAGE,
        ...command,
      );
      // Startup-rejection cases can exit before Docker retains a published
      // port. Resolve it only for tests that actually make an HTTP request.
      const publishedOrigin = lazyPublishedOrigin(name);
      const api = {
        name,
        exec: (...args) => docker("exec", name, ...args),
        logs: () => docker("logs", name),
        running: () =>
          docker("inspect", "-f", "{{.State.Running}}", name) === "true",
        exitCode: () =>
          Number(docker("inspect", "-f", "{{.State.ExitCode}}", name)),
        async request(path, options = {}) {
          return fetch(`${publishedOrigin()}${path}`, {
            ...options,
            signal: AbortSignal.timeout(3000),
          });
        },
        async ready() {
          await until(async () => {
            assert.ok(
              api.running(),
              `production entrypoint exited: ${api.logs().slice(-1500)}`,
            );
            try {
              return (await api.request("/api/docs-json")).status === 200;
            } catch {
              return false;
            }
          }, "actual production API did not listen");
        },
        async failed() {
          await until(() => !api.running(), "startup failure not bounded");
          assert.notEqual(api.exitCode(), 0);
          const logs = api.logs();
          assert.equal(
            logs.includes("Prisma schema loaded"),
            false,
            "failure must precede migration",
          );
          assert.equal(
            logs.includes("Starting Nest application"),
            false,
            "failure must precede API",
          );
          return logs;
        },
        async stop() {
          docker("stop", "--time", "10", name);
          assert.equal(api.running(), false);
        },
        async login() {
          const res = await api.request("/auth/login", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              username: env.ADMIN_USERNAME,
              password: env.ADMIN_PASSWORD,
            }),
          });
          assert.equal(res.status, 200);
          api.token = (await res.json()).token;
        },
        async json(path, method = "GET", body) {
          const res = await api.request(path, {
            method,
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${api.token}`,
              origin: env.CORS_ORIGIN,
              "x-rf-import-ui": "1",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          });
          const value = await res.json();
          assert.ok(
            res.ok,
            `synthetic API request ${path}: ${res.status} ${JSON.stringify(value)}`,
          );
          return value;
        },
        async uploadDocuments() {
          await api.login();
          const project = await api.json("/projects", "POST", {
            name: "Synthetic startup QA",
            type: "PESSOAL",
          });
          const card = await api.json(
            `/projects/${project.id}/credit-cards`,
            "POST",
            {
              institution: "NUBANK",
              brand: "Mastercard",
              nickname: "Synthetic QA",
              last4: "4242",
              closingDay: 5,
              dueDay: 10,
              limitTotalCents: 100000,
            },
          );
          const session = await api.json("/import-sessions", "POST", {
            version: 1,
            createRequestId: randomUUID(),
            cardId: card.id,
            consentPolicyVersion: 1,
            consentAnalyze: true,
          });
          const docs = [
            {
              id: randomUUID(),
              fileName: "synthetic.csv",
              mime: "text/csv",
              bytes: Buffer.from(
                "date,description,amount\n2026-10-10,SYNTHETIC_STARTUP_CSV,1.00\n",
              ),
            },
            {
              id: randomUUID(),
              fileName: "synthetic.pdf",
              mime: "application/pdf",
              bytes: Buffer.from("%PDF-1.4\n%SYNTHETIC_STARTUP_PDF\n%%EOF\n"),
            },
          ];
          await api.json(`/import-sessions/${session.id}/attachments`, "POST", {
            expectedRevision: session.revision,
            files: docs.map(({ bytes, ...d }) => ({
              ...d,
              declaredBytes: bytes.length,
            })),
          });
          for (const d of docs) {
            const res = await api.request(
              `/import-sessions/${session.id}/attachments/${d.id}/content`,
              {
                method: "PUT",
                headers: {
                  authorization: `Bearer ${api.token}`,
                  origin: env.CORS_ORIGIN,
                  "x-rf-import-ui": "1",
                  "content-type": "application/octet-stream",
                  "content-length": String(d.bytes.length),
                },
                body: d.bytes,
              },
            );
            assert.equal(res.status, 200, await res.text());
          }
          return { sessionId: session.id, docs };
        },
        async readDocuments(stored) {
          await api.login();
          for (const d of stored.docs) {
            const res = await api.request(
              `/import-sessions/${stored.sessionId}/attachments/${d.id}/content`,
              { headers: { authorization: `Bearer ${api.token}` } },
            );
            assert.equal(res.status, 200);
            assert.deepEqual(Buffer.from(await res.arrayBuffer()), d.bytes);
          }
        },
        assertLockProof() {
          assert.equal(
            api.exec("sh", "-c", "readlink /proc/1/exe").split("/").at(-1),
            "node",
          );
          api.exec(
            "node",
            "-e",
            `
            const fs=require('fs');
            const p=require('./apps/api/dist/imports/import-session/vault/vault-lock');
            const fd=fs.statSync('/proc/1/fd/9',{bigint:true});
            const path=fs.lstatSync('/data/import-vault/.lock',{bigint:true});
            const proof=p.decideLockProof({lockFd:9,platform:'linux',fd:{kind:'file',dev:fd.dev,ino:fd.ino},
              path:{kind:'file',dev:path.dev,ino:path.ino},fdinfo:fs.readFileSync('/proc/1/fdinfo/9','utf8')});
            if(!proof.ok) process.exit(1);
          `,
          );
          assert.match(api.logs(), /vault_startup_gate[\s\S]*?"state": "ON"/);
        },
      };
      return api;
    },
    tryLock() {
      // Independent actual runtime flock, never the launcher's inherited descriptor.
      return docker(
        "run",
        "--rm",
        "--mount",
        `type=bind,src=${dir},dst=/data`,
        "--entrypoint",
        "bash",
        IMAGE,
        "-c",
        "exec 9< /data/import-vault/.lock; if flock -xn 9; then echo ACQUIRED; else echo COLLISION; fi",
      );
    },
    assertMigrations(api) {
      const total = readdirSync(
        new URL("../../../prisma/migrations", import.meta.url),
      ).filter((n) => /^\d/.test(n)).length;
      assert.equal(
        Number(
          api.exec(
            "sqlite3",
            "/data/test.db",
            "SELECT COUNT(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL",
          ),
        ),
        total,
      );
    },
  };
  try {
    await work(f);
  } finally {
    for (const c of containers) {
      try {
        docker("rm", "-f", c);
      } catch {
        /* cleanup only */
      }
    }
    // Disposable ext4 tree created by this harness only; never a production/dev DB.
    rmSync(dir, { recursive: true, force: true });
  }
}
