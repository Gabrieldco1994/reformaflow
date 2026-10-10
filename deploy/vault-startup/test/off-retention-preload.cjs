"use strict";
// Test-only observation of real EVERY_MINUTE callbacks; no fake clock or scheduler invocation.
if (process.argv[1]?.endsWith("/dist/main.js")) {
  require("reflect-metadata");
  const {
    VaultRetentionScheduler,
  } = require("/app/apps/api/dist/imports/import-session/vault/vault-retention.scheduler");
  const {
    VaultReaper,
  } = require("/app/apps/api/dist/imports/import-session/vault/vault-reaper");
  let ticks = 0;
  VaultReaper.prototype.runCycle = async () => {
    throw new Error("QA_OFF_AUTOMATED_REAPER_ENTERED");
  };
  const original = VaultRetentionScheduler.prototype.run;
  const observed = async function (...args) {
    const owner = {
      tenantId: "synthetic",
      ownerProjectId: "synthetic",
      ownerUserId: "synthetic",
    };
    if (
      this.gate.boot.state() !== "OFF" ||
      !this.gate.boot.stopped.aborted ||
      this.gate.registry.enter("R:synthetic-off-tick", owner).ok
    ) {
      throw new Error("QA_OFF_FENCE_LOST");
    }
    await original.apply(this, args);
    process.stdout.write(`QA_OFF_CRON_FENCED_${++ticks}\n`);
  };
  for (const key of Reflect.getMetadataKeys(original)) {
    Reflect.defineMetadata(key, Reflect.getMetadata(key, original), observed);
  }
  VaultRetentionScheduler.prototype.run = observed;
}
