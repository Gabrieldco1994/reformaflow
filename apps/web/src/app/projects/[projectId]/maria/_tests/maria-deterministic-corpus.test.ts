import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import candidateReport from "./fixtures/maria-deterministic-candidate-report.v2.json";
import {
  deterministicCorpusEvaluation as evaluation,
  evaluateDeterministicCase,
} from "./maria-deterministic-corpus";

const correctedClarifyIds = [
  "money-cent-voice",
  "money-thousands-br",
  "installments-eleven",
  "meaning-total-integral",
  "meaning-monthly-installment",
  "date-leap-day",
  "date-iso-like",
  "nonfocused-money-injection",
  "emoji-utf16-money",
  "targets-none-phrase",
  "privacy-hidden-project-canary",
  "privacy-hidden-card-canary",
  "privacy-hidden-expense-canary",
];
const positiveControlIds = [
  "project-room-integral-authorized",
  "decision-expense-keep",
  "money-cent-exact",
  "money-thousands-exact",
  "installments-eleven-exact",
  "meaning-total-exact",
  "meaning-installment-exact",
  "date-leap-day-exact",
  "date-iso-exact",
  "installments-six-isolated",
  "money-emoji-free-exact",
  "targets-none-exact",
];

function reportResult(id: string) {
  const result = evaluation.report.perCase.find((entry) => entry.id === id);
  expect(result, `missing report result ${id}`).toBeDefined();
  return result!;
}

