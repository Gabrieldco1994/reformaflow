const assert = require("node:assert/strict");

require("ts-node").register({
  compilerOptions: { module: "CommonJS", moduleResolution: "node" },
});
const config = require("./playwright.config.ts").default;
assert.ok(config.webServer && !Array.isArray(config.webServer));
assert.deepEqual(config.webServer.env, {
  NEXT_PUBLIC_API_URL: "http://127.0.0.1:43141",
});
assert.equal(config.webServer.url, "http://127.0.0.1:43142");
assert.equal(config.use.baseURL, "http://127.0.0.1:43142");

process.stdout.write(
  JSON.stringify({
    kind: "PUBLIC_ENTRY_PLAYWRIGHT_CONFIG",
    api: config.webServer.env.NEXT_PUBLIC_API_URL,
    web: config.webServer.url,
  }) + "\n",
);
