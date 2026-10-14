import { Inject, Injectable } from "@nestjs/common";
import { performance } from "node:perf_hooks";
import {
  IMPORT_SESSION_LIMITS as LIMITS,
  ImportSessionErrorCode as Code,
} from "@reformaflow/domain";
import {
  IMPORT_SESSION_CAPABILITY,
  IMPORT_SESSION_CLOCK,
  type ImportSessionCapability,
  type ImportSessionClock,
  importIntakeEnabled,
} from "./import-session.capability";
import { extractCardStatementDocument } from "../../credit-card/parsers/statement-document";
import { inspectPdfDocument } from "../../credit-card/parsers/pdf-document";
import {
  DocumentExtractionError,
  type DocumentExtractionV1,
} from "../../credit-card/parsers/types";
import { ImportSessionError } from "./import-session.errors";
import { IMPORT_VAULT_GATE, type ImportVaultGate } from "./vault/vault-state";
import type { VaultFdLease } from "./vault/vault-fd-registry";

export const CSV_PARSER_DEADLINE_MS = 60_000;
export interface ImportCsvSettlement {
  readonly cleanup: "CLEAN";
}
export interface ImportCsvRunHandle {
  readonly result: Promise<
    | Readonly<{ kind: "SUCCESS"; document: DocumentExtractionV1 }>
    | Readonly<{ kind: "OCR_ELIGIBLE"; pageCount: number }>
  >;
  readonly settled: Promise<ImportCsvSettlement>;
}
export type ImportRawClaim = Readonly<{
  tenantId: string;
  ownerProjectId: string;
  sessionId: string;
  artifactId: string;
  parseGeneration: number;
}>;
export type ImportRawRuntime = NonNullable<
  ReturnType<ImportVaultGate["boot"]["runtime"]>
>;
const RAW_ADMISSION: unique symbol = Symbol("RAW_ADMISSION");
export type ImportRawAdmission = Readonly<{
  [RAW_ADMISSION]: true;
  signal: AbortSignal;
}>;
export type ImportRawAdmissionInput = Readonly<{
  documentFormat?: "CSV" | "PDF";
  claim: ImportRawClaim;
  ownerUserId: string;
  runtime: ImportRawRuntime;
  requestSignal?: AbortSignal;
  deadlineMonotonicMs: number;
  leaseExpiresAtMs: number;
}>;
export type ImportRawClose = "RELEASED";
type Entry = {
  admission: ImportRawAdmission;
  input: ImportRawAdmissionInput;
  controller: AbortController;
  lease: VaultFdLease;
  started: boolean;
  closed: boolean;
  released: boolean;
  dispose(): void;
};

@Injectable()
export class ImportRawExecutions {
  private readonly active = new Set<Entry>();
  private readonly admissions = new WeakMap<ImportRawAdmission, Entry>();

  constructor(
    @Inject(IMPORT_VAULT_GATE) private readonly gate: ImportVaultGate,
    @Inject(IMPORT_SESSION_CLOCK) private readonly clock: ImportSessionClock,
    @Inject(IMPORT_SESSION_CAPABILITY)
    private readonly capability: ImportSessionCapability,
  ) {}

  assertAvailable(documentFormat?: "CSV" | "PDF"): undefined {
    if (
      !documentFormat ||
      !this.capability.newImportFormats().includes(documentFormat) ||
      !importIntakeEnabled(this.capability) ||
      this.gate.boot.stopped.aborted ||
      !this.gate.boot.runtime()
    )
      throw new ImportSessionError(Code.CAPABILITY_DISABLED);
    return undefined;
  }

  admit(input: ImportRawAdmissionInput): ImportRawAdmission {
    this.assertAvailable(input.documentFormat);
    if (
      !Number.isFinite(input.deadlineMonotonicMs) ||
      !Number.isFinite(input.leaseExpiresAtMs) ||
      this.gate.boot.runtime() !== input.runtime
    )
      throw new ImportSessionError(Code.CAPABILITY_DISABLED);
    if (
      this.active.size >= LIMITS.concurrentParsersGlobal ||
      [...this.active].filter(
        (e) => e.input.claim.tenantId === input.claim.tenantId,
      ).length >= LIMITS.concurrentParsersPerTenant
    )
      throw new ImportSessionError(Code.LEASE_CONFLICT);
    const entered = this.gate.registry.enter(`A:${input.claim.artifactId}`, {
      ...input.claim,
      ownerUserId: input.ownerUserId,
    });
    if (!entered.ok) throw new ImportSessionError(Code.LEASE_CONFLICT);
    const controller = new AbortController();
    const admission: ImportRawAdmission = Object.freeze({
      [RAW_ADMISSION]: true,
      signal: controller.signal,
    });
    const captured = Object.freeze({
      ...input,
      claim: Object.freeze({ ...input.claim }),
    });
    const listeners: Array<readonly [AbortSignal, () => void]> = [];
    const watch = (signal: AbortSignal | undefined, code: Code) => {
      if (!signal) return;
      const abort = () => controller.abort(new ImportSessionError(code));
      listeners.push([signal, abort]);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    };
    const expire = () =>
      controller.abort(
        new ImportSessionError(
          performance.now() >= captured.deadlineMonotonicMs
            ? Code.LIMIT_EXCEEDED
            : Code.LEASE_CONFLICT,
        ),
      );
    const timer = setTimeout(
      expire,
      Math.max(
        0,
        Math.min(
          captured.deadlineMonotonicMs - performance.now(),
          captured.leaseExpiresAtMs - this.clock.now().getTime(),
        ),
      ),
    );
    timer.unref();
    const entry: Entry = {
      admission,
      input: captured,
      controller,
      lease: entered.lease,
      started: false,
      closed: false,
      released: false,
      dispose() {
        clearTimeout(timer);
        for (const [signal, listener] of listeners)
          signal.removeEventListener("abort", listener);
      },
    };
    this.active.add(entry);
    this.admissions.set(admission, entry);
    watch(this.gate.boot.stopped, Code.CAPABILITY_DISABLED);
    watch(entered.lease.signal, Code.LEASE_CONFLICT);
    watch(input.requestSignal, Code.LEASE_CONFLICT);
    try {
      this.assertLive(admission);
      return admission;
    } catch (error) {
      this.close(admission);
      throw error;
    }
  }

