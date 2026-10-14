import {
  PDF_OCR_MODEL_ID,
  PDF_OCR_PROVIDER_ID,
  type PdfOcrDocumentV2,
} from "@reformaflow/domain";
import type {
  FixedPdfOcrProviderPort,
  FixedPdfOcrProviderRequest,
} from "./pdf-ocr.ports";
import {
  parseVertexAuthConfig,
  type OcrActivationAttestationVerifier,
  type VertexAuthConfig,
} from "./vertex-auth.config";
import {
  createVertexAccessToken,
  type GoogleAuthConstructor,
} from "./vertex-access-token.factory";
import {
  admitVertexServiceAccountFile,
  type AdmittedVertexServiceAccount,
} from "./vertex-service-account-file";
import {
  admitVertexLocalAdcFile,
  type AdmittedVertexLocalAdc,
} from "./vertex-local-adc-file";
import {
  PDF_OCR_DISPATCH_STATE,
  PdfOcrProviderError,
  VertexPdfOcrProvider,
} from "./vertex-pdf-ocr.provider";
import {
  parseOcrReleaseEnvelope,
  verifyOcrReleaseEnvelope,
} from "./ocr-release-envelope";
import {
  OCR_RUNTIME_EXECUTABLE_ERROR,
  verifyOcrRuntimeExecutable,
} from "./ocr-runtime-executable";

interface VertexProviderFactoryDependencies {
  readonly activationVerifier?: OcrActivationAttestationVerifier;
  readonly admitServiceAccountFile?: (
    projectId: string,
  ) => Promise<AdmittedVertexServiceAccount>;
  readonly admitAuthorizedUserFile?: () => Promise<AdmittedVertexLocalAdc>;
  readonly GoogleAuthClass?: GoogleAuthConstructor;
  readonly releaseVerifier?: (
    envelope: string,
    runtime: Readonly<Record<string, unknown>>,
  ) => Readonly<{ kind: "VERIFIED" }>;
  readonly parseAuthConfig?: typeof parseVertexAuthConfig;
}

class DisabledVertexPdfOcrProvider implements FixedPdfOcrProviderPort {
  readonly provider = PDF_OCR_PROVIDER_ID;
  readonly model = PDF_OCR_MODEL_ID;
  constructor(readonly disabledReason?: string) {}

  ready(): boolean {
    return false;
  }

  async extractPdf(
    _request: FixedPdfOcrProviderRequest,
  ): Promise<PdfOcrDocumentV2> {
    throw new PdfOcrProviderError(
      "AUTH",
      PDF_OCR_DISPATCH_STATE.NOT_DISPATCHED,
    );
  }
}

const RELEASE_HASH = /^[0-9a-f]{64}$/;
const RELEASE_SHA = /^[0-9a-f]{40}$/;
const RELEASE_IMAGE = /^sha256:[0-9a-f]{64}$/;

async function verifyRelease(
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: VertexProviderFactoryDependencies,
): Promise<boolean | string> {
  if (environment.NODE_ENV !== "production") return true;
  const raw = environment.OCR_RELEASE_ENVELOPE;
  if (!raw) return false;
  if (dependencies.releaseVerifier) {
    try {
      dependencies.releaseVerifier(raw, Object.freeze({}));
      return true;
    } catch {
      return false;
    }
  }
  const executableSubject = {
    commitSha: environment.OCR_CANDIDATE_SHA ?? "",
    treeSha: environment.OCR_TREE_SHA ?? "",
    imageDigest: environment.OCR_IMAGE_DIGEST ?? "",
    applicationEntrypointPath:
      environment.OCR_APPLICATION_ENTRYPOINT_PATH ?? "",
    executableSha256: environment.OCR_EXECUTABLE_SHA256 ?? "",
    runtimeSubjectArtifactSha256:
      environment.OCR_RUNTIME_SUBJECT_ARTIFACT_SHA256 ?? "",
  };
  let executable: Readonly<{ path: string; sha256: string }>;
  try {
    executable = await verifyOcrRuntimeExecutable(executableSubject);
  } catch {
    return OCR_RUNTIME_EXECUTABLE_ERROR.MISMATCH;
  }
  const runtime = Object.freeze({
    ...executableSubject,
    applicationEntrypointPath: executable.path,
    executableSha256: executable.sha256,
    activationSubjectSha256: environment.OCR_ACTIVATION_SUBJECT_SHA256 ?? "",
    allowedWorkflowShas: [environment.OCR_WORKFLOW_SHA ?? ""],
    now: new Date(),
  });
  try {
    if (
      !RELEASE_SHA.test(executableSubject.commitSha) ||
      !RELEASE_SHA.test(executableSubject.treeSha) ||
      !RELEASE_IMAGE.test(executableSubject.imageDigest) ||
      !RELEASE_HASH.test(executableSubject.runtimeSubjectArtifactSha256) ||
      !RELEASE_HASH.test(runtime.activationSubjectSha256) ||
      !RELEASE_SHA.test(runtime.allowedWorkflowShas[0]!)
    )
      return false;
    verifyOcrReleaseEnvelope(parseOcrReleaseEnvelope(raw), runtime);
    return true;
  } catch {
    return false;
  }
}

export async function createConfiguredVertexPdfOcrProvider(
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: VertexProviderFactoryDependencies = {},
): Promise<FixedPdfOcrProviderPort> {
  if (environment.IMPORT_OCR_ENABLED !== "true")
    return new DisabledVertexPdfOcrProvider();
  const release = await verifyRelease(environment, dependencies);
  if (release !== true)
    return new DisabledVertexPdfOcrProvider(
      typeof release === "string" ? release : undefined,
    );
  const parseAuthConfig = dependencies.parseAuthConfig ?? parseVertexAuthConfig;
  const config = parseAuthConfig(environment, {
    verifier: dependencies.activationVerifier,
    releaseVerified: true,
  });
  if (config.state === "OCR_DISABLED") {
    return new DisabledVertexPdfOcrProvider();
  }

  const admitted =
    config.authMode === "service-account-file"
      ? await (
          dependencies.admitServiceAccountFile ?? admitVertexServiceAccountFile
        )(config.projectId)
      : await (
          dependencies.admitAuthorizedUserFile ?? admitVertexLocalAdcFile
        )();
  const token = createVertexAccessToken(
    config,
    admitted.credentials,
    dependencies.GoogleAuthClass,
  );
  if (!token) throw new Error("VERTEX_AUTH_CONFIG_INVALID");
  return new VertexPdfOcrProvider(config.projectId, token);
}

export function requireEnabledVertexAuthConfig(
  environment: Readonly<Record<string, string | undefined>>,
): Exclude<VertexAuthConfig, { state: "OCR_DISABLED" }> {
  const config = parseVertexAuthConfig(environment);
  if (config.state === "OCR_DISABLED") {
    throw new Error("VERTEX_AUTH_CONFIG_INVALID");
  }
  return config;
}
