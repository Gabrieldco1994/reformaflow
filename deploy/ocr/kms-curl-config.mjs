#!/usr/bin/env node
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function fail(code) {
  throw new Error(code);
}
function quoted(value) {
  if (typeof value !== "string" || !value || /[\r\n"\\]/.test(value))
    fail("KMS_CURL_CONFIG_INVALID");
  return `"${value}"`;
}
export async function writeKmsCurlConfig(path, options, token) {
  if (
    typeof token !== "string" ||
    token.length < 20 ||
    /[\r\n]/.test(token) ||
    !/^https:\/\/cloudkms\.googleapis\.com\/v1\/[A-Za-z0-9._~:/-]+:asymmetricSign$/.test(
      options.endpoint,
    )
  )
    fail("KMS_CURL_CONFIG_INVALID");
  const lines = [
    "silent",
    "show-error",
    "fail-with-body",
    'request = \"POST\"',
    `url = ${quoted(options.endpoint)}`,
    `header = ${quoted(`Authorization: Bearer ${token}`)}`,
    `header = ${quoted("Content-Type: application/json")}`,
    `data-binary = ${quoted(`@${options.requestPath}`)}`,
    `output = ${quoted(options.responsePath)}`,
    "",
  ];
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(lines.join("\n"), { encoding: "utf8" });
  } finally {
    await handle.close();
  }
  const metadata = await stat(path);
  if ((metadata.mode & 0o777) !== 0o600) fail("KMS_CURL_CONFIG_MODE_INVALID");
}

const invoked =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const [path, requestPath, responsePath, endpoint] = process.argv.slice(2);
  try {
    await writeKmsCurlConfig(
      resolve(path),
      {
        requestPath: resolve(requestPath),
        responsePath: resolve(responsePath),
        endpoint,
      },
      process.env.KMS_ACCESS_TOKEN,
    );
  } catch (error) {
    const code =
      error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "KMS_CURL_CONFIG_INVALID";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
