import "../../../../scripts/test-db-env.cjs";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "interaction.browser.ts",
  workers: 1,
  retries: 0,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:43127", browserName: "chromium" },
  webServer: {
    command: "npx vite --config e2e/maria-local-interaction/vite.config.ts",
    cwd: "../..",
    url: "http://127.0.0.1:43127",
    reuseExistingServer: false,
  },
});
