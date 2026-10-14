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
  PDF_OCR_DISPATCH_STATE,
  PdfOcrProviderError,
  VertexPdfOcrProvider,
} from "./vertex-pdf-ocr.provider";

interface VertexProviderFactoryDependencies {
  readonly admitServiceAccountFile?: (
    projectId: string,
  ) => Promise<AdmittedVertexServiceAccount>;
  readonly GoogleAuthClass?: GoogleAuthConstructor;
}

class DisabledVertexPdfOcrProvider implements FixedPdfOcrProviderPort {
  readonly provider = PDF_OCR_PROVIDER_ID;
  readonly model = PDF_OCR_MODEL_ID;

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

export async function createConfiguredVertexPdfOcrProvider(
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: VertexProviderFactoryDependencies = {},
): Promise<FixedPdfOcrProviderPort> {
  const config = parseVertexAuthConfig(environment);
  if (config.state === "OCR_DISABLED") {
    return new DisabledVertexPdfOcrProvider();
  }

  if (config.authMode === "service-account-file") {
    await (
      dependencies.admitServiceAccountFile ?? admitVertexServiceAccountFile
    )(config.projectId);
  }
  const token = createVertexAccessToken(config, dependencies.GoogleAuthClass);
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
