import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ImportSessionAmountMeaning,
  ImportSessionState,
  type ImportChatTurnV1,
  type ImportSessionDraftFieldV1,
  type ImportSessionDraftLineV1,
} from "@reformaflow/domain";
import {
  importAnswerMessages,
  importAnswerToolDefinitions,
} from "./import-chat.prompt";
import { OpenAiCompatibleProvider } from "./llm/openai-compatible.provider";
import { validateSyntheticCallBatch } from "./import-model.eval-validation";
import { resolveImportAnswer } from "../imports/import-session/import-chat-answer";
import { LlmResponseContractError, type ChatMessage } from "./llm/llm.types";

const contract =
  require("../../../../scripts/qa/maria-import-eval-contract.cjs") as {
    defaultPaths(root: string): {
      lock: string;
      fixture: string;
      thresholds: string;
      oracle: string;
    };
    loadEvalInputs(paths: {
      lock: string;
      fixture: string;
      thresholds: string;
      oracle: string;
    }): EvalInputs;
    computeSetHash(inputs: EvalInputs): string;
    validateReport(report: unknown, inputs: EvalInputs): void;
  };
type EvalCase = {
  id: string;
  field: ImportSessionDraftFieldV1;
  literal: string;
  expected: { outcome: "VALUE" | "CLARIFY"; resolvedValue?: unknown };
  gates: string[];
  tags: string[];
  channel: "TEXT" | "VOICE";
  privacyProbeId: string | null;
};
type EvalInputs = {
  lock: { name: string; digest: string; ollamaVersion: string };
  fixture: {
    version: string;
    baseline: { sha: string; status: "NO_SURFACE"; overall: null; delta: null };
    candidateSurfaceSha: string;
    privacyDesign: {
      policy: string;
      securityReviewStatus: string;
      requiredAbsence: string[];
      oracleVersion: string;
      canaryIds: string[];
    };
    semanticCases: EvalCase[];
    failureCases: { id: string; mode: string; expectedError: string }[];
  };
  oracle: {
    version: string;
    canaries: { id: string; kind: string; value: string }[];
  };
  thresholds: {
    thresholds: Record<string, number>;
    estimatedUsd: null;
    latencyGate: null;
    costGate: null;
  };
};
type Usage = {
  prompt: number | null;
  completion: number | null;
  total: number | null;
};
type PayloadDigest = { byteLength: number; sha256: string };
type MatchCounters = {
  userLiteral: number;
  messages: number;
  authorizedContext: number;
  toolDefinitions: number;
  providerBody: number;
  modelContent: number;
  toolArguments: number;
  logs: number;
  report: number;
};
type PrivacyProof = {
  canaries: { id: string; sha256: string }[];
  requestCount: number;
  responseCount: number;
  requests: PayloadDigest[];
  responses: PayloadDigest[];
  matchCounters: MatchCounters;
  rawPayloadsRetained: false;
};
type ExecutionCounters = {
  toolExecutions: number;
  financialExecutions: number;
  prepareInTxExecutions: number;
  applyInTxExecutions: number;
  blockedPrepareInTxAttempts: number;
  blockedApplyInTxAttempts: number;
};
type CaseResult = {
  id: string;
  channel: "TEXT" | "VOICE";
  privacyProbeId: string | null;
  tags: string[];
  gates: string[];
  passed: boolean;
  schemaValid: boolean;
  authorizationValid: boolean;
  privacySafe: boolean;
  authorizationEvidence: {
    preExecutionValidation: true;
    rejectedBeforeExecution: boolean;
  };
  privacyProof: PrivacyProof;
  semanticChecks: {
    outcomeMatches: boolean;
    valueMatches: boolean;
    nonFocusedFieldsPreserved: boolean;
  };
  errorCode: string | null;
  latencyMs: number;
  tokens: Usage;
  toolSequence: {
    iteration: number;
    name: string;
    phase: string;
  }[];
  executionCounters: ExecutionCounters;
};
const root = resolve(__dirname, "../../../..");
const inputs = contract.loadEvalInputs(contract.defaultPaths(root));
const outputPath = resolve(
  process.env["MARIA_EVAL_REPORT_PATH"] ||
    resolve(root, "artifacts/maria-import-eval-report.json"),
);
const emptyUsage = (): Usage => ({
  prompt: null,
  completion: null,
  total: null,
});
const hiddenCanaries = inputs.oracle.canaries;
const serialize = (value: unknown): string =>
  (typeof value === "string" ? value : JSON.stringify(value)) ?? "";
