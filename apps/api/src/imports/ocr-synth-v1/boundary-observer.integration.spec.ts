import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { OCR_SYNTH_ROUTING_CASES } from "./corpus";
import policy from "./quality-closure-policy.json";

const MODULE_PATH = "./boundary-observer";
const PROBE_IDS = policy.qualificationTests
  .map(({ name }) => name)
  .filter((name) => name.startsWith("[PROBE] "))
  .map((name) => name.slice("[PROBE] ".length));
const ROUTE_IDS = OCR_SYNTH_ROUTING_CASES.map((item) => item.id);
const FORBIDDEN_CLAIMS = [
  "pass",
  "blocked",
  "source",
  "testFile",
  "durableStateVerified",
] as const;

type ObserverModule = Readonly<{
  observeQualificationBoundaries(): Promise<readonly unknown[]>;
  parseLiveCaptureInput(value: unknown): unknown;
  evaluateBoundaryObservations(value: readonly unknown[]): {
    releaseStatus: "PASS" | "GAPS";
    issues: readonly string[];
  };
}>;

function loadObserverBoundary():
  | { kind: "READY"; value: ObserverModule }
  | {
      kind: "BOUNDARY_UNAVAILABLE";
      code: "OCR_BOUNDARY_OBSERVER_NOT_IMPLEMENTED";
    } {
  if (!existsSync(join(__dirname, "boundary-observer.ts")))
    return {
      kind: "BOUNDARY_UNAVAILABLE",
      code: "OCR_BOUNDARY_OBSERVER_NOT_IMPLEMENTED",
    };
  const loaded = require(MODULE_PATH) as Partial<ObserverModule>;
  if (
    typeof loaded.observeQualificationBoundaries !== "function" ||
    typeof loaded.parseLiveCaptureInput !== "function" ||
    typeof loaded.evaluateBoundaryObservations !== "function"
  )
    return {
      kind: "BOUNDARY_UNAVAILABLE",
      code: "OCR_BOUNDARY_OBSERVER_NOT_IMPLEMENTED",
    };
  return { kind: "READY", value: loaded as ObserverModule };
}

function boundary(): ObserverModule {
  const loaded = loadObserverBoundary();
  expect(loaded).toMatchObject({ kind: "READY" });
  if (loaded.kind !== "READY") throw new Error(loaded.code);
  return loaded.value;
}

const sixZeroDeltas = Object.freeze({
  Expense: 0,
  CashFlowEntry: 0,
  Receipt: 0,
  RateioAllocation: 0,
  Settlement: 0,
  InvoiceLiquidation: 0,
});

describe("45 causal production boundary observations", () => {
  it("positive control pins exactly ten ROUTEs and thirty-five PROBEs", () => {
    expect(ROUTE_IDS).toEqual(
      Array.from(
        { length: 10 },
        (_, index) => `mixed-${String(index + 1).padStart(3, "0")}`,
      ),
    );
    expect(PROBE_IDS).toHaveLength(35);
    expect(new Set(PROBE_IDS).size).toBe(35);
  });

  it("emits exactly the ten ROUTE observations from the real analyze boundary", async () => {
    const observations = await boundary().observeQualificationBoundaries();
    const routes = observations.filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" &&
        item !== null &&
        String((item as Record<string, unknown>).identity).startsWith(
          "[ROUTE] ",
        ),
    );

    expect(routes.map((item) => item.identity)).toEqual(
      ROUTE_IDS.map((id) => `[ROUTE] ${id}`),
    );
    for (const route of routes) {
      expect(route).toMatchObject({
        boundary: "ImportSessionExtractionService.analyzeAttached",
        scenarioSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        outcome: "ROUTED_LOCALLY",
        countTokensCalls: 0,
        generationCalls: 0,
        financialDeltas: sixZeroDeltas,
      });
      for (const claim of FORBIDDEN_CLAIMS)
        expect(route).not.toHaveProperty(claim);
    }
  });

  it("emits exactly the thirty-five PROBE observations from assigned boundaries", async () => {
    const observations = await boundary().observeQualificationBoundaries();
    const probes = observations.filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" &&
        item !== null &&
        String((item as Record<string, unknown>).identity).startsWith(
          "[PROBE] ",
        ),
    );

    expect(probes.map((item) => item.identity)).toEqual(
      PROBE_IDS.map((id) => `[PROBE] ${id}`),
    );
    expect(new Set(probes.map((item) => item.identity)).size).toBe(35);
    for (const probe of probes) {
      expect(probe).toMatchObject({
        boundary: expect.stringMatching(/^[A-Za-z][A-Za-z0-9_.]+$/),
        scenarioSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        financialDeltas: sixZeroDeltas,
      });
      for (const claim of FORBIDDEN_CLAIMS)
        expect(probe).not.toHaveProperty(claim);
    }
    expect(boundary().evaluateBoundaryObservations(probes)).toMatchObject({
      releaseStatus: expect.stringMatching(/^(?:PASS|GAPS)$/),
    });
  });

  it("rejects caller supplied ROUTE and PROBE claims", () => {
    const claimed = {
      identity: "[PROBE] MISSING_CONSENT",
      boundary: "claimed",
      scenarioSha256: createHash("sha256").update("claimed").digest("hex"),
      pass: true,
      blocked: true,
      source: "REAL_SERVICE_TEST_WITH_EXTERNAL_MODEL_MOCKED",
      testFile: "claimed.spec.ts",
      durableStateVerified: true,
    };

    expect(() => boundary().parseLiveCaptureInput([claimed])).toThrow(
      "LIVE_CAPTURE_INPUT_SCHEMA_INVALID",
    );
  });

  it.each([
    ["endpoint global", "GLOBAL_ENDPOINT_ACCEPTED"],
    ["API key", "API_KEY_ACCEPTED"],
    ["page 11", "PAGE_LIMIT_NOT_ENFORCED"],
    ["partial accounting", "PARTIAL_ACCOUNTING_ACCEPTED"],
    ["malformed duplicate key", "DUPLICATE_KEY_ACCEPTED"],
    ["timeout retry", "AMBIGUOUS_TIMEOUT_RETRIED"],
    ["missing consent", "MISSING_CONSENT_ACCEPTED"],
    ["capability OFF", "CAPABILITY_OFF_DISPATCHED"],
    ["budget race", "BUDGET_RACE_ADMITTED"],
    ["financial write", "FINANCIAL_WRITE_OBSERVED"],
    ["tenant swap", "TENANT_BOUNDARY_BROKEN"],
  ] as const)(
    "production guard mutation %s changes its causal observation",
    async (mutation, issue) => {
      const observations = (
        await boundary().observeQualificationBoundaries()
      ).map((item, index) =>
        index === 0 && typeof item === "object" && item !== null
          ? { ...(item as Record<string, unknown>), mutation }
          : item,
      );

      expect(boundary().evaluateBoundaryObservations(observations)).toEqual({
        releaseStatus: "GAPS",
        issues: expect.arrayContaining([issue]),
      });
    },
  );

  it("removing one of the 45 observations makes release incomplete", async () => {
    const observations = await boundary().observeQualificationBoundaries();

    expect(
      boundary().evaluateBoundaryObservations(observations.slice(1)),
    ).toEqual({
      releaseStatus: "GAPS",
      issues: expect.arrayContaining(["BOUNDARY_EVIDENCE_INCOMPLETE"]),
    });
  });
});
