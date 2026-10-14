import { evaluateOcrSynth, type OcrEvalReport } from "./evaluator";
import { parseLiveEvidenceJson } from "./live-evidence-parser";
import {
  attestQualityClosure,
  createQualityClosureVerifier,
  isStructurallySignedQualityClosure,
  issueVerifiedQualityClosureToken,
  type VerifiedQualityClosureToken,
} from "./quality-closure-attestation";

interface OfflineReportDependencies {
  readonly parse?: typeof parseLiveEvidenceJson;
  readonly evaluate?: typeof evaluateOcrSynth;
  readonly issueToken?: (
    raw: ReturnType<typeof parseLiveEvidenceJson>,
  ) => Promise<VerifiedQualityClosureToken | undefined>;
}

async function issueTrustedToken(
  input: ReturnType<typeof parseLiveEvidenceJson>,
): Promise<VerifiedQualityClosureToken | undefined> {
  if (!isStructurallySignedQualityClosure(input.qualityClosure))
    return undefined;
  const rerun = await attestQualityClosure();
  return await issueVerifiedQualityClosureToken(
    input,
    rerun.closure,
    rerun.policy,
    { verifier: createQualityClosureVerifier() },
  );
}

/** Offline product scoring over parser-validated evidence; no network access. */
export async function evaluateOfflineReport(
  raw: string,
  dependencies: OfflineReportDependencies = {},
): Promise<OcrEvalReport> {
  const parse = dependencies.parse ?? parseLiveEvidenceJson;
  const evaluate = dependencies.evaluate ?? evaluateOcrSynth;
  const input = parse(raw);
  const token = await (dependencies.issueToken ?? issueTrustedToken)(input);
  return await evaluate(input, token);
}
