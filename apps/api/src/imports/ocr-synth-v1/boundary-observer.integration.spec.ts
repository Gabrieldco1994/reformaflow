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
  CANONICAL_PROBE_CALL_EXPECTATIONS: Readonly<
    Record<
      string,
      Readonly<{ countTokensCalls: number; generationCalls: number }>
    >
  >;
  observeOcrBoundary(
    identity: string,
    assignedBoundary: string,
    scenarioSha256: string,
    execute: () => Promise<Record<string, unknown>>,
  ): Promise<Record<string, any>>;
  assertOcrFinancialStateUnchanged(value: unknown): void;
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
    typeof loaded.evaluateBoundaryObservations !== "function" ||
    typeof loaded.CANONICAL_PROBE_CALL_EXPECTATIONS !== "object" ||
    typeof loaded.observeOcrBoundary !== "function" ||
    typeof loaded.assertOcrFinancialStateUnchanged !== "function"
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

  const PROVIDER_CALL_PROBES = [
    "ADC_SCOPE_BOUNDED",
    "REQUEST_BODY_BOUNDED",
    "DEADLINE_BOUNDED",
    "MIXED_LOCAL_PROVIDER_DUPLICATION",
    "PARTIAL_RESPONSE",
    "MALFORMED_RESPONSE",
    "TRUNCATED_RESPONSE",
    "SAFETY_BLOCKED_RESPONSE",
    "AMBIGUOUS_TIMEOUT_RETRY",
    "UNKNOWN_OUTCOME_NO_RETRY",
    "SELECTED_TRUE_DEFAULT",
    "VERIFIED_DEFAULT",
    "KNOWN_SAFETY_FINISH_REASONS",
  ] as const;
  const FINANCIAL_TABLES = [
    "Expense",
    "CashFlowEntry",
    "Receipt",
    "RateioAllocation",
    "Settlement",
    "InvoiceLiquidation",
  ] as const;

  function observationRecord(value: unknown): Record<string, any> {
    if (!value || typeof value !== "object")
      throw new Error("BOUNDARY_TEST_FIXTURE_INVALID");
    return value as Record<string, any>;
  }

  function isProbeObservation(value: unknown): value is Record<string, any> {
    return String(observationRecord(value).identity).startsWith("[PROBE] ");
  }

  function isRouteObservation(value: unknown): value is Record<string, any> {
    return String(observationRecord(value).identity).startsWith("[ROUTE] ");
  }

  function exactZeroSixTableDeltas() {
    return {
      Expense: { count: 0, centValueSum: 0 },
      CashFlowEntry: { count: 0, centValueSum: 0 },
      Receipt: { count: 0, centValueSum: 0 },
      RateioAllocation: { count: 0, centValueSum: 0 },
      Settlement: { count: 0 },
      InvoiceLiquidation: { count: 0 },
    };
  }

  describe("canonical causal call tuples and financial observations", () => {
    it("keeps the application-owned map at exactly thirteen 1/1 and twenty-two 0/0 PROBEs", () => {
      const map = boundary().CANONICAL_PROBE_CALL_EXPECTATIONS;

      expect(Object.keys(map)).toEqual(PROBE_IDS);
      expect(
        Object.entries(map)
          .filter(
            ([, calls]) =>
              calls.countTokensCalls === 1 && calls.generationCalls === 1,
          )
          .map(([id]) => id),
      ).toEqual(PROVIDER_CALL_PROBES);
      expect(
        Object.values(map).filter(
          (calls) =>
            calls.countTokensCalls === 0 && calls.generationCalls === 0,
        ),
      ).toHaveLength(22);
    });

    it("enforces the canonical countTokens/generation tuple for every ROUTE and PROBE", async () => {
      const observations = await boundary().observeQualificationBoundaries();
      const routes = observations.filter(isRouteObservation);
      const probes = observations.filter(isProbeObservation);

      expect(routes).toHaveLength(10);
      expect(probes).toHaveLength(35);
      for (const route of routes)
        expect({
          countTokensCalls: route.countTokensCalls,
          generationCalls: route.generationCalls,
        }).toEqual({ countTokensCalls: 0, generationCalls: 0 });
      for (const probe of probes) {
        const id = String(probe.identity).slice("[PROBE] ".length);
        expect({
          countTokensCalls: probe.countTokensCalls,
          generationCalls: probe.generationCalls,
        }).toEqual(boundary().CANONICAL_PROBE_CALL_EXPECTATIONS[id]);
      }
    });

    it.each([
      ["countTokens", "countTokensCalls"],
      ["generation", "generationCalls"],
    ] as const)(
      "a wrong PROBE %s count produces BOUNDARY_CALL_COUNT_MISMATCH",
      async (_label, field) => {
        const observations = structuredClone(
          await boundary().observeQualificationBoundaries(),
        ).map(observationRecord);
        const probe = observations.find(isProbeObservation)!;
        probe[field] += 1;

        expect(boundary().evaluateBoundaryObservations(observations)).toEqual({
          releaseStatus: "GAPS",
          issues: ["BOUNDARY_CALL_COUNT_MISMATCH"],
        });
      },
    );

    it("binds before, after, deltas and mutation calls for all six financial tables", async () => {
      const observations = await boundary().observeQualificationBoundaries();

      for (const value of observations) {
        const observation = observationRecord(value);
        expect(Object.keys(observation.financial)).toEqual([
          "mutationCalls",
          "before",
          "after",
          "deltas",
        ]);
        expect(observation.financial.mutationCalls).toEqual({
          count: 0,
          operations: [],
        });
        expect(Object.keys(observation.financial.before)).toEqual(
          FINANCIAL_TABLES,
        );
        expect(Object.keys(observation.financial.after)).toEqual(
          FINANCIAL_TABLES,
        );
        expect(observation.financial.after).toEqual(
          observation.financial.before,
        );
        expect(observation.financial.deltas).toEqual(exactZeroSixTableDeltas());
        for (const table of FINANCIAL_TABLES.slice(0, 4)) {
          expect(observation.financial.before[table]).toEqual({
            count: expect.any(Number),
            centValueSum: expect.any(Number),
          });
        }
        for (const table of FINANCIAL_TABLES.slice(4)) {
          expect(observation.financial.before[table]).toEqual({
            count: expect.any(Number),
          });
        }
      }
    });

    it("captures row-level PrismaService snapshots including deletedAt instead of aggregate-only claims", async () => {
      const observations = await boundary().observeQualificationBoundaries();

      for (const value of observations) {
        const observation = observationRecord(value);
        expect(observation.financial.prismaService).toBe("PrismaService");
        expect(observation.financial.assertionPath).toEqual(
          expect.arrayContaining([expect.stringMatching(/\S/)]),
        );
        expect(observation.financial.mutationCalls).toEqual({
          count: 0,
          operations: [],
        });
        for (const phase of ["before", "after"] as const) {
          for (const table of FINANCIAL_TABLES) {
            const snapshot = observation.financial[phase][table];
            expect(snapshot).toHaveProperty("rows");
            expect(Array.isArray(snapshot.rows)).toBe(true);
            expect(snapshot.columns).toEqual(
              expect.arrayContaining(["id", "deletedAt"]),
            );
            for (const row of snapshot.rows) {
              expect(row).toEqual(
                expect.objectContaining({ id: expect.any(String) }),
              );
              expect(row).toHaveProperty("deletedAt");
              expect(
                row.deletedAt === null || typeof row.deletedAt === "string",
              ).toBe(true);
            }
          }
        }
      }
    });

    it("observeOcrBoundary executes and binds the assigned identity, boundary, scenario and measured tuple", async () => {
      const identity = "[PROBE] ADC_SCOPE_BOUNDED";
      const assignedBoundary = "VertexPdfOcrProvider.extractPdf";
      const scenarioSha256 = createHash("sha256")
        .update("assigned-real-scenario")
        .digest("hex");
      const execute = jest.fn(async () => ({
        outcome: "GUARDED",
        countTokensCalls: 1,
        generationCalls: 1,
        mutationOperations: [],
        assertionPath: [
          "VertexPdfOcrProvider.extractPdf",
          "countTokens",
          "generateContent",
        ],
      }));

      const observed = await boundary().observeOcrBoundary(
        identity,
        assignedBoundary,
        scenarioSha256,
        execute,
      );

      expect(execute).toHaveBeenCalledTimes(1);
      expect(observed).toMatchObject({
        identity,
        boundary: assignedBoundary,
        scenarioSha256,
        outcome: "GUARDED",
        countTokensCalls: 1,
        generationCalls: 1,
        mutationOperations: [],
        assertionPath: expect.arrayContaining([
          "VertexPdfOcrProvider.extractPdf",
          "countTokens",
          "generateContent",
        ]),
      });
    });

    it("assertOcrFinancialStateUnchanged rejects row replacement and observed mutation calls", () => {
      const snapshot = {
        mutationCalls: {
          count: 1,
          operations: ["Expense.update"],
        },
        before: {
          Expense: {
            rows: [{ id: "expense-1", deletedAt: null, centValue: 100 }],
          },
        },
        after: {
          Expense: {
            rows: [
              {
                id: "expense-1",
                deletedAt: "2026-10-14T12:00:00.000Z",
                centValue: 100,
              },
            ],
          },
        },
      };

      expect(() =>
        boundary().assertOcrFinancialStateUnchanged(snapshot),
      ).toThrow("FINANCIAL_WRITE_OBSERVED");
    });

    it.each([
      [
        "scenario hash",
        (observations: Array<Record<string, any>>) => {
          observations[0]!.scenarioSha256 = "0".repeat(64);
        },
        "BOUNDARY_SCENARIO_BINDING_INVALID",
      ],
      [
        "missing before snapshot",
        (observations: Array<Record<string, any>>) => {
          delete observations[0]!.financial.before;
        },
        "BOUNDARY_EVIDENCE_INVALID",
      ],
      [
        "missing after snapshot",
        (observations: Array<Record<string, any>>) => {
          delete observations[0]!.financial.after;
        },
        "BOUNDARY_EVIDENCE_INVALID",
      ],
      [
        "nonzero financial delta",
        (observations: Array<Record<string, any>>) => {
          observations[0]!.financial.deltas.Expense.count = 1;
        },
        "FINANCIAL_DELTA_NONZERO",
      ],
      [
        "zero net delta with an observed write",
        (observations: Array<Record<string, any>>) => {
          observations[0]!.financial.mutationCalls = 1;
        },
        "FINANCIAL_WRITE_OBSERVED",
      ],
      [
        "missing observation",
        (observations: Array<Record<string, any>>) => {
          observations.splice(0, 1);
        },
        "BOUNDARY_EVIDENCE_INCOMPLETE",
      ],
      [
        "duplicate observation",
        (observations: Array<Record<string, any>>) => {
          observations.splice(1, 0, structuredClone(observations[0]!));
        },
        "BOUNDARY_EVIDENCE_INCOMPLETE",
      ],
      [
        "reordered observation",
        (observations: Array<Record<string, any>>) => {
          [observations[0], observations[1]] = [
            observations[1]!,
            observations[0]!,
          ];
        },
        "BOUNDARY_EVIDENCE_INCOMPLETE",
      ],
    ] as const)(
      "rejects %s with the exact derived code",
      async (_label, mutate, code) => {
        const observations = structuredClone(
          await boundary().observeQualificationBoundaries(),
        ).map(observationRecord);
        mutate(observations);

        expect(boundary().evaluateBoundaryObservations(observations)).toEqual({
          releaseStatus: "GAPS",
          issues: [code],
        });
      },
    );
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
