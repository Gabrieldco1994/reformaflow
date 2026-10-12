"use strict";
// Disposable fault/barrier injection only. Actual entrypoint and canonical validators unchanged.
const fs = require("node:fs");
if (
  process.argv[1]?.endsWith("/vault-startup.js") &&
  process.argv[2] === "prepare"
) {
  if (process.env.QA_STARTUP_FAULT === "first-start") {
    const mkdir = fs.promises.mkdir.bind(fs.promises);
    fs.promises.mkdir = async (target, ...args) => {
      if (target === "/data/import-vault") {
        process.stderr.write("QA_BEFORE_CREATE\n");
        await new Promise((resolve) => {
          const timer = setInterval(() => {
            if (fs.existsSync("/data/qa-release")) {
              clearInterval(timer);
              resolve();
            }
          }, 10);
        });
      }
      return mkdir(target, ...args);
    };
  }
  if (process.env.QA_STARTUP_FAULT === "missing-lock") {
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (value, ...args) => {
      if (value === "ON\n") {
        process.stderr.write("QA_PREPARED\n");
        const timer = setInterval(() => {
          if (fs.existsSync("/data/qa-release")) {
            clearInterval(timer);
            write(value, ...args);
          }
        }, 10);
        return true;
      }
      return write(value, ...args);
    };
  }
}
if (process.argv[1]?.endsWith("/dist/main.js")) {
  switch (process.env.QA_STARTUP_FAULT) {
    case "closed-fd":
      fs.closeSync(9);
      break;
    case "statfs":
      fs.promises.statfs = async () => {
        throw Object.assign(new Error("synthetic"), { code: "EIO" });
      };
      break;
    case "timeout":
      fs.promises.statfs = () => new Promise(() => {});
      break;
    case "fsync": {
      const open = fs.promises.open.bind(fs.promises);
      fs.promises.open = async (...args) => {
        const handle = await open(...args);
        handle.sync = async () => {
          throw Object.assign(new Error("synthetic"), { code: "EIO" });
        };
        return handle;
      };
      break;
    }
  }
}
