import { defineConfig } from "@playwright/test";
import webConfig from "../../../../../../playwright.config";

export default defineConfig({
  ...webConfig,
  testDir: ".",
  testMatch: "*.spec.e2e.ts",
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  workers: 1,
});
