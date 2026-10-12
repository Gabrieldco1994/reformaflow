import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  hasFeature,
  ProjectType,
  type ImportSessionCandidateV1,
  type ImportSessionQuestionV1,
} from "@reformaflow/domain";
import {
  deterministicVoiceAnswer,
  strictDraftAnswer,
  type StrictDraftContext,
} from "../_lib/import-manual-answer";
import { validFocusedDraftAnswer } from "../_lib/import-focused-draft";
import corpusJson from "./fixtures/maria-deterministic-corpus.v2.json";
import historicalRetainedJson from "./fixtures/maria-retained-report-results.v1.json";

type Expected =
  | { outcome: "CLARIFY" }
  | { outcome: "VALUE"; resolvedValue: unknown };
type EvaluatorDecisionCandidate = Pick<
  ImportSessionCandidateV1,
  "id" | "lineId" | "kind" | "reason" | "canKeepExisting"
>;
type HiddenUnauthorizedContext = {
  projectIds?: string[];
  cardIds?: string[];
  expenseIds?: string[];
};
type CaseContext = StrictDraftContext & {
  ownerProjectId?: string | null;
  targetProjects?: {
    id: string;
    projectType: string;
    active: boolean;
    deletedAt: string | null;
    eligible: boolean;
    rooms: { id: string }[];
  }[];
  decisionLineIds?: string[];
  decisionCandidates?: EvaluatorDecisionCandidate[];
  hiddenUnauthorized?: HiddenUnauthorizedContext;
};
export type CorpusCase = {
  id: string;
  field: ImportSessionQuestionV1["field"] | "merchant";
  literal: string;
  context?: CaseContext;
  expected: Expected;
  gates: string[];
  tags: string[];
  channel: "TEXT" | "VOICE";
  privacyProbeId: string | null;
};
type Corpus = {
  schema: "reformaflow.maria-deterministic-corpus/v2";
  version: "maria-deterministic-import-v2";
  historicalRetainedArtifact: {
    role: "HISTORICAL_ONLY_NOT_BASELINE_OR_CANDIDATE";
    exactShaProvenance: "NOT_ASSERTED";
    reportSchema: string;
    setHash: string;
    caseCount: number;
    resultsFile: string;
  };
  privacyDesign: {
    scope: "PURE_EVALUATOR_RESULT_AND_CONTEXT_PROJECTION_ONLY";
  };
  semanticCases: CorpusCase[];
};
type DecisionAnswer = Extract<
  NonNullable<ReturnType<typeof strictDraftAnswer>>,
  { field: "decision" }
>["value"];
type DecisionChoice = { value: string; answer: DecisionAnswer };

const corpus = corpusJson as Corpus;
const historicalRetained = historicalRetainedJson as {
  schema: string;
  source: "REUSED";
  exactShaProvenance: "NOT_ASSERTED";
  reportSchema: string;
  generatedAt: string;
  setHash: string;
  caseCount: number;
  results: { id: string }[];
};

const expectationChangeIds = [
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
] as const;

