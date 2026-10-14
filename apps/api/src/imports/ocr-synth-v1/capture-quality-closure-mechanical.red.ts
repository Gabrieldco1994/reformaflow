import { resolve } from "node:path";
import { QUALIFICATION_TEST_NAMES } from "./quality-closure-test-contract";

const ROOT = resolve(__dirname, "../../../../..");
const QUALIFIER_SPEC = resolve(__dirname, "quality-closure.qualify.spec.ts");

interface MachineAssertion {
  fullName: string;
  status: string;
  failureMessages: string[];
}

interface MachineResult {
  success: boolean;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  numTodoTests: number;
  testResults: Array<{
    name: string;
    status: string;
    message: string;
    assertionResults: MachineAssertion[];
  }>;
}

function canonicalMachineResult(): MachineResult {
  return {
    success: true,
    numPassedTests: 45,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [
      {
        name: QUALIFIER_SPEC,
        status: "passed",
        message: "",
        assertionResults: QUALIFICATION_TEST_NAMES.map((fullName) => ({
          fullName,
          status: "passed",
          failureMessages: [],
        })),
      },
    ],
  };
}

async function runCaptureCli(
  machineResult: MachineResult | MachineResult[],
  injectedEnv: Record<string, string | undefined> = {},
) {
  jest.resetModules();
  const events: string[] = [];
  let published: unknown;
  const stderr: string[] = [];
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  const savedEnv = new Map(
    Object.keys(injectedEnv).map((key) => [key, process.env[key]]),
  );
  process.argv = ["node", "capture-live.ts", "evidence.json", "manifest.json"];
  process.exitCode = undefined;
  for (const [key, value] of Object.entries(injectedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  class MockProvider {
    ready() {
      return true;
    }
  }
  const machineResults = Array.isArray(machineResult)
    ? [...machineResult]
    : [machineResult, machineResult];

  const execFile = jest.fn(
    (
      executable: string,
      args: string[],
      _options: unknown,
      callback: (
        error: Error | null,
        result: { stdout: string; stderr: string },
      ) => void,
    ) => {
      if (executable === "git" && args[0] === "rev-parse") {
        events.push("git-head");
        callback(null, { stdout: `${"a".repeat(40)}\n`, stderr: "" });
        return;
      }
      if (executable === "git" && args[0] === "status") {
        events.push("git-clean");
        callback(null, { stdout: "", stderr: "" });
        return;
      }
      if (args.includes("quality-closure.qualify.jest.config.cjs")) {
        events.push("jest-qualification");
        callback(null, {
          stdout: JSON.stringify(machineResults.shift() ?? machineResult),
          stderr: "",
        });
        return;
      }
      events.push("unexpected-command");
      callback(new Error("UNEXPECTED_COMMAND"), { stdout: "", stderr: "" });
    },
  );

  jest.doMock("node:child_process", () => ({ execFile }));
  jest.doMock("node:fs/promises", () => ({
    readFile: jest.fn(async () => "{}"),
  }));
  jest.doMock("./capture-live-core", () => ({
    parseCaptureLiveManifestJson: jest.fn(() => ({ candidateSha: "fixture" })),
    captureLiveEvidence: jest.fn(async () => {
      events.push("provider-dispatch");
      return { marker: "captured-evidence" };
    }),
  }));
  jest.doMock("./capture-live-file", () => ({
    writeLiveEvidenceExclusive: jest.fn(
      async (
        _path: string,
        factory: () => Promise<unknown>,
        verify: () => Promise<void>,
      ) => {
        events.push("output-reserved");
        published = await factory();
        await verify();
        events.push("output-published");
      },
    ),
  }));
  jest.doMock("../import-session/ocr/vertex-pdf-ocr.provider", () => ({
    VertexPdfOcrProvider: MockProvider,
  }));
  jest.doMock("../import-session/ocr/vertex-provider.factory", () => ({
    createConfiguredVertexPdfOcrProvider: jest.fn(async () => {
      events.push("provider-created");
      return new MockProvider();
    }),
  }));
  const stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);

  try {
    jest.isolateModules(() => {
      require("./capture-live");
    });
    for (let tick = 0; tick < 10; tick++)
      await new Promise((resolveTick) => setImmediate(resolveTick));
    return { events, published, stderr: stderr.join("") };
  } finally {
    stderrSpy.mockRestore();
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("capture quality-closure orchestration RED", () => {
  it("reserves output, proves a clean snapshot, and runs fixed Jest before provider dispatch", async () => {
    const result = await runCaptureCli(canonicalMachineResult());
    const index = (event: string) => result.events.indexOf(event);
    expect(index("output-reserved")).toBeGreaterThanOrEqual(0);
    expect(index("git-clean")).toBeGreaterThan(index("output-reserved"));
    expect(index("jest-qualification")).toBeGreaterThan(index("git-clean"));
    expect(index("provider-created")).toBeGreaterThan(
      index("jest-qualification"),
    );
    expect(index("provider-dispatch")).toBeGreaterThan(
      index("provider-created"),
    );
    expect(
      result.events.filter((event) => event === "jest-qualification"),
    ).toHaveLength(2);
  });

  it("emits mandatory mechanically-derived qualityClosure", async () => {
    const result = await runCaptureCli(canonicalMachineResult());
    expect(result.published).toEqual(
      expect.objectContaining({
        qualityClosure: expect.objectContaining({
          tests: QUALIFICATION_TEST_NAMES.map((name) => ({
            name,
            status: "PASS",
          })),
        }),
      }),
    );
  });

  it.each([
    ["JSON", { OCR_SYNTH_QUALIFICATION_RESULTS_JSON: "{}" }],
    [
      "path",
      { OCR_SYNTH_QUALIFICATION_RESULTS_PATH: "/tmp/caller-results.json" },
    ],
  ])(
    "rejects caller-injected Jest result %s before dispatch",
    async (_label, env) => {
      const result = await runCaptureCli(canonicalMachineResult(), env);
      expect(result.events).not.toContain("provider-created");
      expect(result.events).not.toContain("provider-dispatch");
      expect(result.stderr).toContain("LIVE_CAPTURE_CONFIG_INVALID");
    },
  );

  it("rejects every noncanonical machine result before dispatch", async () => {
    const mutations: Array<[string, (value: MachineResult) => void]> = [
      [
        "missing",
        (value) => {
          value.testResults[0]!.assertionResults.shift();
          value.numPassedTests--;
        },
      ],
      [
        "duplicate",
        (value) => {
          value.testResults[0]!.assertionResults[1] =
            value.testResults[0]!.assertionResults[0]!;
        },
      ],
      [
        "unknown",
        (value) => {
          value.testResults[0]!.assertionResults[0]!.fullName =
            "[PROBE] UNKNOWN";
        },
      ],
      [
        "failed",
        (value) => {
          value.success = false;
          value.numPassedTests--;
          value.numFailedTests++;
          value.testResults[0]!.assertionResults[0]!.status = "failed";
          value.testResults[0]!.assertionResults[0]!.failureMessages = [
            "canonical failure",
          ];
        },
      ],
      [
        "pending",
        (value) => {
          value.numPassedTests--;
          value.numPendingTests++;
          value.testResults[0]!.assertionResults[0]!.status = "pending";
        },
      ],
      [
        "todo",
        (value) => {
          value.numPassedTests--;
          value.numTodoTests++;
          value.testResults[0]!.assertionResults[0]!.status = "todo";
        },
      ],
      [
        "skipped",
        (value) => {
          value.numPassedTests--;
          value.numPendingTests++;
          value.testResults[0]!.assertionResults[0]!.status = "skipped";
        },
      ],
      [
        "runtime-error",
        (value) => {
          value.success = false;
          value.testResults[0]!.status = "failed";
          value.testResults[0]!.message = "runtime error";
        },
      ],
      [
        "noncanonical-failure",
        (value) => {
          value.testResults[0]!.assertionResults[0]!.failureMessages = [
            "failure attached to passed assertion",
          ];
        },
      ],
      [
        "wrong-source",
        (value) => {
          value.testResults[0]!.name = resolve(ROOT, "other.spec.ts");
        },
      ],
    ];
    const dispatches: string[] = [];
    for (const [label, mutate] of mutations) {
      const changed = canonicalMachineResult();
      mutate(changed);
      const result = await runCaptureCli(changed);
      if (
        result.events.includes("provider-created") ||
        result.events.includes("provider-dispatch") ||
        !result.stderr.includes("LIVE_CAPTURE_PREFLIGHT_FAILED")
      )
        dispatches.push(label);
    }
    expect(dispatches).toEqual([]);
  });

  it("rejects a non-identical canonical attestation from the mandatory rerun", async () => {
    const initial = canonicalMachineResult();
    const rerun = canonicalMachineResult();
    rerun.testResults[0]!.assertionResults.reverse();
    const result = await runCaptureCli([initial, rerun]);
    expect(
      result.events.filter((event) => event === "jest-qualification"),
    ).toHaveLength(2);
    expect(result.events).not.toContain("provider-created");
    expect(result.events).not.toContain("provider-dispatch");
    expect(result.stderr).toContain("LIVE_CAPTURE_PREFLIGHT_FAILED");
  });
});
