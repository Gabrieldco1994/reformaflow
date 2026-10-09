import { Inject, Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../../../prisma/prisma.service";
import { IMPORT_VAULT_GATE, type ImportVaultGate } from "./vault-state";
import { VaultReaper } from "./vault-reaper";

const SCOPES_PER_CYCLE = 16;
const ITEMS_PER_SCOPE = 64;
const RETENTION_FAILURE = "Import vault retention failed";
const SUCCESSFUL_PURGES = new Set(["PURGED", "NOT_ELIGIBLE"]);

/** System maintenance uses only persisted scopes, never request-selected tenants.
 * A bounded keyset rotates fairly through scopes; per-process overlap is refused.
 * Reaper/purger still acquire the database writer and recheck eligibility.
 */
@Injectable()
export class VaultRetentionScheduler {
  private readonly logger = new Logger(VaultRetentionScheduler.name);
  private running = false;
  private after: { tenantId: string; ownerProjectId: string } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly reaper: VaultReaper,
    @Inject(IMPORT_VAULT_GATE) private readonly gate: ImportVaultGate,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async run(): Promise<void> {
    if (
      this.running ||
      this.gate.boot.stopped.aborted ||
      !this.gate.boot.runtime()
    )
      return;
    this.running = true;
    try {
      const scopes = await this.prisma.importSession.findMany({
        where: this.after
          ? {
              OR: [
                { tenantId: { gt: this.after.tenantId } },
                {
                  tenantId: this.after.tenantId,
                  ownerProjectId: { gt: this.after.ownerProjectId },
                },
              ],
            }
          : {},
        distinct: ["tenantId", "ownerProjectId"],
        orderBy: [{ tenantId: "asc" }, { ownerProjectId: "asc" }],
        take: SCOPES_PER_CYCLE,
        select: { tenantId: true, ownerProjectId: true },
      });
      for (const scope of scopes) {
        const result = await this.reaper.runCycle({
          ...scope,
          limit: ITEMS_PER_SCOPE,
        });
        if (
          result.purges.some((purge) => !SUCCESSFUL_PURGES.has(purge.outcome))
        ) {
          throw new Error(RETENTION_FAILURE);
        }
        this.after = scope;
      }
      if (scopes.length < SCOPES_PER_CYCLE) this.after = null;
    } catch {
      // No exception text, object IDs, CSV or scope keys enter the scheduler log.
      this.logger.error({ event: "import_vault_retention", outcome: "FAILED" });
      throw new Error(RETENTION_FAILURE);
    } finally {
      this.running = false;
    }
  }
}
