import { describe, expect, it } from "vitest";
import candidateReport from "./fixtures/maria-deterministic-candidate-report.v1.json";
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

describe("versioned deterministic Maria import corpus", () => {
  it("preserves all 22 retained synthetic case ids and validates reused report metadata without SHA claims", () => {
    const retainedIds = evaluation.corpus.semanticCases
      .slice(0, evaluation.corpus.retainedEvidence.caseCount)
      .map((testCase) => testCase.id);
    expect(retainedIds).toEqual(
      evaluation.retained.results.map((result) => result.id),
    );
    expect(evaluation.retained).toMatchObject({
      source: "REUSED",
      exactShaProvenance: "NOT_ASSERTED",
      reportSchema: evaluation.corpus.retainedEvidence.reportSchema,
      setHash: evaluation.corpus.retainedEvidence.setHash,
      caseCount: 22,
    });
    expect(
      evaluation.retained.results
        .filter((result) => result.passed)
        .map((result) => result.id),
    ).toEqual([
      "installments-eleven",
      "date-impossible",
      "confirmation-is-not-decision",
      "authorization-foreign-tenant-project",
      "privacy-hidden-project-canary",
      "privacy-hidden-card-canary",
    ]);
    expect(
      evaluation.retained.results.every(
        (result) =>
          result.toolExecutions === 0 && result.financialExecutions === 0,
      ),
    ).toBe(true);
  });

  it("publishes the exact fresh candidate result as a machine-readable artifact", () => {
    expect(candidateReport).toEqual(evaluation.report);
  });

  it("keeps all 13 unsafe or unsupported literals on the clarification path", () => {
    expect(
      evaluation.corpus.semanticCases
        .filter(({ id }) => correctedClarifyIds.includes(id))
        .map(({ id, expected }) => ({ id, expected })),
    ).toEqual(
      correctedClarifyIds.map((id) => ({
        id,
        expected: { outcome: "CLARIFY" },
      })),
    );
  });

  it("derives privacy safety from actual serialized output, not report metadata", () => {
    const privacyProbeId = "hidden-output-canary";
    const result = evaluateDeterministicCase({
      id: "privacy-oracle-self-test",
      field: "merchant",
      literal: privacyProbeId,
      expected: { outcome: "VALUE", resolvedValue: privacyProbeId },
      gates: ["privacy", "schema"],
      tags: ["privacy-oracle"],
      channel: "TEXT",
      privacyProbeId,
    });

    expect(result.actual).toEqual({
      outcome: "VALUE",
      resolvedValue: privacyProbeId,
    });
    expect(result.privacySafe).toBe(false);
  });

  it.each(evaluation.report.perCase)(
    "$id has its exact expected deterministic output and no side effects",
    (result) => {
      expect(result.actual).toEqual(result.expected);
      expect(result.schemaValid).toBe(true);
      expect(result.authorizationValid).toBe(true);
      expect(result.privacySafe).toBe(true);
      expect(result.counters).toEqual({
        autoSubmits: 0,
        financeBeforeExplicitConfirmation: 0,
        providerRequests: 0,
        toolExecutions: 0,
        financialExecutions: 0,
      });
    },
  );

  it("meets all locked deterministic quality gates with no model or tool dependency", () => {
    expect(evaluation.report.scores.moneyExactRate).toBe(1);
    expect(evaluation.report.scores.authorizationRate).toBe(1);
    expect(evaluation.report.scores.schemaValidityRate).toBe(1);
    expect(evaluation.report.scores.privacySafeRate).toBe(1);
    expect(evaluation.report.scores.exactCaseRate).toBe(1);
    expect(evaluation.report.counters).toEqual({
      autoSubmits: 0,
      financeBeforeExplicitConfirmation: 0,
      providerRequests: 0,
      toolExecutions: 0,
      financialExecutions: 0,
    });
  });
});