describe("versioned deterministic Maria import corpus v2", () => {
  it("keeps the v1 retained artifact historical-only and out of baseline/candidate evidence", () => {
    const retainedIds = evaluation.corpus.semanticCases
      .slice(0, evaluation.corpus.historicalRetainedArtifact.caseCount)
      .map((testCase) => testCase.id);
    expect(retainedIds).toEqual(
      evaluation.historicalRetained.results.map((result) => result.id),
    );
    expect(evaluation.report.historicalRetainedArtifact).toEqual({
      role: "HISTORICAL_ONLY_NOT_BASELINE_OR_CANDIDATE",
      file: "maria-retained-report-results.v1.json",
      exactShaProvenance: "NOT_ASSERTED",
      reportSchema: "reformaflow.maria-import-eval-report/v2",
      setHash:
        "2a573c1be9b94896fd771c16e9ab2b74ab9207facca682abbb53348e0d9d2e30",
      caseCount: 22,
    });
    expect(evaluation.report).not.toHaveProperty("retainedEvidence");
    expect(evaluation.report).not.toHaveProperty("candidateCommit");
  });

  it("freezes the exact v2 dataset identity and published report bytes", () => {
    expect(evaluation.report.dataset).toEqual({
      file: "maria-deterministic-corpus.v2.json",
      version: "maria-deterministic-import-v2",
      sha256:
        "6a06cd871dbef6da5d41cb1cf0007aeef23af627e75bc5026debd9e2289b1c8e",
      bytes: 20949,
      cases: 46,
      retainedCases: 22,
      addedCases: 24,
    });
    const reportBytes = readFileSync(
      resolve(
        process.cwd(),
        "src/app/projects/[projectId]/maria/_tests/fixtures/maria-deterministic-candidate-report.v2.json",
      ),
    );
    expect(createHash("sha256").update(reportBytes).digest("hex")).toBe(
      "f23ff999c9ab18ff855d1820af7c93660834fcde8bc8dca8c25c1fbe8b98a79f",
    );
  });

  it("publishes the exact fresh candidate result as a machine-readable v2 artifact", () => {
    expect(candidateReport).toEqual(evaluation.report);
  });

  it("keeps all unsafe, prose, and injection literals on the clarification path", () => {
    expect(evaluation.expectationChangeIds).toEqual(correctedClarifyIds);
    expect(
      correctedClarifyIds.map((id) => ({
        id,
        expected: reportResult(id).expected,
        actual: reportResult(id).actual,
      })),
    ).toEqual(
      correctedClarifyIds.map((id) => ({
        id,
        expected: { outcome: "CLARIFY" },
        actual: { outcome: "CLARIFY" },
      })),
    );
  });

  it("locks the exact positive-control list and requires every control to produce VALUE", () => {
    expect(evaluation.positiveControlIds).toEqual(positiveControlIds);
    expect(
      evaluation.corpus.semanticCases
        .filter((testCase) => testCase.tags.includes("positive-control"))
        .map((testCase) => testCase.id),
    ).toEqual(positiveControlIds);
    for (const id of positiveControlIds) {
      const result = reportResult(id);
      expect(result.expected.outcome, `${id} expected outcome`).toBe("VALUE");
      expect(result.actual.outcome, `${id} actual outcome`).toBe("VALUE");
      expect(result.actual, `${id} exact positive output`).toEqual(
        result.expected,
      );
    }
  });

  it("mirrors the natural-match waiver shape without exposing receipt KEEP", () => {
    expect(reportResult("decision-natural-waiver")).toMatchObject({
      actual: {
        outcome: "VALUE",
        resolvedValue: {
          kind: "CREATE",
          acceptNaturalDuplicate: true,
        },
      },
      contextProjection: { candidateExpenseIds: [] },
      authorizationValid: true,
      passed: true,
    });
  });

  it("blocks KEEP and CREATE for an incompatible strong receipt conflict", () => {
    for (const id of [
      "decision-receipt-keep",
      "decision-receipt-strong-create-blocked",
    ]) {
      expect(reportResult(id)).toMatchObject({
        actual: { outcome: "CLARIFY" },
        error: { code: "CLARIFY" },
        contextProjection: { candidateExpenseIds: [] },
        authorizationValid: true,
        passed: true,
      });
    }
  });

  it.each([
    [
      "project",
      "privacy-project-visible-baseline",
      "privacy-hidden-project-canary",
      "withheld-project-7f2a",
    ],
    [
      "card",
      "privacy-card-visible-baseline",
      "privacy-hidden-card-canary",
      "withheld-card-4c9d",
    ],
    [
      "expense",
      "privacy-expense-visible-baseline",
      "privacy-hidden-expense-canary",
      "withheld-expense-8b31",
    ],
  ])(
    "proves %s hidden-context noninterference in the scoped evaluator surface",
    (_kind, baselineId, hiddenId, canary) => {
      const baseline = reportResult(baselineId);
      const hidden = reportResult(hiddenId);
      const behavior = ({
        actual,
        error,
        schemaValid,
        authorizationValid,
        contextProjection,
      }: typeof baseline) => ({
        actual,
        error,
        schemaValid,
        authorizationValid,
        contextProjection,
      });

      expect(behavior(hidden)).toEqual(behavior(baseline));
      expect(JSON.stringify(behavior(hidden))).not.toContain(canary);
      expect(hidden.privacySafe).toBe(true);
    },
  );

  it("keeps the privacy oracle sensitive when an authorized visible canary is exposed", () => {
    const privacyProbeId = "visible-expense-canary";
    const result = evaluateDeterministicCase({
      id: "privacy-oracle-visible-sensitivity",
      field: "decision",
      literal: privacyProbeId,
      context: {
        decisionLineIds: ["line-current"],
        decisionCandidates: [
          {
            id: privacyProbeId,
            lineId: "line-current",
            kind: "EXPENSE",
            reason: "STRONG_IDENTITY",
            canKeepExisting: true,
          },
        ],
      },
      expected: {
        outcome: "VALUE",
        resolvedValue: {
          kind: "KEEP_EXISTING",
          expenseId: privacyProbeId,
        },
      },
      gates: ["privacy", "schema"],
      tags: ["privacy-oracle"],
      channel: "TEXT",
      privacyProbeId,
    });

    expect(result.actual).toEqual({
      outcome: "VALUE",
      resolvedValue: {
        kind: "KEEP_EXISTING",
        expenseId: privacyProbeId,
      },
    });
    expect(result.authorizationValid).toBe(true);
    expect(result.privacySafe).toBe(false);
    expect(result.passed).toBe(false);
  });

  it.each(evaluation.report.perCase)(
    "$id has its exact expected deterministic output",
    (result) => {
      expect(result.actual).toEqual(result.expected);
      expect(result.schemaValid).toBe(true);
      expect(result.authorizationValid).toBe(true);
      expect(result.privacySafe).toBe(true);
      expect(result).not.toHaveProperty("counters");
    },
  );

  it("labels side effects as unexercised and reserves observed counters for live evidence", () => {
    expect(evaluation.report.sideEffectCounters).toEqual({
      provenance: "STRUCTURAL_PURE_EVALUATOR_NOT_EXERCISED",
      observed: null,
      reservedFor: "FINAL_LIVE_UI_API_EVIDENCE",
      fields: [
        "autoSubmits",
        "financeBeforeExplicitConfirmation",
        "providerRequests",
        "toolExecutions",
        "financialExecutions",
      ],
    });
    expect(evaluation.report).not.toHaveProperty("counters");
  });

  it("records bounded provenance without claiming a final composed SHA or external privacy", () => {
    expect(evaluation.report.provenance).toEqual({
      evaluatorSource:
        "apps/web/src/app/projects/[projectId]/maria/_tests/maria-deterministic-corpus.ts",
      baseCommit: "881e9b5cd3215b79c7c6c7c37614b70e26f5acd8",
      acceptedFrontendCommit: "555963f1cc50078996054a105f5923b92a234003",
      parentQaCommit: "2bc17724e836678f2f8b3f26c8a7cab81dcfd8b4",
      followUpCommit: "NOT_ASSERTED_UNTIL_FINAL_COMPOSITION",
      finalCandidateCommit: "NOT_ASSERTED_UNTIL_FINAL_COMPOSITION",
    });
    expect(evaluation.report.execution).toEqual({
      command:
        "TZ=UTC npx vitest run 'src/app/projects/[projectId]/maria/_tests/maria-deterministic-corpus.test.ts'",
      runtime: { node: "v24.13.0", vitest: "2.1.9", npm: "11.6.2" },
      timezone: "UTC",
      provider: "N/A",
      model: "N/A",
    });
    expect(evaluation.report.generation).toEqual({
      generatedAt: "NOT_APPLICABLE_DETERMINISTIC_STATIC_ARTIFACT",
      policy: "DETERMINISTIC_STATIC_NO_WALL_CLOCK",
    });
    expect(evaluation.report.privacy).toMatchObject({
      metricScope: "PURE_EVALUATOR_RESULT_AND_CONTEXT_PROJECTION_ONLY",
      excludedClaims: [
        "REQUEST",
        "LOG",
        "PROVIDER",
        "MODEL",
        "TOOL",
        "API",
        "UI",
      ],
    });
  });

  it("meets every locked pure-evaluator quality gate", () => {
    expect(evaluation.report.thresholds).toEqual({
      moneyExactRate: 1,
      authorizationRate: 1,
      schemaValidityRate: 1,
      privacySafeRate: 1,
      exactCaseRate: 1,
    });
    expect(evaluation.report.scores).toEqual({
      moneyExactRate: 1,
      authorizationRate: 1,
      schemaValidityRate: 1,
      privacySafeRate: 1,
      exactCaseRate: 1,
    });
  });
});
