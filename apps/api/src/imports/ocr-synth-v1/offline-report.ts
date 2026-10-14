import { evaluateOcrSynth, type OcrEvalReport } from "./evaluator";
import { parseLiveEvidenceJson } from "./live-evidence-parser";

interface OfflineReportDependencies {
  readonly parse?: typeof parseLiveEvidenceJson;
  readonly evaluate?: typeof evaluateOcrSynth;
}

/**
 * Produces the unsigned absolute V4 assessment. Signature authority is added
 * only by the external KMS boundary after this report is persisted.
 */
export async function evaluateOfflineReport(
  raw: string,
  dependencies: OfflineReportDependencies = {},
): Promise<OcrEvalReport> {
  const parse = dependencies.parse ?? parseLiveEvidenceJson;
  const evaluate = dependencies.evaluate ?? evaluateOcrSynth;
  const input = parse(raw);
  return await evaluate(input);
}
