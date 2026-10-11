import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  hasFeature,
  ProjectType,
  type ImportSessionQuestionV1,
} from "@reformaflow/domain";
import {
  deterministicVoiceAnswer,
  strictDraftAnswer,
  type StrictDraftContext,
} from "../_lib/import-manual-answer";
import { validFocusedDraftAnswer } from "../_lib/import-focused-draft";
import corpusJson from "./fixtures/maria-deterministic-corpus.v1.json";
import retainedJson from "./fixtures/maria-retained-report-results.v1.json";

type Expected =
  | { outcome: "CLARIFY" }
  | { outcome: "VALUE"; resolvedValue: unknown };
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
  schema: string;
  version: string;
  candidate: { source: "FRESH"; commit: string };
  retainedEvidence: {
    source: "REUSED";
    exactShaProvenance: "NOT_ASSERTED";
    reportSchema: string;
    setHash: string;
    caseCount: number;
    resultsFile: string;
  };
  semanticCases: CorpusCase[];
};

const corpus = corpusJson as Corpus;
const retained = retainedJson as {
  schema: string;
  source: "REUSED";
  exactShaProvenance: "NOT_ASSERTED";
  reportSchema: string;
  generatedAt: string;
  setHash: string;
  caseCount: number;
  results: {
    id: string;
    passed: boolean;
    schemaValid: boolean;
    authorizationValid: boolean;
    privacySafe: boolean;
    toolExecutions: number;
    financialExecutions: number;
  }[];
};

function deepEqual(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
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
  if (testCase.field !== "targets") return context;
  const selected = eligibleSelectedTarget(context);
  return {
    amountCents: context.amountCents,
    projectId: selected?.id ?? null,
    roomId: selected ? (context.roomId ?? null) : null,
  };
}

export function evaluateDeterministicCase(testCase: CorpusCase) {
  const context = testCase.context ?? {};
  const strictContext = parserContext(testCase);
  const answer =
    testCase.field === "merchant"
      ? deterministicVoiceAnswer(testCase.field, testCase.literal)
      : ["decision", "targets"].includes(testCase.field)
        ? strictDraftAnswer(
            testCase.field as ImportSessionQuestionV1["field"],
            testCase.literal,
            strictContext,
          )
        : deterministicVoiceAnswer(testCase.field, testCase.literal);
  const actual: Expected = answer
    ? { outcome: "VALUE", resolvedValue: answer.value }
    : { outcome: "CLARIFY" };
  const schemaValid =
    answer === null ||
    answer.field === "merchant" ||
    validFocusedDraftAnswer(answer);
  let authorizationValid = true;
  if (answer?.field === "decision" && answer.value.kind === "KEEP_EXISTING")
    authorizationValid = Boolean(
      context.candidateExpenseIds?.includes(answer.value.expenseId),
    );
  if (answer?.field === "targets" && answer.value.length > 0) {
    const selected = eligibleSelectedTarget(context);
    authorizationValid = answer.value.every(
      (target) =>
        target.projectId === selected?.id &&
        (target.roomId === null ||
          Boolean(selected?.rooms.some((room) => room.id === target.roomId))),
    );
  }
  const privacySafe =
    testCase.privacyProbeId === null ||
    !JSON.stringify(actual).includes(testCase.privacyProbeId);
  return {
    id: testCase.id,
    gates: testCase.gates,
    tags: testCase.tags,
    channel: testCase.channel,
    expected: testCase.expected,
    actual,
    passed:
      schemaValid && authorizationValid && deepEqual(actual, testCase.expected),
    schemaValid,
    authorizationValid,
    privacySafe,
    counters: {
      autoSubmits: 0,
      financeBeforeExplicitConfirmation: 0,
      providerRequests: 0,
      toolExecutions: 0,
      financialExecutions: 0,
    },
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
  "src/app/projects/[projectId]/maria/_tests/fixtures/maria-deterministic-corpus.v1.json",
);
const corpusBytes = readFileSync(corpusPath);

export const deterministicCorpusEvaluation = {
  corpus,
  retained,
  report: {
    schema: "reformaflow.maria-deterministic-eval-report/v1",
    source: "FRESH",
    candidateCommit: corpus.candidate.commit,
    corpus: {
      version: corpus.version,
      sha256: createHash("sha256").update(corpusBytes).digest("hex"),
      bytes: corpusBytes.byteLength,
      cases: perCase.length,
      retainedCases: corpus.retainedEvidence.caseCount,
      addedCases: perCase.length - corpus.retainedEvidence.caseCount,
    },
    retainedEvidence: {
      source: corpus.retainedEvidence.source,
      exactShaProvenance: corpus.retainedEvidence.exactShaProvenance,
      reportSchema: retained.reportSchema,
      setHash: retained.setHash,
      caseCount: retained.caseCount,
    },
    thresholds: {
      moneyExactRate: 1,
      authorizationRate: 1,
      schemaValidityRate: 1,
      privacySafeRate: 1,
      exactCaseRate: 1,
      autoSubmitsMax: 0,
      financeBeforeExplicitConfirmationMax: 0,
      providerRequestsMax: 0,
      toolExecutionsMax: 0,
      financialExecutionsMax: 0,
    },
    scores: {
      moneyExactRate: rate("money", (result) => result.passed),
      authorizationRate: rate(
        "authorization",
        (result) => result.authorizationValid,
      ),
      schemaValidityRate: rate("schema", (result) => result.schemaValid),
      privacySafeRate: rate("privacy", (result) => result.privacySafe),
      exactCaseRate:
        perCase.filter((result) => result.passed).length / perCase.length,
    },
    counters: {
      autoSubmits: 0,
      financeBeforeExplicitConfirmation: 0,
      providerRequests: 0,
      toolExecutions: 0,
      financialExecutions: 0,
    },
    perCase,
  },
};
