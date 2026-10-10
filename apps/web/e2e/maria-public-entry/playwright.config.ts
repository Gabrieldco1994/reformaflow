import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const origin = "http://127.0.0.1:43142";
const apiOrigin = "http://127.0.0.1:43141";
const preload = resolve(__dirname, "font-loader-preload.cjs");
const preflight = resolve(__dirname, "font-loader-preflight.cjs");
const responses = resolve(__dirname, "font-loader-responses.cjs");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export default defineConfig({
  testDir: "..",
  testMatch: "maria-public-import-entry.gatespec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: { baseURL: origin },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], browserName: "chromium" },
    },
  ],
  webServer: {
    command: [
      `TZ=UTC node --require ${quote(preload)} ${quote(preflight)}`,
      `TZ=UTC NEXT_FONT_GOOGLE_MOCKED_RESPONSES=${quote(responses)} npx next dev --hostname 127.0.0.1 --port 43142`,
    ].join(" && "),
    cwd: "../..",
    env: { NEXT_PUBLIC_API_URL: apiOrigin },
    url: origin,
    reuseExistingServer: false,
  },
});