function deepEqual(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function supportedEvaluatorDecisionChoices(
  context: CaseContext,
): DecisionChoice[] {
  const lineIds = context.decisionLineIds ?? [];
  const visible = (context.decisionCandidates ?? []).filter((candidate) =>
    lineIds.includes(candidate.lineId),
  );
  const strong = visible.filter(
    (candidate) => candidate.reason === "STRONG_IDENTITY",
  );
  if (strong.length > 0) {
    if (
      strong.some(
        (candidate) =>
          candidate.kind !== "EXPENSE" || !candidate.canKeepExisting,
      )
    )
      return [];
    return strong.map((candidate) => ({
      value: candidate.id,
      answer: { kind: "KEEP_EXISTING", expenseId: candidate.id },
    }));
  }

  const choices: DecisionChoice[] = [];
  if (visible.some((candidate) => candidate.reason === "NATURAL_MATCH"))
    choices.push({
      value: "CREATE_ACCEPT_NATURAL_DUPLICATE",
      answer: { kind: "CREATE", acceptNaturalDuplicate: true },
    });
  choices.push(
    ...visible
      .filter(
        (candidate) =>
          candidate.kind === "EXPENSE" && candidate.canKeepExisting,
      )
      .map((candidate) => ({
        value: candidate.id,
        answer: { kind: "KEEP_EXISTING" as const, expenseId: candidate.id },
      })),
  );
  return choices;
}

function eligibleSelectedTarget(context: CaseContext) {
  const project = context.targetProjects?.find(
    (candidate) =>
      candidate.id === context.projectId &&
      candidate.id !== context.ownerProjectId &&
      candidate.active &&
      candidate.deletedAt === null &&
      candidate.eligible &&
      candidate.projectType === ProjectType.REFORMA &&
      hasFeature(ProjectType.REFORMA, "expenses"),
  );
  if (!project) return null;
  if (
    context.roomId !== null &&
    context.roomId !== undefined &&
    !project.rooms.some((room) => room.id === context.roomId)
  )
    return null;
  return project;
}

function parserContext(testCase: CorpusCase): StrictDraftContext {
  const context = testCase.context ?? {};
  if (testCase.field === "decision") {
    const choices = supportedEvaluatorDecisionChoices(context);
    return {
      candidateExpenseIds: choices.flatMap((choice) =>
        choice.answer.kind === "KEEP_EXISTING" ? [choice.answer.expenseId] : [],
      ),
    };
  }
  if (testCase.field === "targets") {
    const selected = eligibleSelectedTarget(context);
    return {
      amountCents: context.amountCents,
      projectId: selected?.id ?? null,
      roomId: selected ? (context.roomId ?? null) : null,
    };
  }
  return {};
}

function answerForCase(
  testCase: CorpusCase,
  contextProjection: StrictDraftContext,
) {
  if (testCase.channel === "VOICE")
    return deterministicVoiceAnswer(testCase.field, testCase.literal);
  if (testCase.field === "merchant") return null;
  if (testCase.field === "decision") {
    const exposed = supportedEvaluatorDecisionChoices(
      testCase.context ?? {},
    ).some((choice) => choice.value === testCase.literal);
    return exposed
      ? strictDraftAnswer("decision", testCase.literal, contextProjection)
      : null;
  }
  return strictDraftAnswer(testCase.field, testCase.literal, contextProjection);
}

function eligibleContextProjectionValidity(
  testCase: CorpusCase,
  answer: ReturnType<typeof answerForCase>,
) {
  if (
    !eligibleContextProjectionCaseIds.includes(
      testCase.id as (typeof eligibleContextProjectionCaseIds)[number],
    )
  )
    return null;

  const context = testCase.context ?? {};
  if (testCase.field === "decision") {
    const projected = supportedEvaluatorDecisionChoices(context).find(
      (choice) => choice.value === testCase.literal,
    );
    return projected
      ? answer?.field === "decision" &&
          deepEqual(projected.answer, answer.value)
      : answer === null;
  }
  if (testCase.field !== "targets") return false;

  const selected = eligibleSelectedTarget(context);
  const amountCents = context.amountCents;
  if (
    testCase.literal !== "target" ||
    !selected ||
    !Number.isSafeInteger(amountCents) ||
    amountCents === null ||
    amountCents === undefined ||
    amountCents <= 0
  )
    return answer === null;
  return (
    answer?.field === "targets" &&
    deepEqual(answer.value, [
      {
        projectId: selected.id,
        roomId: context.roomId ?? null,
        amountCents,
      },
    ])
  );
}

function hiddenCanaries(testCase: CorpusCase) {
  const hidden = testCase.context?.hiddenUnauthorized;
  return [
    testCase.privacyProbeId,
    ...(hidden?.projectIds ?? []),
    ...(hidden?.cardIds ?? []),
    ...(hidden?.expenseIds ?? []),
  ].filter((value): value is string => value !== null);
}

export function evaluateDeterministicCase(testCase: CorpusCase) {
  const context = testCase.context ?? {};
  const contextProjection = parserContext(testCase);
  const answer = answerForCase(testCase, contextProjection);
  const actual: Expected = answer
    ? { outcome: "VALUE", resolvedValue: answer.value }
    : { outcome: "CLARIFY" };
  const error = answer === null ? { code: "CLARIFY" as const } : null;
  const schemaValid =
    answer === null ||
    answer.field === "merchant" ||
    validFocusedDraftAnswer(answer);
  const eligibleContextProjectionValid = eligibleContextProjectionValidity(
    testCase,
    answer,
  );
  const observable = {
    actual,
    error,
    schemaValid,
    eligibleContextProjectionValid,
  };
  const privacySurface = JSON.stringify({ observable, contextProjection });
  const privacySafe = hiddenCanaries(testCase).every(
    (canary) => !privacySurface.includes(canary),
  );
  return {
    id: testCase.id,
    gates: testCase.gates,
    tags: testCase.tags,
    channel: testCase.channel,
    expected: testCase.expected,
    actual,
    error,
    contextProjection,
    passed:
      schemaValid &&
      eligibleContextProjectionValid !== false &&
      privacySafe &&
      deepEqual(actual, testCase.expected),
    schemaValid,
    eligibleContextProjectionValid,
    privacySafe,
  };
}

const perCase = corpus.semanticCases.map(evaluateDeterministicCase);
const rate = (
  gate: string,
  predicate: (result: (typeof perCase)[number]) => boolean,
) => {
  const selected = perCase.filter((result) => result.gates.includes(gate));
  return selected.filter(predicate).length / selected.length;
};
const corpusPath = resolve(
  process.cwd(),
  "src/app/projects/[projectId]/maria/_tests/fixtures/maria-deterministic-corpus.v2.json",
);
const corpusBytes = readFileSync(corpusPath);

export const deterministicCorpusEvaluation = {
  corpus,
  historicalRetained,
  positiveControlIds,
  expectationChangeIds,
  report: {
    schema: "reformaflow.maria-deterministic-eval-report/v2",
    source: "FRESH_PURE_EVALUATOR",
    provenance: {
      evaluatorSource:
        "apps/web/src/app/projects/[projectId]/maria/_tests/maria-deterministic-corpus.ts",
      repository: "Gabrieldco1994/reformaflow",
      acceptedImplementationBase: "555963f1cc50078996054a105f5923b92a234003",
      candidateIdentityPolicy: "EXTERNAL_GIT_COMMIT_AND_CHECK_RUN",
      selfHashPolicy: "EXTERNAL_SHA256_PIN_NOT_EMBEDDED_TO_AVOID_CIRCULARITY",
    },
    dataset: {
      file: "maria-deterministic-corpus.v2.json",
      version: corpus.version,
      sha256: createHash("sha256").update(corpusBytes).digest("hex"),
      bytes: corpusBytes.byteLength,
      cases: perCase.length,
      retainedCases: corpus.historicalRetainedArtifact.caseCount,
      addedCases: perCase.length - corpus.historicalRetainedArtifact.caseCount,
    },
    execution: {
      command:
        "TZ=UTC npx vitest run 'src/app/projects/[projectId]/maria/_tests/maria-deterministic-corpus.test.ts'",
      runtime: {
        node: "v24.13.0",
        vitest: "2.1.9",
        npm: "11.6.2",
      },
      timezone: "UTC",
      provider: "N/A",
      model: "N/A",
    },
    generation: {
      generatedAt: "NOT_APPLICABLE_DETERMINISTIC_STATIC_ARTIFACT",
      policy: "DETERMINISTIC_STATIC_NO_WALL_CLOCK",
    },
    privacy: {
      metricScope: corpus.privacyDesign.scope,
      excludedClaims: [
        "REQUEST",
        "LOG",
        "PROVIDER",
        "MODEL",
        "TOOL",
        "API",
        "UI",
      ],
      noninterferencePairs: [
        ["privacy-project-visible-baseline", "privacy-hidden-project-canary"],
        ["privacy-card-visible-baseline", "privacy-hidden-card-canary"],
        ["privacy-expense-visible-baseline", "privacy-hidden-expense-canary"],
      ],
    },
    eligibleContextProjection: {
      scope: "PURE_SYNTHETIC_ELIGIBLE_CONTEXT_PROJECTION_ONLY",
      denominatorCaseIds: eligibleContextProjectionCaseIds,
      excludedClaims: [
        "AUTHORIZATION",
        "API",
        "TENANT_ISOLATION",
        "GUARDS",
        "SERVER_REVALIDATION",
      ],
    },
    sideEffectCounters: {
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
    },
    historicalRetainedArtifact: {
      role: corpus.historicalRetainedArtifact.role,
      file: corpus.historicalRetainedArtifact.resultsFile,
      exactShaProvenance: corpus.historicalRetainedArtifact.exactShaProvenance,
      reportSchema: historicalRetained.reportSchema,
      setHash: historicalRetained.setHash,
      caseCount: historicalRetained.caseCount,
    },
    regressionAndExpectationChanges: {
      expectationChangeIds,
      positiveControlIds,
      policy:
        "Unsafe prose and injection remain CLARIFY; paired exact controls must remain VALUE.",
    },
    evidenceReferences: [
      {
        kind: "HISTORICAL_ONLY",
        path: "apps/web/src/app/projects/[projectId]/maria/_tests/fixtures/maria-retained-report-results.v1.json",
      },
      {
        kind: "ACCEPTED_FRONTEND_FOCUSED_SUITES",
        commit: "555963f1cc50078996054a105f5923b92a234003",
      },
      {
        kind: "EXPECTED_RED_SPEECH",
        path: "apps/web/src/components/agent/useSpeechRecognition.test.ts",
      },
      {
        kind: "EXPECTED_RED_MOBILE",
        path: "apps/web/e2e/import-focused-draft-controls.spec.ts",
      },
    ],
    thresholds: {
      moneyExactRate: 1,
      eligibleContextProjectionRate: 1,
      schemaValidityRate: 1,
      privacySafeRate: 1,
      exactCaseRate: 1,
    },
    scores: {
      moneyExactRate: rate("money", (result) => result.passed),
      eligibleContextProjectionRate:
        perCase.filter(
          (result) =>
            result.eligibleContextProjectionValid !== null &&
            result.eligibleContextProjectionValid,
        ).length / eligibleContextProjectionCaseIds.length,
      schemaValidityRate: rate("schema", (result) => result.schemaValid),
      privacySafeRate: rate("privacy", (result) => result.privacySafe),
      exactCaseRate:
        perCase.filter((result) => result.passed).length / perCase.length,
    },
    perCase,
  },
};
