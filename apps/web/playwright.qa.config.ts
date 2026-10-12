import path from "node:path";
import { defineConfig } from "@playwright/test";

const artifacts = path.resolve(
  process.env.QA_ARTIFACTS_DIR ?? "./qa-artifacts",
);
if (!process.env.WEB_URL || !process.env.API_URL) {
  throw new Error(
    "Live QA requires WEB_URL and API_URL; start isolated Linux servers externally.",
  );
}

export default defineConfig({
  testDir: "./e2e-qa",
  testIgnore: "**/fixtures/**",
  outputDir: path.join(artifacts, "playwright"),
  workers: 1,
  retries: 0,
  fullyParallel: false,
  forbidOnly: true,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  reporter: [
    ["list"],
    ["json", { outputFile: path.join(artifacts, "results.json") }],
  ],
  use: { baseURL: process.env.WEB_URL, browserName: "chromium", trace: "off" },
  projects: [
    {
      name: "mobile-375",
      use: {
        viewport: { width: 375, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "mobile-390",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    { name: "desktop-1280", use: { viewport: { width: 1280, height: 800 } } },
  ],
});
