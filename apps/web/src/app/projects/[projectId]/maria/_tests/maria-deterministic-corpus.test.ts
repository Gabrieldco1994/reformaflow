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
const eligibleContextProjectionCaseIds = [
  "project-room-integral-authorized",
  "project-integral-without-room",
  "project-integral-foreign-room",
  "project-integral-without-authorized-destination",
  "decision-natural-waiver",
  "decision-expense-keep",
  "decision-receipt-keep",
  "decision-foreign-candidate",
  "decision-receipt-strong-create-blocked",
];

function reportResult(id: string) {
  const result = evaluation.report.perCase.find((entry) => entry.id === id);
  expect(result, `missing report result ${id}`).toBeDefined();
  return result!;
}

describe("versioned deterministic Maria import corpus v2", () => {
  it("dispatches real TEXT fields to strict focused-draft parsing", () => {
    expect(
      evaluateDeterministicCase({
        id: "text-meaning-enum",
        field: "amountMeaning",
        literal: "TOTAL_PURCHASE",
        channel: "TEXT",
        gates: ["schema"],
        tags: ["channel-dispatch"],
        privacyProbeId: null,
        expected: {
          outcome: "VALUE",
          resolvedValue: "TOTAL_PURCHASE",
        },
      }).actual,
    ).toEqual({ outcome: "VALUE", resolvedValue: "TOTAL_PURCHASE" });
  });

  it("keeps unsupported VOICE choices and TEXT merchant closed", () => {
    const base = {
      gates: ["schema"],
      tags: ["channel-dispatch"],
      privacyProbeId: null,
    };
    for (const testCase of [
      {
        ...base,
        id: "voice-decision-is-unsupported",
        field: "decision" as const,
        literal: "expense-current",
        channel: "VOICE" as const,
        context: {
          decisionLineIds: ["line-current"],
          decisionCandidates: [
            {
              id: "expense-current",
              lineId: "line-current",
              kind: "EXPENSE" as const,
              reason: "STRONG_IDENTITY" as const,
              canKeepExisting: true,
            },
          ],
        },
        expected: { outcome: "CLARIFY" as const },
      },
      {
        ...base,
        id: "voice-target-is-unsupported",
        field: "targets" as const,
        literal: "target",
        channel: "VOICE" as const,
        context: {
          amountCents: 20696,
          ownerProjectId: "project-owner",
          projectId: "project-reforma",
          roomId: null,
          targetProjects: [
            {
              id: "project-reforma",
              projectType: "REFORMA",
              active: true,
              deletedAt: null,
              eligible: true,
              rooms: [],
            },
          ],
        },
        expected: { outcome: "CLARIFY" as const },
      },
      {
        ...base,
        id: "text-merchant-is-unsupported",
        field: "merchant" as const,
        literal: "Mercado Central",
        channel: "TEXT" as const,
        expected: { outcome: "CLARIFY" as const },
      },
    ]) {
      expect(evaluateDeterministicCase(testCase).actual).toEqual({
        outcome: "CLARIFY",
      });
    }
  });

  it("reports only synthetic eligible-context projection, never authorization", () => {
    const nonApplicable = reportResult("money-cent-exact");

    expect(nonApplicable).not.toHaveProperty("authorizationValid");
    expect(nonApplicable).toHaveProperty(
      "eligibleContextProjectionValid",
      null,
    );
    expect(evaluation.report.thresholds).not.toHaveProperty(
      "authorizationRate",
    );
    expect(evaluation.report.scores).not.toHaveProperty("authorizationRate");
    expect(evaluation.report).toMatchObject({
      eligibleContextProjection: {
        scope: "PURE_SYNTHETIC_ELIGIBLE_CONTEXT_PROJECTION_ONLY",
        excludedClaims: [
          "AUTHORIZATION",
          "API",
          "TENANT_ISOLATION",
          "GUARDS",
          "SERVER_REVALIDATION",
        ],
      },
    });
  });

  it("pins the eligible-context projection denominator to exact context-sensitive cases", () => {
    expect(
      evaluation.corpus.semanticCases
        .filter((testCase) =>
          testCase.gates.includes("eligibleContextProjection"),
        )
        .map((testCase) => testCase.id),
    ).toEqual(eligibleContextProjectionCaseIds);
    expect(
      evaluation.report.eligibleContextProjection.denominatorCaseIds,
    ).toEqual(eligibleContextProjectionCaseIds);
    expect(
      evaluation.report.perCase
        .filter((result) => result.eligibleContextProjectionValid !== null)
        .map((result) => result.id),
    ).toEqual(eligibleContextProjectionCaseIds);
  });

  it("uses non-circular external candidate identity and report self-hash policies", () => {
    expect(evaluation.report.provenance).toEqual({
      evaluatorSource:
        "apps/web/src/app/projects/[projectId]/maria/_tests/maria-deterministic-corpus.ts",
      repository: "Gabrieldco1994/reformaflow",
      acceptedImplementationBase: "555963f1cc50078996054a105f5923b92a234003",
      candidateIdentityPolicy: "EXTERNAL_GIT_COMMIT_AND_CHECK_RUN",
      selfHashPolicy: "EXTERNAL_SHA256_PIN_NOT_EMBEDDED_TO_AVOID_CIRCULARITY",
    });
  });

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
        "8217847adf75e3b91aabf1b8d312ec4d5e9bfc21cdea84931e5f03933433470b",
      bytes: 20830,
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
      "f1bb922b8dc584cbda26cbaa5b0ea2654f1c2aeaf491cd53169d75c068085964",
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
      eligibleContextProjectionValid: true,
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
        eligibleContextProjectionValid: true,
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
        eligibleContextProjectionValid,
        contextProjection,
      }: typeof baseline) => ({
        actual,
        error,
        schemaValid,
        eligibleContextProjectionValid,
        contextProjection,
      });

      expect(behavior(hidden)).toEqual(behavior(baseline));
      expect(JSON.stringify(behavior(hidden))).not.toContain(canary);
      expect(hidden.privacySafe).toBe(true);
    },
  );

  it("keeps the privacy oracle sensitive when a visible canary is exposed", () => {
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
    expect(result.eligibleContextProjectionValid).toBeNull();
    expect(result.privacySafe).toBe(false);
    expect(result.passed).toBe(false);
  });

  it.each(evaluation.report.perCase)(
    "$id has its exact expected deterministic output",
    (result) => {
      expect(result.actual).toEqual(result.expected);
      expect(result.schemaValid).toBe(true);
      expect(result.eligibleContextProjectionValid).toBe(
        eligibleContextProjectionCaseIds.includes(result.id) ? true : null,
      );
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

  it("records bounded provenance without claiming an embedded candidate SHA or external privacy", () => {
    expect(evaluation.report.provenance).toEqual({
      evaluatorSource:
        "apps/web/src/app/projects/[projectId]/maria/_tests/maria-deterministic-corpus.ts",
      repository: "Gabrieldco1994/reformaflow",
      acceptedImplementationBase: "555963f1cc50078996054a105f5923b92a234003",
      candidateIdentityPolicy: "EXTERNAL_GIT_COMMIT_AND_CHECK_RUN",
      selfHashPolicy: "EXTERNAL_SHA256_PIN_NOT_EMBEDDED_TO_AVOID_CIRCULARITY",
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
      eligibleContextProjectionRate: 1,
      schemaValidityRate: 1,
      privacySafeRate: 1,
      exactCaseRate: 1,
    });
    expect(evaluation.report.scores).toEqual({
      moneyExactRate: 1,
      eligibleContextProjectionRate: 1,
      schemaValidityRate: 1,
      privacySafeRate: 1,
      exactCaseRate: 1,
    });
  });
});