  assertLive(admission: ImportRawAdmission): undefined {
    const entry = this.owned(admission);
    this.assertAvailable(entry.input.documentFormat);
    if (entry.input.runtime !== this.gate.boot.runtime())
      throw new ImportSessionError(Code.CAPABILITY_DISABLED);
    if (entry.closed) throw new ImportSessionError(Code.LEASE_CONFLICT);
    if (entry.controller.signal.aborted) {
      const reason: unknown = entry.controller.signal.reason;
      throw reason instanceof ImportSessionError
        ? reason
        : new ImportSessionError(Code.LEASE_CONFLICT);
    }
    if (performance.now() >= entry.input.deadlineMonotonicMs)
      throw new ImportSessionError(Code.LIMIT_EXCEEDED);
    if (this.clock.now().getTime() >= entry.input.leaseExpiresAtMs)
      throw new ImportSessionError(Code.LEASE_CONFLICT);
    return undefined;
  }

  /** Bounded UTF-8 text parser uses the same admission, FD lease and cancellation fence. */
  startCsv(admission: ImportRawAdmission, bytes: Buffer): ImportCsvRunHandle {
    this.assertLive(admission);
    const entry = this.owned(admission);
    if (entry.started || entry.input.documentFormat !== "CSV")
      throw new ImportSessionError(Code.LEASE_CONFLICT);
    entry.started = true;
    const result: ImportCsvRunHandle["result"] = Promise.resolve().then(() => {
      this.assertLive(admission);
      try {
        // Profile is inferred from the immutable header, never chat or client metadata.
        const header = bytes.toString("utf8").split(/\r?\n/, 1)[0];
        const document = extractCardStatementDocument({
          version: 1,
          context: "CARD_INVOICE",
          format: "CSV",
          profile: header.includes(";") ? "CSV_ITAU" : "CSV_NUBANK",
          bytes,
        });
        this.assertLive(admission);
        return { kind: "SUCCESS" as const, document };
      } catch (error) {
        if (error instanceof DocumentExtractionError)
          throw new ImportSessionError(
            error.code === "LIMIT_EXCEEDED"
              ? Code.LIMIT_EXCEEDED
              : error.code === "INVALID_INPUT"
                ? Code.INVALID_INPUT
                : Code.UNSUPPORTED_DOCUMENT,
          );
        throw error;
      }
    });
    return { result, settled: Promise.resolve({ cleanup: "CLEAN" }) };
  }
  startPdf(admission: ImportRawAdmission, bytes: Buffer): ImportCsvRunHandle {
    this.assertLive(admission);
    const entry = this.owned(admission);
    if (entry.started || entry.input.documentFormat !== "PDF")
      throw new ImportSessionError(Code.LEASE_CONFLICT);
    entry.started = true;
    const result = inspectPdfDocument(
      bytes,
      admission.signal,
      entry.input.deadlineMonotonicMs - performance.now(),
    ).then((inspection) => {
      this.assertLive(admission);
      return inspection.kind === "LOCAL"
        ? { kind: "SUCCESS" as const, document: inspection.document }
        : inspection;
    });
    const settled = result.then(
      () => ({ cleanup: "CLEAN" as const }),
      () => ({ cleanup: "CLEAN" as const }),
    );
    return { result, settled };
  }
  abortOwned(
    claims: readonly ImportRawClaim[],
    reason: "CANCEL" | "EXPIRE" | "AC18",
  ): readonly ("ABORTED" | "ALREADY_ABORTED" | "NOT_LOCAL")[] {
    return claims.map((claim) => {
      const entry = [...this.active].find(
        ({ input: { claim: own } }) =>
          own.tenantId === claim.tenantId &&
          own.ownerProjectId === claim.ownerProjectId &&
          own.sessionId === claim.sessionId &&
          own.artifactId === claim.artifactId &&
          own.parseGeneration === claim.parseGeneration,
      );
      if (!entry) return "NOT_LOCAL";
      if (entry.controller.signal.aborted) return "ALREADY_ABORTED";
      entry.controller.abort(
        new ImportSessionError(
          reason === "EXPIRE" ? Code.SESSION_EXPIRED : Code.LEASE_CONFLICT,
        ),
      );
      return "ABORTED";
    });
  }

  close(admission: ImportRawAdmission): ImportRawClose {
    const entry = this.owned(admission);
    entry.closed = true;
    return this.finish(entry);
  }

  private owned(admission: ImportRawAdmission): Entry {
    const entry = this.admissions.get(admission);
    if (!entry || admission[RAW_ADMISSION] !== true)
      throw new ImportSessionError(Code.LEASE_CONFLICT);
    return entry;
  }

  private finish(entry: Entry): ImportRawClose {
    // CSV parsing is synchronous inside one microtask: there is no child process
    // or deferred native cleanup to drain after this admission closes.
    if (!entry.released) {
      entry.released = true;
      entry.dispose();
      entry.lease.exit();
      this.active.delete(entry);
    }
    return "RELEASED";
  }
}
