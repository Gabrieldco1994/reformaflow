"use strict";
// Test-only instrumentation in an unchanged production image. Never copied into the image.
if (process.argv[1]?.endsWith("/dist/main.js")) {
  const fs = require("node:fs");
  const { NestFactory } = require("/app/node_modules/@nestjs/core");
  const {
    IMPORT_VAULT_GATE,
  } = require("/app/apps/api/dist/imports/import-session/vault/vault-state");
  const create = NestFactory.create.bind(NestFactory);
  NestFactory.create = async (...args) => {
    const app = await create(...args);
    const gate = app.get(IMPORT_VAULT_GATE);
    const owner = {
      tenantId: "synthetic",
      ownerProjectId: "synthetic",
      ownerUserId: "synthetic",
    };
    const admitted = gate.registry.enter("R:synthetic-drain", owner);
    if (!admitted.ok) throw new Error("QA_LEASE_NOT_ADMITTED");
    admitted.lease.signal.addEventListener(
      "abort",
      () => {
        if (
          gate.boot.state() !== "OFF" ||
          gate.registry.enter("R:synthetic-new", owner).ok
        )
          throw new Error("QA_SHUTDOWN_NOT_FENCED");
        process.stdout.write("QA_FENCED\n");
        if (process.env.QA_DRAIN_MODE === "cooperative") {
          const timer = setInterval(() => {
            if (fs.existsSync("/data/qa-release")) {
              clearInterval(timer);
              admitted.lease.exit();
            }
          }, 10);
        }
      },
      { once: true },
    );
    process.stdout.write("QA_LEASE_ACTIVE\n");
    return app;
  };
}
