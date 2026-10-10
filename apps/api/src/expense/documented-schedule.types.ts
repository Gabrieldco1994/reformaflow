import type { ExpenseScheduleOccurrence } from '@reformaflow/domain';

export const EVIDENCE_KIND = {
  DOCUMENT: 'document',
  USER_ATTESTATION: 'user-attestation',
} as const;

interface ArtifactReference {
  documentSha256: string;
  reference: string;
}

export type DocumentScheduleEvidenceInput = ArtifactReference & {
  evidenceKind?: typeof EVIDENCE_KIND.DOCUMENT;
};

export type ScheduleEvidenceInput =
  | DocumentScheduleEvidenceInput
  | (ArtifactReference & {
      evidenceKind: typeof EVIDENCE_KIND.USER_ATTESTATION;
      attestedByUserId: string;
      attestedAt: string;
    });

export type ScheduleEvidence = ScheduleEvidenceInput & {
  actorUserId: string;
  recordedAt: string;
};

export interface DocumentaryCycle {
  invoiceDueMonth: string;
  evidence: DocumentScheduleEvidenceInput;
}

export interface ScheduleOperationReceipt {
  requestId: string;
  payloadHash: string;
  resultingStateHash: string;
  actorUserId: string;
  recordedAt: string;
  mirrorCorrections?: Array<MirrorCorrection & { cashFlowEntryId: string }>;
}

export interface MirrorCorrection {
  targetCashFlowEntryId: string;
  before: { sourceAmountCents: number; targetAmountCents: number };
  after: { sourceAmountCents: number; targetAmountCents: number };
}

export const ASSISTED_CARD = 'assisted-card';
export const ASSISTANCE_BASIS = {
  NONE: 'no-import-reference',
  ABSENT: 'absent-legacy-reference',
} as const;
export const REFERENCE_CHECK = {
  NONE: 'NO_REFERENCE',
  ABSENT: 'ABSENT_IN_CARD_AND_BANK_IMPORTS',
} as const;

export interface ScheduleAssistance {
  basis: (typeof ASSISTANCE_BASIS)[keyof typeof ASSISTANCE_BASIS];
  reason: string;
  evidence: ScheduleEvidenceInput;
}

export type AssistedCardProvenance = {
  kind: typeof ASSISTED_CARD;
  originalExternalId: string | null;
  evidence: ScheduleEvidence;
  reason: string;
} & (
  | {
      basis: typeof ASSISTANCE_BASIS.NONE;
      originalImportId: null;
      referenceCheck: typeof REFERENCE_CHECK.NONE;
    }
  | {
      basis: typeof ASSISTANCE_BASIS.ABSENT;
      originalImportId: string;
      referenceCheck: typeof REFERENCE_CHECK.ABSENT;
      checkedAt: string;
    }
);

export interface StoredSourceOccurrence extends ExpenseScheduleOccurrence {
  amountEvidence: ScheduleEvidence | null;
  cycleEvidence: ScheduleEvidence | null;
}

export interface StoredProjectionOccurrence extends ExpenseScheduleOccurrence {
  sourceIndex: number;
}

export type ScheduleProjectionRef =
  | {
      kind: 'mirror';
      targetExpenseId: string;
      occurrenceMap: Array<{ sourceIndex: number; targetIndex: number }>;
    }
  | {
      kind: 'rateio';
      allocationId: string;
      targetExpenseId: string;
      occurrenceMap: Array<{ sourceIndex: number; targetIndex: number }>;
    };

interface StoredScheduleBase {
  version: 1;
  tenantId: string;
  sourceExpenseId: string;
  sourceProjectId: string;
  cardId: string;
  recordedByUserId: string;
  recordedAt: string;
}

export interface StoredSourceScheduleV1 extends StoredScheduleBase {
  kind: 'source';
  importId: string;
  externalId: string;
  occurrences: StoredSourceOccurrence[];
  projections: ScheduleProjectionRef[];
  lastOperation: ScheduleOperationReceipt | null;
}

export type StoredProjectionScheduleV1 = StoredScheduleBase & {
  kind: 'projection';
  targetExpenseId: string;
  targetProjectId: string;
  occurrences: StoredProjectionOccurrence[];
} & (
    | { via: 'mirror'; allocationId: null }
    | { via: 'rateio'; allocationId: string }
  );

export type StoredExpenseScheduleV1 =
  | StoredSourceScheduleV1
  | StoredProjectionScheduleV1;

export type StoredAssistedSourceScheduleV2 = Omit<
  StoredSourceScheduleV1,
  'version' | 'importId' | 'externalId'
> & {
  version: 2;
  provenance: AssistedCardProvenance;
};

export type StoredSourceSchedule =
  | StoredSourceScheduleV1
  | StoredAssistedSourceScheduleV2;
export type StoredExpenseSchedule =
  | StoredExpenseScheduleV1
  | StoredAssistedSourceScheduleV2;
