import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export type Issue716LiveEvalConfig =
  | {
      enabled: false;
      credentialConfigured: false;
      reason: "EXPLICIT_OPT_IN_REQUIRED";
    }
  | {
      enabled: true;
      credentialConfigured: true;
      baseUrl: string;
      databasePath: string;
      privateVaultPath: string;
      repetitions: 3;
      expectedPairedTurns: 174;
    };

function disposablePath(
  value: string | undefined,
  label: string,
  repositoryRoot: string,
) {
  if (!value) throw new Error(`${label} is required for the live eval`);
  const path = realpathSync(resolve(value.replace(/^file:/, "")));
  const devDatabases = [
    resolve(repositoryRoot, "prisma/dev.db"),
    resolve(repositoryRoot, "../../prisma/dev.db"),
  ];
  if (
    devDatabases.includes(path) ||
    path.endsWith("/prisma/dev.db") ||
    (!path.startsWith("/private/") && !path.startsWith("/tmp/"))
  )
    throw new Error(`${label} must resolve to a disposable private path`);
  return path;
}

/**
 * Test-only live-eval admission. It deliberately has no dotenv dependency and
 * accepts no env-file argument. The Gemini credential can only be inherited
 * from the already-exported parent environment and is never returned.
 */
export function issue716LiveEvalConfig(
  environment: NodeJS.ProcessEnv = process.env,
  repositoryRoot = resolve(__dirname, "../../../../../.."),
): Issue716LiveEvalConfig {
  if (environment.RUN_LIVE_GEMINI_EVAL !== "1")
    return {
      enabled: false,
      credentialConfigured: false,
      reason: "EXPLICIT_OPT_IN_REQUIRED",
    };
  if (environment.CI)
    throw new Error("Issue #716 live Gemini eval is forbidden in CI");
  if (!environment.GEMINI_API_KEY)
    throw new Error(
      "GEMINI_API_KEY must already be exported by the parent process",
    );

  const baseUrl = environment.ISSUE_716_LIVE_EVAL_BASE_URL;
  if (!baseUrl) throw new Error("ISSUE_716_LIVE_EVAL_BASE_URL is required");
  const parsed = new URL(baseUrl);
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new Error("Live eval harness must be an uncredentialed loopback URL");

  return {
    enabled: true,
    credentialConfigured: true,
    baseUrl: parsed.origin,
    databasePath: disposablePath(
      environment.DATABASE_URL,
      "DATABASE_URL",
      repositoryRoot,
    ),
    privateVaultPath: disposablePath(
      environment.PRIVATE_UPLOADS_DIR,
      "PRIVATE_UPLOADS_DIR",
      repositoryRoot,
    ),
    repetitions: 3,
    expectedPairedTurns: 174,
  };
}
