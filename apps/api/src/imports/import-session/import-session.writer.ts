import { Prisma } from "@prisma/client";
import {
  IMPORT_SESSION_LIMITS,
  ImportSessionErrorCode,
} from "@reformaflow/domain";
import type { PrismaService } from "../../prisma/prisma.service";
import type { ImportSessionClock } from "./import-session.capability";
import type { AuthenticatedImportContext } from "./import-session.contract";
import { ImportSessionError } from "./import-session.errors";

export function isRetryableWriteFailure(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    // P2034: write conflict/deadlock; P2002: a concurrent create won the unique key (re-read it).
    return error.code === "P2034" || error.code === "P2002";
  }
  const message = error instanceof Error ? error.message : "";
  return /SQLITE_BUSY|database is locked|database table is locked/i.test(
    message,
  );
}

/** Lock first; authorization, handles and all effects remain the caller's responsibility. */
export async function runImportSessionWrite<T>(
  prisma: Pick<PrismaService, "$transaction">,
  clock: ImportSessionClock,
  auth: Readonly<Pick<AuthenticatedImportContext, "tenantId">>,
  work: (tx: Prisma.TransactionClient, now: Date) => Promise<T>,
  assertCanStartAttempt?: () => undefined,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    assertCanStartAttempt?.();
    try {
      return await prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`UPDATE tenants SET updated_at = updated_at WHERE id = ${auth.tenantId}`;
          return work(tx, clock.now());
        },
        {
          maxWait: IMPORT_SESSION_LIMITS.transactionMaxWaitMs,
          timeout: IMPORT_SESSION_LIMITS.transactionTimeoutMs,
        },
      );
    } catch (error) {
      if (!isRetryableWriteFailure(error)) throw error;
      if (attempt >= IMPORT_SESSION_LIMITS.writeAttempts) {
        throw new ImportSessionError(
          ImportSessionErrorCode.RETRYABLE_WRITE_CONFLICT,
        );
      }
    }
  }
}
