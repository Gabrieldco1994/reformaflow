import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const host = "127.0.0.1";
const requiredPort = (name: string) => {
  const literal = process.env[name];
  const port = Number(literal);
  if (
    literal === undefined ||
    !/^\d+$/.test(literal) ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65_535
  )
    throw new Error(`${name} must be an integer from 1024 to 65535`);
  return port;
};
const apiPort = requiredPort("MARIA_CSV_REAL_API_PORT");
const webPort = requiredPort("MARIA_CSV_REAL_WEB_PORT");
if (apiPort === webPort)
  throw new Error(
    "MARIA_CSV_REAL_API_PORT and MARIA_CSV_REAL_WEB_PORT must be distinct",
  );
const webOrigin = `http://${host}:${webPort}`;
const apiOrigin = `http://${host}:${apiPort}`;
const preflight = resolve(__dirname, "port-preflight.cjs");
const moduleStubs = resolve(__dirname, "module-stubs");
const fontPreload = resolve(
  __dirname,
  "../maria-public-entry/font-loader-preload.cjs",
);
const fontResponses = resolve(
  __dirname,
  "../maria-public-entry/font-loader-responses.cjs",
);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export default defineConfig({
  testDir: "..",
  testMatch: "maria-csv-import.real.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  outputDir: resolve(
    __dirname,
    "../../../../.agents/maria-csv-import-real-playwright",
  ),
  use: {
    baseURL: webOrigin,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        browserName: "chromium",
      },
    },
  ],
  webServer: {
    command: [
      `node ${quote(preflight)}`,
      `npx next dev --hostname ${host} --port ${webPort}`,
    ].join(" && "),
    cwd: "../..",
    env: {
      TZ: "UTC",
      MARIA_CSV_REAL_API_PORT: String(apiPort),
      MARIA_CSV_REAL_WEB_PORT: String(webPort),
      NEXT_PUBLIC_API_URL: apiOrigin,
      NODE_PATH: [moduleStubs, process.env.NODE_PATH].filter(Boolean).join(":"),
      NODE_OPTIONS: `--require=${fontPreload}`,
      NEXT_FONT_GOOGLE_MOCKED_RESPONSES: fontResponses,
    },
    url: webOrigin,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
