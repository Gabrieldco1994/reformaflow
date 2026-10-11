"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { validateModelLock } = require("./maria-import-eval-contract.cjs");

async function jsonRequest(fetchImpl, url, init, timeoutMs = 30000) {
  const response = await fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error("OLLAMA_VERIFY_HTTP_" + response.status);
  const value = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("OLLAMA_VERIFY_INVALID_JSON");
  return value;
}
async function verifyModel(host, lockInput, fetchImpl = fetch) {
  const lock = validateModelLock(lockInput);
  if (!/^(127\.0\.0\.1|localhost):[0-9]+$/.test(host))
    throw new Error("OLLAMA_HOST_NOT_LOOPBACK");
  const base = "http://" + host;
  const version = await jsonRequest(fetchImpl, base + "/api/version", {});
  if (version.version !== lock.ollamaVersion)
    throw new Error("OLLAMA_VERSION_MISMATCH");
  const tags = await jsonRequest(fetchImpl, base + "/api/tags", {});
  if (!Array.isArray(tags.models)) throw new Error("OLLAMA_TAGS_INVALID");
  const named = tags.models.filter(
    (item) => item && (item.name === lock.name || item.model === lock.name),
  );
  if (named.length !== 1) throw new Error("OLLAMA_CANONICAL_NAME_MISMATCH");
  const apiDigest =
    typeof named[0].digest === "string" &&
    /^[a-f0-9]{64}$/.test(named[0].digest)
      ? "sha256:" + named[0].digest
      : named[0].digest;
  if (apiDigest !== lock.digest)
    throw new Error("OLLAMA_MANIFEST_DIGEST_MISMATCH");
  const show = await jsonRequest(fetchImpl, base + "/api/show", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: lock.name }),
  });
  if (!Array.isArray(show.capabilities) || !show.capabilities.includes("tools"))
    throw new Error("OLLAMA_TOOLS_CAPABILITY_MISSING");
  return {
    schema: "reformaflow.ollama-model-provenance/v1",
    verifiedAt: new Date().toISOString(),
    lockVerifiedAt: lock.verifiedAt,
    provider: "ollama",
    model: lock.name,
    digest: lock.digest,
    ollamaVersion: lock.ollamaVersion,
    capabilities: ["tools"],
    evidence: ["api/version", "api/tags", "api/show"],
    endpoint: "loopback",
  };
}
if (require.main === module) {
  (async () => {
    if (process.argv[2] !== "verify") throw new Error("USAGE_VERIFY");
    const lockPath = process.argv[3];
    const provenancePath = process.argv[4];
    if (!lockPath || !provenancePath)
      throw new Error("LOCK_AND_PROVENANCE_REQUIRED");
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    const provenance = await verifyModel(
      process.env.QA_OLLAMA_HOST || "",
      lock,
    );
    fs.mkdirSync(path.dirname(provenancePath), { recursive: true });
    fs.writeFileSync(
      provenancePath,
      JSON.stringify(provenance, null, 2) + "\n",
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        status: "PASS",
        model: provenance.model,
        digest: provenance.digest,
        tools: true,
      }),
    );
  })().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "OLLAMA_VERIFY_ERROR",
    );
    process.exitCode = 1;
  });
}
module.exports = { verifyModel };
