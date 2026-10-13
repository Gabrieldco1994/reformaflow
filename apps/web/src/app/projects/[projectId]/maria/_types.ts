export type OcrAvailability =
  | { state: "READY" }
  | {
      state: "DISABLED";
      reason: "FEATURE_OFF" | "PROVIDER_UNAVAILABLE" | "CONTRACT_PENDING";
    };

export type OcrCandidateStatus = "UNVERIFIED";

export interface OcrCandidateFieldView {
  key: string;
  label: string;
  value: string;
}

export interface OcrCandidateView {
  /** Opaque transport reference. It must never be presented as user context. */
  ref: string;
  status: OcrCandidateStatus;
  fields: readonly OcrCandidateFieldView[];
}

/**
 * The only authority-like value the browser may send from this foundation.
 * Actor, account, tenant, project, session, artifact hash, provider, model,
 * region and timestamps must be derived and revalidated by the server.
 */
export interface OcrConsentIntentV2 {
  version: 2;
  consentExternalProcessing: true;
}

export interface OcrPreparedCandidate {
  ref: string;
  fields: Readonly<Record<string, string>>;
  attested: true;
}

export interface OcrUiScope {
  /**
   * Opaque lifecycle identity for stale-result invalidation only. The adapter
   * owns its authorized route target; this value is never rendered or sent.
   */
  key: string;
  fileName: string;
}