const digestPayload = (value: string): PayloadDigest => ({
  byteLength: Buffer.byteLength(value, "utf8"),
  sha256: createHash("sha256").update(value, "utf8").digest("hex"),
});
const canaryFingerprints = hiddenCanaries.map((canary) => ({
  id: canary.id,
  sha256: createHash("sha256").update(canary.value, "utf8").digest("hex"),
}));
const newPrivacyProof = (): PrivacyProof => ({
  canaries: canaryFingerprints,
  requestCount: 0,
  responseCount: 0,
  requests: [],
  responses: [],
  matchCounters: {
    userLiteral: 0,
    messages: 0,
    authorizedContext: 0,
    toolDefinitions: 0,
    providerBody: 0,
    modelContent: 0,
    toolArguments: 0,
    logs: 0,
    report: 0,
  },
  rawPayloadsRetained: false,
});
function scanCanary(
  proof: PrivacyProof,
  surface: keyof MatchCounters,
  value: unknown,
): void {
  const payload = serialize(value);
  const matches = hiddenCanaries.filter((canary) =>
    payload.includes(canary.value),
  ).length;
  proof.matchCounters[surface] += matches;
  if (matches > 0) throw new Error("PRIVACY_CANARY_MATCH");
}
function privacyProofSafe(proof: PrivacyProof): boolean {
  return (
    proof.requestCount >= 1 &&
    proof.responseCount >= 1 &&
    Object.values(proof.matchCounters).every((count) => count === 0)
  );
}
function safeErrorCode(error: unknown): string {
  if (error instanceof LlmResponseContractError)
    return "LLM_RESPONSE_CONTRACT_ERROR";
  if (!(error instanceof Error)) return "UNKNOWN_ERROR";
  const known = [
    "PRIVACY_CANARY_MATCH",
    "RESPONSE_MODEL_MISMATCH",
    "MODEL_TURN_BUDGET_EXHAUSTED",
  ];
  return known.includes(error.message) ? error.message : error.name;
}
class ExecutionBoundaryCounters {
  private readonly values: ExecutionCounters = {
    toolExecutions: 0,
    financialExecutions: 0,
    prepareInTxExecutions: 0,
    applyInTxExecutions: 0,
    blockedPrepareInTxAttempts: 0,
    blockedApplyInTxAttempts: 0,
  };
  rejectPrepareInTx(): never {
    this.values.blockedPrepareInTxAttempts += 1;
    throw new Error("PERSISTENCE_BOUNDARY_FORBIDDEN");
  }
  rejectApplyInTx(): never {
    this.values.blockedApplyInTxAttempts += 1;
    throw new Error("PERSISTENCE_BOUNDARY_FORBIDDEN");
  }
  snapshot(): ExecutionCounters {
    return { ...this.values };
  }
}
const safeLog = (value: Record<string, unknown>): void => {
  const proof = newPrivacyProof();
  scanCanary(proof, "logs", value);
  console.log(JSON.stringify(value));
};
function baseLine(): ImportSessionDraftLineV1 {
  return {
    id: "line-current-1",
    observationIds: ["observation-current-1"],
    titulo: "Compra sintética isolada",
    fornecedor: null,
    tipoDespesa: null,
    categoriaMaoDeObra: null,
    amountMeaning: ImportSessionAmountMeaning.UNKNOWN,
    amountCents: 12345,
    installmentCount: null,
    dataCompra: "2026-10-02",
    firstDueDate: null,
    targets: null,
    decision: { kind: "UNRESOLVED" },
  };
}
function sessionFor(testCase: EvalCase) {
  const line = baseLine();
  return {
    version: 1 as const,
    kind: "SESSION" as const,
    state: ImportSessionState.NEEDS_INPUT,
    revision: 9,
    focus: {
      id: "question-current-1",
      field: testCase.field,
      lineIds: [line.id],
      text: "Responda apenas ao campo solicitado.",
    },
    lines: [
      {
        id: line.id,
        titulo: line.titulo,
        amountMeaning: line.amountMeaning,
        amountCents: line.amountCents,
        installmentCount: line.installmentCount,
        dataCompra: line.dataCompra,
        firstDueDate: line.firstDueDate,
        targets: line.targets,
        decision: line.decision,
        tipoDespesa: line.tipoDespesa,
        categoriaMaoDeObra: line.categoriaMaoDeObra,
      },
    ],
  };
}
function toolContent(
  name: string,
  session: ReturnType<typeof sessionFor>,
): unknown {
  switch (name) {
    case "import_read_session":
      return session;
    case "import_read_observations":
      return {
        version: 1,
        kind: "OBSERVATIONS",
        pageIndex: 0,
        items: [],
        hasMore: false,
      };
    case "list_payment_methods":
      return {
        version: 1,
        kind: "PAYMENT_METHODS",
        card: {
          id: "card-current-1",
          nickname: "Cartão da sessão",
          institution: null,
          last4: "2048",
        },
      };
    case "list_projects":
      return {
        version: 1,
        kind: "PROJECTS",
        pageIndex: 0,
        items: [
          {
            id: "project-current-1",
            name: "Projeto Aurora",
            type: "RESIDENTIAL",
          },
        ],
        hasMore: false,
      };
    case "import_read_candidates":
      return {
        version: 1,
        kind: "CANDIDATES",
        pageIndex: 0,
        items: [],
        hasMore: false,
        searchComplete: true,
      };
    case "get_category_taxonomy":
      return {
        version: 1,
        kind: "TAXONOMY",
        expenseTypes: [],
        laborCategories: [],
      };
    default:
      throw new Error("UNREPRESENTED_READ_TOOL");
  }
}
function resolvedField(
  line: ImportSessionDraftLineV1,
  field: ImportSessionDraftFieldV1,
): unknown {
  return line[field];
}
function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function evaluateCase(
  testCase: EvalCase,
  provider: OpenAiCompatibleProvider,
): Promise<CaseResult> {
  const started = performance.now();
  const session = sessionFor(testCase);
  const turn: ImportChatTurnV1 = {
    version: 1,
    turnId: "turn-" + testCase.id,
    sessionId: "session-current-1",
    expectedRevision: 9,
    channel: testCase.channel,
    intent: "ANSWER",
    literalAnswer: testCase.literal,
    focus: {
      id: session.focus.id,
      field: testCase.field,
      lineIds: ["line-current-1"],
    },
    scope: { kind: "LINES", lineIds: ["line-current-1"] },
  };
  const definitions = importAnswerToolDefinitions(turn);
  const messages: ChatMessage[] = importAnswerMessages(
    testCase.literal,
    session,
  );
  const original = [baseLine()];
  const before = structuredClone(original);
  const toolSequence: CaseResult["toolSequence"] = [];
  const executionBoundary = new ExecutionBoundaryCounters();
  const privacyProof = newPrivacyProof();
  let usage = emptyUsage();
  let schemaValid = true;
  const authorizationValid = true;
  const authorizationEvidence: CaseResult["authorizationEvidence"] = {
    preExecutionValidation: true,
    rejectedBeforeExecution: false,
  };
  let passed = false;
  const semanticChecks = {
    outcomeMatches: false,
    valueMatches: false,
    nonFocusedFieldsPreserved: false,
  };
  let errorCode: string | null = null;
  scanCanary(privacyProof, "userLiteral", testCase.literal);
  scanCanary(privacyProof, "messages", messages);
  scanCanary(privacyProof, "toolDefinitions", definitions);
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (typeof init?.body !== "string")
      throw new Error("SERIALIZED_PROVIDER_BODY_REQUIRED");
    scanCanary(privacyProof, "providerBody", init.body);
    privacyProof.requestCount += 1;
    privacyProof.requests.push(digestPayload(init.body));
    const response = await nativeFetch(url, init);
    const responseText = await response.clone().text();
    privacyProof.responseCount += 1;
    privacyProof.responses.push(digestPayload(responseText));
    scanCanary(privacyProof, "modelContent", responseText);
    try {
      const payload = JSON.parse(responseText) as {
        model?: string;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
      };
      if (payload.model && payload.model !== inputs.lock.name)
        throw new Error("RESPONSE_MODEL_MISMATCH");
      if (payload.usage)
        usage = {
          prompt: (usage.prompt ?? 0) + (payload.usage.prompt_tokens ?? 0),
          completion:
            (usage.completion ?? 0) + (payload.usage.completion_tokens ?? 0),
          total: (usage.total ?? 0) + (payload.usage.total_tokens ?? 0),
        };
    } catch (captureError) {
      if (
        captureError instanceof Error &&
        captureError.message === "RESPONSE_MODEL_MISMATCH"
      )
        throw captureError;
    }
    return response;
  };
  try {
    for (let iteration = 0; iteration < 4; iteration++) {
      const response = await provider.chat(messages, definitions, {
        responseContract: "IMPORT_CHAT_V1",
      });
      scanCanary(privacyProof, "modelContent", response.content);
      for (const call of response.toolCalls)
        scanCanary(privacyProof, "toolArguments", call.arguments);
      let batch: ReturnType<typeof validateSyntheticCallBatch>;
      try {
        batch = validateSyntheticCallBatch(
          response.toolCalls,
          definitions,
          testCase.field,
        );
      } catch (batchError) {
        schemaValid = false;
        authorizationEvidence.rejectedBeforeExecution = true;
        const allowedNames = new Set(definitions.map((item) => item.name));
        for (const call of response.toolCalls)
          toolSequence.push({
            iteration,
            name: allowedNames.has(call.name) ? call.name : "UNRECOGNIZED_TOOL",
            phase: "REJECTED_PRE_EXECUTION",
          });
        throw batchError;
      }
      messages.push({
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
      });
      for (const item of batch) {
        const phase =
          item.parsed.name === "import_edit_answer"
            ? "PROPOSED_WRITE_NOT_EXECUTED"
            : "SIMULATED_AUTHORIZED_READ";
        toolSequence.push({
          iteration,
          name: item.call.name,
          phase,
        });
        if (item.parsed.name === "import_edit_answer") {
          const resolved = resolveImportAnswer(
            testCase.literal,
            testCase.field,
            JSON.parse(JSON.stringify(item.parsed.arguments)),
            original,
            {
              projects: [
                { id: "project-current-1", name: "Projeto Aurora", rooms: [] },
              ],
              candidates: [],
            },
          );
          const outcomeMatches = resolved.kind === testCase.expected.outcome;
          const valueMatches =
            testCase.expected.outcome === "CLARIFY" ||
            (resolved.kind === "VALUE" &&
              equal(
                resolvedField(resolved.lines[0]!, testCase.field),
                testCase.expected.resolvedValue,
              ));
          let preservation = equal(original, before);
          if (resolved.kind === "VALUE") {
            const expectedLine = {
              ...before[0],
              [testCase.field]: testCase.expected.resolvedValue,
            };
            preservation = equal(resolved.lines, [expectedLine]);
          }
          semanticChecks.outcomeMatches = outcomeMatches;
          semanticChecks.valueMatches = valueMatches;
          semanticChecks.nonFocusedFieldsPreserved = preservation;
          const privacySafe = privacyProofSafe(privacyProof);
          passed =
            outcomeMatches &&
            valueMatches &&
            preservation &&
            schemaValid &&
            authorizationValid &&
            privacySafe;
          return {
            id: testCase.id,
            channel: testCase.channel,
            privacyProbeId: testCase.privacyProbeId,
            tags: testCase.tags,
            gates: testCase.gates,
            passed,
            schemaValid,
            authorizationValid,
            privacySafe,
            authorizationEvidence,
            privacyProof,
            semanticChecks,
            errorCode,
            latencyMs: Math.round(performance.now() - started),
            tokens: usage,
            toolSequence,
            executionCounters: executionBoundary.snapshot(),
          };
        }
        const authorizedContent = toolContent(item.call.name, session);
        scanCanary(privacyProof, "authorizedContext", authorizedContent);
        messages.push({
          role: "tool",
          toolCallId: item.call.id,
          name: item.call.name,
          content: JSON.stringify(authorizedContent),
        });
      }
    }
    errorCode = "MODEL_TURN_BUDGET_EXHAUSTED";
  } catch (caseError) {
    if (caseError instanceof LlmResponseContractError) {
      schemaValid = false;
      authorizationEvidence.rejectedBeforeExecution = true;
    }
    errorCode = safeErrorCode(caseError);
  } finally {
    globalThis.fetch = nativeFetch;
  }
  return {
    id: testCase.id,
    channel: testCase.channel,
    privacyProbeId: testCase.privacyProbeId,
    tags: testCase.tags,
    gates: testCase.gates,
    passed: false,
    schemaValid,
    authorizationValid,
    privacySafe: privacyProofSafe(privacyProof),
    authorizationEvidence,
    privacyProof,
    semanticChecks,
    errorCode,
    latencyMs: Math.round(performance.now() - started),
    tokens: usage,
    toolSequence,
    executionCounters: executionBoundary.snapshot(),
  };
}

