import type { ImportSessionEntryV1 } from "@reformaflow/domain";
import { IMPORT_SESSION_WRITES_ENABLED } from "./import-session.disabled";
import type { ImportSession, Prisma } from "@prisma/client";
import { parseStoredImportObservationEvidence } from "./import-session.observation";
import { readStoredImportExtraction } from "./import-session.extraction";

export interface ImportSessionClock {
  now(): Date;
}
export const IMPORT_SESSION_CLOCK = Symbol("IMPORT_SESSION_CLOCK");

export class SystemImportSessionClock implements ImportSessionClock {
  now(): Date {
    return new Date();
  }
}

/** Runtime seam of the kill switch; tests may override it, no route or environment can. */
export interface ImportSessionCapability {
  writesEnabled(): boolean;
  /** Qualified RAW intake, never inferred from parser or EXTRACTED support. */
  newImportFormats(): Readonly<
    Extract<ImportSessionEntryV1, { kind: "CARD_INVOICE" }>["formats"]
  >;
}
export const IMPORT_SESSION_CAPABILITY = Symbol("IMPORT_SESSION_CAPABILITY");

/** Broad mutations stay OFF; CSV is independently qualified through the guarded workflow. */
export class DefaultImportSessionCapability implements ImportSessionCapability {
  writesEnabled(): boolean {
    return IMPORT_SESSION_WRITES_ENABLED;
  }

  newImportFormats(): ReturnType<ImportSessionCapability["newImportFormats"]> {
    return ["CSV", "PDF"];
  }
}

/** Intake is qualified independently of the global financial mutation switch. */
export function csvIntakeEnabled(capability: ImportSessionCapability): boolean {
  return capability.newImportFormats().includes("CSV");
}
export function importIntakeEnabled(
  capability: ImportSessionCapability,
): boolean {
  return (
    capability.writesEnabled() ||
    capability
      .newImportFormats()
      .some((format) => format === "CSV" || format === "PDF")
  );
}

/**
 * Scoped release: only an entirely materialized CSV session can cross the financial
 * boundary while the broad switch remains OFF. Called inside the writer transaction.
 * Existing broad-switch test/rollback behavior remains unchanged.
 */
export async function importSessionWritesEnabled(
  tx: Prisma.TransactionClient,
  session: Pick<ImportSession, "id" | "tenantId" | "ownerProjectId">,
  capability: ImportSessionCapability,
): Promise<boolean> {
  if (capability.writesEnabled()) return true;
  if (!importIntakeEnabled(capability)) return false;
  const refs = await tx.importSessionArtifact.findMany({
    where: {
      sessionId: session.id,
      tenantId: session.tenantId,
      ownerProjectId: session.ownerProjectId,
      state: { not: "RELEASED" },
    },
    include: { artifact: { include: { observations: true } } },
  });
  if (
    !(
      refs.length > 0 &&
      refs.every(
        (ref) =>
          ref.state === "ATTACHED" &&
          ref.artifact?.tenantId === session.tenantId &&
          ref.artifact.ownerProjectId === session.ownerProjectId &&
          ref.artifact.state === "EXTRACTED" &&
          ((ref.artifact.detectedFormat === "CSV" &&
            capability.newImportFormats().includes("CSV") &&
            ref.artifact.parserVersion === "card-local-text-v1") ||
            (ref.artifact.detectedFormat === "PDF" &&
              capability.newImportFormats().includes("PDF") &&
              ref.artifact.parserVersion === "card-local-pdf-v1")),
      )
    )
  )
    return false;
  // Historical EXTRACTED support alone is not RAW qualification. Only materializations
  // that retain the immutable source description, checked against extraction, qualify.
  for (const ref of refs) {
    const artifact = ref.artifact!;
    const extraction = readStoredImportExtraction(artifact);
    const observations = artifact.observations;
    if (observations.length !== extraction.occurrences.length) return false;
    const sources = new Map(
      extraction.occurrences.map((o) => [o.reference, o.raw.description]),
    );
    if (
      !observations.every((o) => {
        // Canonically claimed rows are skipped by materialization. Terminal
        // cleanup keeps their reference/FKs, never their documentary evidence.
        if (o.canonicalExpenseId !== null || o.canonicalReceiptId !== null)
          return sources.has(o.reference);
        const evidence = parseStoredImportObservationEvidence(o.evidenceJson);
        return (
          evidence.sourceDescription !== undefined &&
          sources.has(o.reference) &&
          evidence.sourceDescription === sources.get(o.reference)
        );
      })
    )
      return false;
  }
  return true;
}
export const IMPORT_SESSION_GRANT_VERIFIER = Symbol(
  "IMPORT_SESSION_GRANT_VERIFIER",
);
