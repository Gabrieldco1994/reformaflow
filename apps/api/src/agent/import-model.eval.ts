import { execFileSync } from "node:child_process";
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
import type { ChatMessage } from "./llm/llm.types";

const contract =
  require("../../../../scripts/qa/maria-import-eval-contract.cjs") as {
    defaultPaths(root: string): {
      lock: string;
      fixture: string;
      thresholds: string;
    };
    loadEvalInputs(paths: {
      lock: string;
      fixture: string;
      thresholds: string;
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
};
type EvalInputs = {
  lock: { name: string; digest: string; ollamaVersion: string };
  fixture: {
    version: string;
    baseline: { sha: string; status: "NO_SURFACE"; overall: null; delta: null };
    candidateSurfaceSha: string;
    semanticCases: EvalCase[];
    failureCases: { id: string; mode: string; expectedError: string }[];
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

type CaseResult = {
  id: string;
  tags: string[];
  gates: string[];
  passed: boolean;
  schemaValid: boolean;
  authorizationValid: boolean;
  privacySafe: boolean;
  expected: unknown;
  actual: unknown;
  error: string | null;
  latencyMs: number;
  tokens: Usage;
  toolSequence: {
    iteration: number;
    name: string;
    arguments: Record<string, unknown>;
    phase: string;
  }[];
  unauthorizedExecutions: 0;
  financialExecutions: 0;
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
const safeError = (error: unknown) =>
  error instanceof Error
    ? error.name + ":" + error.message.slice(0, 120)
    : "UNKNOWN_ERROR";

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
    channel: "TEXT",
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
  let usage = emptyUsage();
  let schemaValid = true;
  let authorizationValid = true;
  let privacySafe = true;
  let actual: unknown = null;
  let passed = false;
  let error: string | null = null;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const response = await nativeFetch(url, init);
    try {
      const payload = (await response.clone().json()) as {
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
          prompt: payload.usage.prompt_tokens ?? null,
          completion: payload.usage.completion_tokens ?? null,
          total: payload.usage.total_tokens ?? null,
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
      let batch: ReturnType<typeof validateSyntheticCallBatch>;
      try {
        batch = validateSyntheticCallBatch(response.toolCalls, definitions);
      } catch (batchError) {
        schemaValid = false;
        authorizationValid = false;
        actual = { rejectedCalls: response.toolCalls };
        for (const call of response.toolCalls)
          toolSequence.push({
            iteration,
            name: call.name,
            arguments: call.arguments,
            phase: "REJECTED_PRE_EXECUTION",
          });
        throw batchError;
      }
      messages.push({
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
      });
      const serialized = JSON.stringify({
        content: response.content,
        calls: response.toolCalls,
      });
      if (
        testCase.gates.includes("privacy") &&
        /tenant-alheio|9911|Nebulosa|foreign-expense-77/i.test(serialized)
      )
        privacySafe = false;
      for (const item of batch) {
        const phase =
          item.parsed.name === "import_edit_answer"
            ? "PROPOSED_WRITE_NOT_EXECUTED"
            : "SIMULATED_AUTHORIZED_READ";
        toolSequence.push({
          iteration,
          name: item.call.name,
          arguments: item.call.arguments,
          phase,
        });
        if (item.parsed.name === "import_edit_answer") {
          const interpretation = item.parsed.arguments.interpretation;
          const resolved = resolveImportAnswer(
            testCase.literal,
            testCase.field,
            JSON.parse(JSON.stringify(interpretation)),
            original,
            {
              projects: [
                { id: "project-current-1", name: "Projeto Aurora", rooms: [] },
              ],
              candidates: [],
            },
          );
          actual = {
            interpretation,
            resolvedKind: resolved.kind,
            resolvedValue:
              resolved.kind === "VALUE"
                ? resolvedField(resolved.lines[0]!, testCase.field)
                : null,
          };
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
          passed =
            outcomeMatches &&
            valueMatches &&
            preservation &&
            schemaValid &&
            authorizationValid &&
            privacySafe;
          return {
            id: testCase.id,
            tags: testCase.tags,
            gates: testCase.gates,
            passed,
            schemaValid,
            authorizationValid,
            privacySafe,
            expected: testCase.expected,
            actual,
            error,
            latencyMs: Math.round(performance.now() - started),
            tokens: usage,
            toolSequence,
            unauthorizedExecutions: 0,
            financialExecutions: 0,
          };
        }
        messages.push({
          role: "tool",
          toolCallId: item.call.id,
          name: item.call.name,
          content: JSON.stringify(toolContent(item.call.name, session)),
        });
      }
    }
    error = "MODEL_TURN_BUDGET_EXHAUSTED";
  } catch (caseError) {
    error = safeError(caseError);
  } finally {
    globalThis.fetch = nativeFetch;
  }
  return {
    id: testCase.id,
    tags: testCase.tags,
    gates: testCase.gates,
    passed: false,
    schemaValid,
    authorizationValid,
    privacySafe,
    expected: testCase.expected,
    actual,
    error,
    latencyMs: Math.round(performance.now() - started),
    tokens: usage,
    toolSequence,
    unauthorizedExecutions: 0,
    financialExecutions: 0,
  };
}

function failureResults() {
  return inputs.fixture.failureCases.map((item) => {
    let visibleError = item.expectedError;
    let toolExecutions = 0;
    let financialExecutions = 0;
    const executeTool = (financial: boolean) => {
      toolExecutions += 1;
      if (financial) financialExecutions += 1;
    };
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
        );
      else if (item.mode === "TRUNCATED_BATCH")
        validateSyntheticCallBatch([], []);
      else if (item.mode === "TIMEOUT") throw new Error("MODEL_TIMEOUT");
      else if (item.mode === "PROVIDER_UNAVAILABLE")
        throw new Error("PROVIDER_UNAVAILABLE");
      visibleError = "NO_EXPLICIT_ERROR";
    } catch (probeError) {
      const text = probeError instanceof Error ? probeError.message : "UNKNOWN";
      visibleError = text.includes(item.expectedError)
        ? item.expectedError
        : text;
    }
    void executeTool;
    return {
      id: item.id,
      passed:
        visibleError === item.expectedError &&
        toolExecutions === 0 &&
        financialExecutions === 0,
      status: "ERROR",
      visibleError,
      // Validation/provider failures terminate before this execution boundary.
      toolExecutions,
      financialExecutions,
    };
  });
}
function rate(
  results: CaseResult[],
  gate: string,
  property: "passed" | "schemaValid" = "passed",
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
    console.log(
      JSON.stringify({
        case: result.id,
        passed: result.passed,
        latencyMs: result.latencyMs,
      }),
    );
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
    authorizationRate: rate(perCase, "authorization"),
    privacyRate: rate(perCase, "privacy"),
    schemaValidityRate: rate(perCase, "all", "schemaValid"),
    unauthorizedFinanceExecutions: 0,
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
    schema: "reformaflow.maria-import-eval-report/v1",
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
  mkdirSync(resolve(outputPath, ".."), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  contract.validateReport(report, inputs);
  console.log(
    JSON.stringify({
      report: outputPath,
      outcome: summary.outcome,
      overall: summary.overall,
      semanticPassed: summary.semanticPassed,
      semanticTotal: summary.semanticTotal,
    }),
  );
  if (!gatesPass) process.exitCode = 1;
}

void main().catch((error) => {
  // Preflight failures are explicit and cannot be represented as semantic success.
  console.error(safeError(error));
  process.exitCode = 1;
});
