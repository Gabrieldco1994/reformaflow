import "../../../../scripts/test-db-env.cjs";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: [
    "workflow.browser.ts",
    "conversation.browser.ts",
    "document-flow.browser.ts",
    "attestation.browser.ts",
    "declarations.browser.ts",
  ],
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    ["json", { outputFile: process.env.WORKFLOW_BROWSER_JSON }],
  ],
  outputDir:
    process.env.WORKFLOW_BROWSER_OUTPUT ?? "test-results/workflow-view",
  use: {
    baseURL: "http://127.0.0.1:43476",
    browserName: "chromium",
    contextOptions: { reducedMotion: "reduce" },
  },
  webServer: {
    command:
      "node ../../node_modules/vite/bin/vite.js --config e2e/maria-workflow-view/vite.config.ts --port 43476",
    cwd: "../..",
    url: "http://127.0.0.1:43476",
    reuseExistingServer: false,
  },
});
