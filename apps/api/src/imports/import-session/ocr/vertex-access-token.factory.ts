import type { VertexAuthTraceV2 } from "@reformaflow/domain";
import { GoogleAuth } from "google-auth-library";
import type { VertexAuthConfig } from "./vertex-auth.config";
import { VERTEX_AUTH_STARTUP_ERROR } from "./vertex-auth.config";
import {
  PdfOcrProviderError,
  VERTEX_ADC_SCOPES,
  type VertexAccessTokenPort,
} from "./vertex-pdf-ocr.provider";
import { VERTEX_SERVICE_ACCOUNT_KEY_PATH } from "./vertex-service-account-file";

interface GoogleAuthClientPort {
  getClient(): Promise<{
    getAccessToken(): Promise<string | { token?: string | null } | null>;
  }>;
}

export type GoogleAuthConstructor = new (options: {
  keyFilename?: string;
  scopes: string[];
}) => GoogleAuthClientPort;

async function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    throw new PdfOcrProviderError("TIMEOUT", "NOT_DISPATCHED");
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new PdfOcrProviderError("TIMEOUT", "NOT_DISPATCHED"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export class GoogleAuthVertexAccessToken implements VertexAccessTokenPort {
  constructor(
    readonly authTrace: VertexAuthTraceV2,
    private readonly auth: GoogleAuthClientPort,
  ) {
    Object.freeze(this);
  }

  async accessToken(signal: AbortSignal): Promise<string> {
    try {
      const client = await abortable(this.auth.getClient(), signal);
      const result = await abortable(client.getAccessToken(), signal);
      const token = typeof result === "string" ? result : result?.token;
      if (!token) throw new Error("missing_token");
      return token;
    } catch (error) {
      if (error instanceof PdfOcrProviderError) throw error;
      throw new PdfOcrProviderError("AUTH", "NOT_DISPATCHED");
    }
  }
}

/** Creates one explicit credential source, with no probing or fallback. */
export function createVertexAccessToken(
  config: VertexAuthConfig,
  GoogleAuthClass: GoogleAuthConstructor = GoogleAuth,
): VertexAccessTokenPort | null {
  if (config.state === "OCR_DISABLED") return null;

  const options =
    config.authMode === "service-account-file"
      ? {
          keyFilename: VERTEX_SERVICE_ACCOUNT_KEY_PATH,
          scopes: [...VERTEX_ADC_SCOPES],
        }
      : { scopes: [...VERTEX_ADC_SCOPES] };
  try {
    return new GoogleAuthVertexAccessToken(
      config.authTrace,
      new GoogleAuthClass(options),
    );
  } catch {
    throw new Error(VERTEX_AUTH_STARTUP_ERROR);
  }
}
