"use strict";

const { spawnSync } = require("node:child_process");

const requiredPort = (name) => {
  const literal = process.env[name];
  const port = Number(literal);
  if (
    literal === undefined ||
    !/^\d+$/.test(literal) ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65_535
  )
    throw new Error(`${name} must be an integer from 1024 to 65535`);
  return port;
};
const apiPort = requiredPort("MARIA_CSV_REAL_API_PORT");
const webPort = requiredPort("MARIA_CSV_REAL_WEB_PORT");
if (apiPort === webPort)
  throw new Error(
    "MARIA_CSV_REAL_API_PORT and MARIA_CSV_REAL_WEB_PORT must be distinct",
  );

for (const port of [apiPort, webPort]) {
  const probe = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
  });
  if (probe.error || ![0, 1].includes(probe.status ?? -1)) {
    throw new Error(
      `lsof preflight unavailable for ${port}: ${probe.error?.message ?? probe.stderr}`,
    );
  }
  if (probe.status === 0 || probe.stdout.trim()) {
    throw new Error(
      `Dedicated Maria CSV port ${port} was already owned:\n${probe.stdout}`,
    );
  }
}

console.log(
  `[maria-csv-real] lsof preflight PASS: ${apiPort} and ${webPort} unused`,
);
