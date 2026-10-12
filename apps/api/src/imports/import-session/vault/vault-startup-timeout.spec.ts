require("../../../../../../scripts/test-db-env.cjs");
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

it("pending requested-ON boot keeps the process alive until bounded OFF failure", () => {
  const root = resolve(__dirname, "../../../../../..");
  const probe = resolve(__dirname, "vault-probe.ts");
  const boot = resolve(__dirname, "vault-boot.ts");
  const script = `
    require('ts-node/register');
    const probe = require(${JSON.stringify(probe)});
    probe.collectLockFacts = () => new Promise(() => {});
    const {startVaultBoot} = require(${JSON.stringify(boot)});
    const b = startVaultBoot({
      IMPORT_VAULT_ENABLED:'true', IMPORT_VAULT_LOCK_FD:'9', VAULT_DIR:'/data/import-vault',
      IMPORT_VAULT_IDLE_TIMEOUT_MS:'1', IMPORT_VAULT_HEADROOM_BYTES:'1',
      IMPORT_VAULT_DRAIN_TIMEOUT_MS:'0'
    }, {publicDir:'/data/uploads', privateDir:'/data/private-uploads'});
    b.settled.then(() => {
      console.log(b.state()+':'+b.reason);
      process.exitCode = b.state() === 'ON' ? 0 : 1;
    });
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: root,
    env: {
      ...process.env,
      TS_NODE_PROJECT: resolve(root, "apps/api/tsconfig.json"),
    },
    encoding: "utf8",
    timeout: 15000,
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("OFF:BOOT_TIMEOUT");
}, 20000);
