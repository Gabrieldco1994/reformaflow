import { createHash } from "node:crypto";
import {
  assertOcrFinancialStateUnchanged,
  observeOcrBoundary,
  type OcrBoundaryExecution,
  type OcrBoundaryObservation,
} from "./boundary-observer";

const ROUTE_IDS = Object.freeze(
  Array.from(
    { length: 10 },
    (_, index) => `mixed-${String(index + 1).padStart(3, "0")}`,
  ),
);

const PROBE_IDS = Object.freeze([
  "WRONG_ENDPOINT",
  "WRONG_MODEL",
  "WRONG_REGION",
  "API_KEY_AUTH",
  "ADC_SCOPE_BOUNDED",
  "REQUEST_BODY_BOUNDED",
  "DEADLINE_BOUNDED",
  "GLOBAL_ENDPOINT_FALLBACK",
  "TOOLS_PRESENT",
  "FILE_URI_PRESENT",
  "CACHE_PRESENT",
  "TEXTUAL_PDF_PROVIDER_CALL",
  "LOCAL_RASTER_SANDBOX",
  "PAGE_11_ADMISSION",
  "MIXED_LOCAL_PROVIDER_DUPLICATION",
  "PARTIAL_RESPONSE",
  "MALFORMED_RESPONSE",
  "TRUNCATED_RESPONSE",
  "SAFETY_BLOCKED_RESPONSE",
  "AMBIGUOUS_TIMEOUT_RETRY",
  "UNKNOWN_OUTCOME_NO_RETRY",
  "DURABLE_TENANT_BUDGET",
  "DURABLE_GLOBAL_BUDGET",
  "ACTIVE_SESSION_CONTENT_PURGE_AFTER_7_DAYS",
  "EXACT_CONSENT_CAPABILITY",
  "SELECTED_TRUE_DEFAULT",
  "VERIFIED_DEFAULT",
  "MISSING_CONSENT",
  "MISSING_ATTESTATION",
  "FINANCIAL_WRITE",
  "KNOWN_SAFETY_FINISH_REASONS",
  "TERMINAL_FAILURE_REPLAY_NO_CALL",
  "CAPABILITY_OFF",
  "PRIOR_CONSENT_DECLARATION",
  "RESIDUAL_RISK_ACCEPTANCE",
] as const);

export interface OcrBoundaryScenario {
  readonly identity: string;
  readonly boundary: string;
  readonly scenarioSha256: string;
}

const scenario = (identity: string, boundary: string): OcrBoundaryScenario =>
  Object.freeze({
    identity,
    boundary,
    scenarioSha256: createHash("sha256")
      .update(`ocr-boundary-v1:${identity}:${boundary}`)
      .digest("hex"),
  });

export const OCR_BOUNDARY_SCENARIOS = Object.freeze([
  ...ROUTE_IDS.map((id) => scenario(`[ROUTE] ${id}`, "extractPdfDocument")),
  ...PROBE_IDS.map((id) =>
    scenario(
      `[PROBE] ${id}`,
      id === "ACTIVE_SESSION_CONTENT_PURGE_AFTER_7_DAYS"
        ? "VaultReaper"
        : id.startsWith("DURABLE_")
          ? "reservePdfOcrBudget"
          : id === "RESIDUAL_RISK_ACCEPTANCE"
            ? "SRE_REVIEW_DESCRIPTOR"
            : "ImportSessionExtractionService.analyzeAttached",
    ),
  ),
]);

if (
  OCR_BOUNDARY_SCENARIOS.length !== 45 ||
  new Set(OCR_BOUNDARY_SCENARIOS.map((item) => item.identity)).size !== 45
)
  throw new Error("OCR_BOUNDARY_REGISTRY_INVALID");

export interface OcrBoundaryScenarioExecutor {
  execute(scenario: OcrBoundaryScenario): Promise<OcrBoundaryExecution>;
}

/**
 * Executes the fixed registry in order. The caller provides boundary adapters,
 * not identities or claimed outcomes; the runner owns all scenario bindings.
 */
export async function runOcrBoundaryScenarios(
  executor: OcrBoundaryScenarioExecutor,
): Promise<readonly OcrBoundaryObservation[]> {
  const observations: OcrBoundaryObservation[] = [];
  for (const scenario of OCR_BOUNDARY_SCENARIOS)
    observations.push(
      await observeOcrBoundary(
        scenario.identity,
        scenario.boundary,
        scenario.scenarioSha256,
        () => executor.execute(scenario),
      ),
    );
  if (
    observations.length !== OCR_BOUNDARY_SCENARIOS.length ||
    observations.some(
      (observation, index) =>
        observation.identity !== OCR_BOUNDARY_SCENARIOS[index]?.identity ||
        observation.boundary !== OCR_BOUNDARY_SCENARIOS[index]?.boundary ||
        observation.scenarioSha256 !==
          OCR_BOUNDARY_SCENARIOS[index]?.scenarioSha256,
    )
  )
    throw new Error("BOUNDARY_EVIDENCE_INCOMPLETE");
  for (const observation of observations)
    assertOcrFinancialStateUnchanged(observation);
  return Object.freeze(observations);
}