function failureResults() {
  return inputs.fixture.failureCases.map((item) => {
    let visibleError = item.expectedError;
    const executionBoundary = new ExecutionBoundaryCounters();
    try {
      if (item.mode === "MALFORMED_ARGUMENTS")
        validateSyntheticCallBatch(
          [{ id: "bad", name: "import_edit_answer", arguments: {} }],
          importAnswerToolDefinitions({
            version: 1,
            turnId: "failure-turn",
            sessionId: "failure-session",
            expectedRevision: 1,
            channel: "TEXT",
            intent: "ANSWER",
            literalAnswer: "x",
            focus: { id: "q", field: "amountCents", lineIds: ["line"] },
            scope: { kind: "LINES", lineIds: ["line"] },
          }),
          "amountCents",
        );
      else if (item.mode === "TRUNCATED_BATCH")
        validateSyntheticCallBatch([], [], "amountCents");
      else if (item.mode === "TIMEOUT") throw new Error("MODEL_TIMEOUT");
      else if (item.mode === "PROVIDER_UNAVAILABLE")
        throw new Error("PROVIDER_UNAVAILABLE");
      else if (item.mode === "PREPARE_IN_TX")
        executionBoundary.rejectPrepareInTx();
      else if (item.mode === "APPLY_IN_TX") executionBoundary.rejectApplyInTx();
      visibleError = "NO_EXPLICIT_ERROR";
    } catch (probeError) {
      const text = probeError instanceof Error ? probeError.message : "UNKNOWN";
      visibleError = text.includes(item.expectedError)
        ? item.expectedError
        : "UNEXPECTED_PROBE_ERROR";
    }
    const executionCounters = executionBoundary.snapshot();
    return {
      id: item.id,
      passed:
        visibleError === item.expectedError &&
        executionCounters.toolExecutions === 0 &&
        executionCounters.financialExecutions === 0 &&
        executionCounters.prepareInTxExecutions === 0 &&
        executionCounters.applyInTxExecutions === 0,
      status: "ERROR",
      visibleError,
      executionCounters,
    };
  });
}
function rate(
  results: CaseResult[],
  gate: string,
  property:
    | "passed"
    | "schemaValid"
    | "authorizationValid"
    | "privacySafe" = "passed",
) {
  const selected = results.filter(
    (item) => gate === "all" || item.gates.includes(gate),
  );
  return selected.length === 0
    ? 0
    : selected.filter((item) => item[property]).length / selected.length;
}
async function main() {
  if (process.env["MARIA_IMPORT_MODEL_EVAL"] !== "1")
    throw new Error("OPT_IN_REQUIRED");
  for (const key of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
  ])
    if (process.env[key]) throw new Error("HOSTED_MODEL_CREDENTIAL_FORBIDDEN");
  if (
    process.env["AGENT_LLM_PROVIDER"] !== "ollama" ||
    process.env["AGENT_MODEL"] !== inputs.lock.name ||
    process.env["QA_OLLAMA_MODEL"] !== inputs.lock.name ||
    !/^http:\/\/(127\.0\.0\.1|localhost):[0-9]+\/v1$/.test(
      process.env["OLLAMA_BASE_URL"] || "",
    )
  )
    throw new Error("PINNED_LOOPBACK_PROVIDER_REQUIRED");
  const provider = new OpenAiCompatibleProvider("ollama", inputs.lock.name);
  const perCase: CaseResult[] = [];
  for (const testCase of inputs.fixture.semanticCases) {
    const result = await evaluateCase(testCase, provider);
    perCase.push(result);
    safeLog({
      case: result.id,
      passed: result.passed,
      latencyMs: result.latencyMs,
    });
  }
  const failures = failureResults();
  const overall = rate(perCase, "all");
  const latencies = perCase.map((item) => item.latencyMs).sort((a, b) => a - b);
  const tokenTotals = perCase.reduce(
    (total, item) => ({
      prompt: total.prompt + (item.tokens.prompt ?? 0),
      completion: total.completion + (item.tokens.completion ?? 0),
      total: total.total + (item.tokens.total ?? 0),
    }),
    { prompt: 0, completion: 0, total: 0 },
  );
  const summary = {
    outcome: "FAIL",
    semanticTotal: perCase.length,
    semanticPassed: perCase.filter((item) => item.passed).length,
    overall,
    moneyExactRate: rate(perCase, "money"),
    authorizationRate: rate(perCase, "authorization", "authorizationValid"),
    privacyRate: rate(perCase, "privacy", "privacySafe"),
    schemaValidityRate: rate(perCase, "all", "schemaValid"),
    unauthorizedFinanceExecutions: [...perCase, ...failures].reduce(
      (total, item) =>
        total +
        item.executionCounters.financialExecutions +
        item.executionCounters.prepareInTxExecutions +
        item.executionCounters.applyInTxExecutions,
      0,
    ),
    criticalRegressions: 0,
    latencyMs: {
      total: latencies.reduce((total, value) => total + value, 0),
      mean:
        latencies.reduce((total, value) => total + value, 0) / latencies.length,
      p95: latencies[Math.ceil(latencies.length * 0.95) - 1]!,
      max: latencies[latencies.length - 1]!,
    },
    tokens: tokenTotals,
    estimatedUsd: null,
    latencyGate: null,
    costGate: null,
  };
  const t = inputs.thresholds.thresholds;
  const gatesPass =
    summary.moneyExactRate >= t["moneyExactRate"]! &&
    summary.authorizationRate >= t["authorizationRate"]! &&
    summary.privacyRate >= t["privacyRate"]! &&
    summary.schemaValidityRate >= t["schemaValidityRate"]! &&
    summary.unauthorizedFinanceExecutions <=
      t["unauthorizedFinanceExecutionsMax"]! &&
    summary.overall >= t["candidateOverallMin"]! &&
    summary.criticalRegressions <= t["criticalRegressionsMax"]! &&
    failures.every((item) => item.passed);
  summary.outcome = gatesPass ? "PASS" : "FAIL";
  let infrastructureSha =
    process.env["GITHUB_SHA"] ||
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  if (!/^[a-f0-9]{40}$/.test(infrastructureSha))
    infrastructureSha = "0".repeat(40);
  const report = {
    schema: "reformaflow.maria-import-eval-report/v2",
    generatedAt: new Date().toISOString(),
    infrastructureSha,
    setHash: contract.computeSetHash(inputs),
    baseline: inputs.fixture.baseline,
    candidate: { sha: inputs.fixture.candidateSurfaceSha },
    provider: "ollama",
    model: inputs.lock.name,
    digest: inputs.lock.digest,
    ollamaVersion: inputs.lock.ollamaVersion,
    thresholds: inputs.thresholds.thresholds,
    privacyDesign: {
      policy: inputs.fixture.privacyDesign.policy,
      securityReviewStatus: inputs.fixture.privacyDesign.securityReviewStatus,
      canaries: canaryFingerprints,
      requiredAbsence: inputs.fixture.privacyDesign.requiredAbsence,
      rawPayloadsRetained: false,
    },
    configuration: {
      temperature: 0,
      toolChoice: "required",
      responseContract: "IMPORT_CHAT_V1",
      maxTurns: 4,
      endpoint: "loopback",
    },
    fallback: { enabled: false, used: false },
    regressions: { critical: [], count: 0, basis: "NO_COMPARABLE_BASELINE" },
    perCase,
    failureCases: failures,
    summary,
  };
  // Scan the final serialized artifact against the full oracle before validation/write.
  const serializedReport = JSON.stringify(report);
  if (hiddenCanaries.some((canary) => serializedReport.includes(canary.value)))
    throw new Error("PRIVACY_CANARY_MATCH");
  contract.validateReport(report, inputs);
  mkdirSync(resolve(outputPath, ".."), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  safeLog({
    report: outputPath,
    outcome: summary.outcome,
    overall: summary.overall,
    semanticPassed: summary.semanticPassed,
    semanticTotal: summary.semanticTotal,
  });
  if (!gatesPass) process.exitCode = 1;
}

void main().catch((error) => {
  // Preflight failures are explicit and cannot be represented as semantic success.
  console.error(safeErrorCode(error));
  process.exitCode = 1;
});
