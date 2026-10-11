"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const lock = require("./maria-import-eval/model-lock.v1.json");
const { verifyModel } = require("./ollama-model-lock.cjs");

function fake(payloads) {
  let index = 0;
  return async () =>
    new Response(JSON.stringify(payloads[index++]), {
      headers: { "content-type": "application/json" },
    });
}
const good = () => [
  { version: lock.ollamaVersion },
  { models: [{ name: lock.name, model: lock.name, digest: lock.digest }] },
  { capabilities: ["completion", "tools"] },
];

test("verifies version, exact explicit tag digest and tools without leaking host", async () => {
  const provenance = await verifyModel("127.0.0.1:11434", lock, fake(good()));
  assert.equal(provenance.model, lock.name);
  assert.equal(provenance.digest, lock.digest);
  assert.equal(provenance.endpoint, "loopback");
  assert.equal(JSON.stringify(provenance).includes("127.0.0.1"), false);
});

test("rejects digest and alias mismatches", async () => {
  const badDigest = good();
  badDigest[1].models[0].digest = "sha256:" + "0".repeat(64);
  await assert.rejects(
    verifyModel("localhost:11434", lock, fake(badDigest)),
    /DIGEST_MISMATCH/,
  );
  const alias = good();
  alias[1].models[0].name = "qwen2.5:7b";
  alias[1].models[0].model = "qwen2.5:7b";
  await assert.rejects(
    verifyModel("localhost:11434", lock, fake(alias)),
    /CANONICAL_NAME_MISMATCH/,
  );
});

test("rejects version, capability, and non-loopback mutations", async () => {
  const version = good();
  version[0].version = "0.40.1";
  await assert.rejects(
    verifyModel("localhost:11434", lock, fake(version)),
    /VERSION_MISMATCH/,
  );
  const tools = good();
  tools[2].capabilities = ["completion"];
  await assert.rejects(
    verifyModel("localhost:11434", lock, fake(tools)),
    /TOOLS_CAPABILITY/,
  );
  await assert.rejects(
    verifyModel("ollama.example:11434", lock, fake(good())),
    /NOT_LOOPBACK/,
  );
});
