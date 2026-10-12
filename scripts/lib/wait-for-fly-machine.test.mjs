import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { spawnSync } from "node:child_process";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SCRIPT = join(ROOT, "scripts", "ci", "wait-for-fly-machine.sh");
const EXPECTED_SHA = "a".repeat(40);
const directories = [];

function machine(options = {}) {
  const {
    id = "machine-1",
    state = "started",
    image = "registry.fly.io/reformaflow-api:deployment-01",
    config = {},
  } = options;
  const sha = Object.hasOwn(options, "sha") ? options.sha : EXPECTED_SHA;
  const labels = sha === undefined ? {} : { GH_SHA: sha };
  return {
    id,
    state,
    image_ref: { labels },
    config: { ...config, image },
  };
}

function fixtureBin() {
  const directory = mkdtempSync(join(tmpdir(), "rf-fly-machine-"));
  const bin = join(directory, "bin");
  directories.push(directory);
  mkdirSync(bin);

  const flyctl = join(bin, "flyctl");
  writeFileSync(
    flyctl,
    `#!/usr/bin/env node
const fs = require("node:fs");
const sequence = JSON.parse(process.env.FAKE_FLY_SEQUENCE);
const counter = process.env.FAKE_FLY_COUNTER;
const calls = process.env.FAKE_FLY_CALLS;
const index = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
fs.writeFileSync(counter, String(index + 1));
fs.appendFileSync(calls, JSON.stringify(process.argv.slice(2)) + "\\n");
const item = sequence[index] ?? sequence[sequence.length - 1];
if (item.error) {
  process.stderr.write(item.error);
  process.exit(item.status ?? 1);
}
process.stdout.write(item.raw ?? JSON.stringify(item.body));
`,
  );
  chmodSync(flyctl, 0o755);

  const sleep = join(bin, "sleep");
  writeFileSync(
    sleep,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.FAKE_SLEEP_CALLS, process.argv[2] + "\\n");
if (process.env.FAKE_TERM_DURING_SLEEP === "1") {
  process.kill(process.ppid, "SIGTERM");
}
`,
  );
  chmodSync(sleep, 0o755);

  return {
    bin,
    calls: join(directory, "fly.calls"),
    counter: join(directory, "fly.counter"),
    sleeps: join(directory, "sleep.calls"),
  };
}

function run(sequence, overrides = {}) {
  const fixture = fixtureBin();
  const result = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH}`,
      FLY_APP: "reformaflow-api",
      EXPECTED_GH_SHA: EXPECTED_SHA,
      MAX_ATTEMPTS: "10",
      POLL_INTERVAL_SECONDS: "0",
      FAKE_FLY_SEQUENCE: JSON.stringify(sequence),
      FAKE_FLY_COUNTER: fixture.counter,
      FAKE_FLY_CALLS: fixture.calls,
      FAKE_SLEEP_CALLS: fixture.sleeps,
      ...overrides,
    },
  });
  const calls = existsSync(fixture.calls)
    ? readFileSync(fixture.calls, "utf8").trim().split("\n")
    : [];
  const sleeps = existsSync(fixture.sleeps)
    ? readFileSync(fixture.sleeps, "utf8").trim().split("\n")
    : [];
  return { ...fixture, calls, result, sleeps };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("retries command errors and all non-converged snapshots until one exact machine starts", () => {
  const wrongSha = "b".repeat(40);
  const converged = machine();
  const { calls, result, sleeps } = run([
    { error: "FLY_API_TOKEN=must-not-leak\nconfig.env.SECRET=must-not-leak\n" },
    { body: [] },
    { body: [machine({ id: "old" }), machine({ id: "new" })] },
    { body: [machine({ state: "starting" })] },
    { body: [machine({ sha: undefined })] },
    { body: [machine({ sha: wrongSha })] },
    { body: [converged] },
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), converged);
  assert.equal(calls.length, 7);
  assert.deepEqual(
    calls.map(JSON.parse),
    Array(7).fill(["machines", "list", "--app", "reformaflow-api", "--json"]),
  );
  assert.equal(sleeps.length, 6);
  assert.doesNotMatch(result.stderr, /must-not-leak|FLY_API_TOKEN|config\.env/);
  assert.match(result.stderr, /attempt=1\/10 count=\?/);
  assert.match(result.stderr, /attempt=2\/10 count=0/);
  assert.match(result.stderr, /attempt=3\/10 count=2/);
  assert.match(result.stderr, /attempt=4\/10 count=1 .*state=starting/);
  assert.match(result.stderr, /attempt=5\/10 count=1 .*sha=-/);
  assert.match(
    result.stderr,
    new RegExp(`attempt=6/10 count=1 .*sha=${wrongSha}`),
  );
});

test("accepts convergence on the exact final attempt without a trailing sleep", () => {
  const converged = machine({ id: "final-machine" });
  const { calls, result, sleeps } = run(
    [
      { body: [machine({ state: "starting" })] },
      { body: [machine({ sha: "b".repeat(40) })] },
      { body: [converged] },
    ],
    { MAX_ATTEMPTS: "3", POLL_INTERVAL_SECONDS: "7" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), converged);
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, ["7", "7"]);
});

test("uses 30 attempts and ten-second intervals by default", () => {
  const { calls, result, sleeps } = run(
    [{ error: "transient command failure" }],
    { MAX_ATTEMPTS: "", POLL_INTERVAL_SECONDS: "" },
  );

  assert.equal(result.status, 1);
  assert.equal(calls.length, 30);
  assert.equal(sleeps.length, 29);
  assert.ok(sleeps.every((seconds) => seconds === "10"));
  assert.match(result.stderr, /attempt=30\/30/);
});

test("exhaustion emits only bounded sanitized machine summaries", () => {
  const unsafe = `${"x".repeat(500)}\nINJECTED secret`;
  const { result } = run(
    [
      {
        body: [
          machine({
            id: unsafe,
            state: unsafe,
            sha: unsafe,
            image: unsafe,
            config: {
              env: {
                DATABASE_URL: "never-print-database-url",
                FLY_API_TOKEN: "never-print-token",
              },
            },
          }),
        ],
      },
    ],
    { MAX_ATTEMPTS: "2" },
  );

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(
    result.stderr,
    /INJECTED|secret|DATABASE_URL|never-print|FLY_API_TOKEN|config|env/,
  );
  const lines = result.stderr.trim().split("\n");
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.match(
      line,
      /^attempt=\d+\/2 count=1 id=[^\s]+ state=[^\s]+ sha=[^\s]+ image=[^\s]+$/,
    );
    assert.ok(line.length <= 400, `diagnostic line is ${line.length} chars`);
  }
});

test("TERM repeats the latest sanitized summary and exits without leaking payloads", () => {
  const { result } = run(
    [
      {
        body: [
          machine({
            state: "starting",
            config: { env: { SECRET: "term-must-not-leak" } },
          }),
        ],
      },
    ],
    {
      FAKE_TERM_DURING_SLEEP: "1",
      MAX_ATTEMPTS: "3",
      POLL_INTERVAL_SECONDS: "10",
    },
  );

  assert.equal(result.status, 143);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /SECRET|term-must-not-leak|config|env/);
  const lines = result.stderr.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[1], lines[0]);
});
