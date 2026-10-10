"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const readiness = () => require("./ollama-readiness.cjs");

async function withServer(handler, work) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await work(`http://127.0.0.1:${server.address().port}/api/tags`);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}
test("delayed transport readiness polls within budget then returns healthy model list", async () => {
  let requests = 0;
  await withServer(
    (req, res) => {
      if (++requests === 1) return; // Hanging first readiness request, not inference.
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ models: [{ name: "synthetic" }] }));
    },
    async (url) => {
      const tags = await readiness().waitForOllamaTags(url, {
        budgetMs: 2000,
        requestMs: 50,
        pollMs: 5,
      });
      assert.equal(tags.models[0].name, "synthetic");
      assert.ok(requests >= 2);
    },
  );
});
test("connection failure then healthy is retried only at readiness boundary", async () => {
  let calls = 0;
  const tags = await readiness().waitForOllamaTags(
    "http://127.0.0.1:1/api/tags",
    {
      budgetMs: 1000,
      requestMs: 50,
      pollMs: 1,
      fetch: async () => {
        if (++calls === 1) throw new TypeError("fetch failed");
        return new Response(JSON.stringify({ models: [] }));
      },
    },
  );
  assert.equal(calls, 2);
  assert.deepEqual(tags, { models: [] });
});
test("unavailable transport fails at explicit overall deadline", async () => {
  await withServer(
    () => {},
    async (url) => {
      const start = performance.now();
      await assert.rejects(
        readiness().waitForOllamaTags(url, {
          budgetMs: 100,
          requestMs: 30,
          pollMs: 5,
        }),
        /OLLAMA_READINESS_TIMEOUT/,
      );
      assert.ok(performance.now() - start < 1000);
    },
  );
});
test("invalid healthy payload and permanent HTTP failures fail immediately", async () => {
  for (const response of [
    new Response("not-json"),
    new Response(JSON.stringify({ models: "wrong-type" })),
    new Response("no", { status: 401 }),
  ]) {
    let calls = 0;
    await assert.rejects(
      readiness().waitForOllamaTags("http://127.0.0.1:1/api/tags", {
        budgetMs: 1000,
        requestMs: 50,
        pollMs: 1,
        fetch: async () => {
          calls++;
          return response;
        },
      }),
    );
    assert.equal(calls, 1);
  }
});
