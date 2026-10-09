import { Logger } from "@nestjs/common";
import type { PrismaService } from "../../../prisma/prisma.service";
import { resolveUploadsRoots } from "../../../common/uploads-roots";
import type { ImportSessionClock } from "../import-session.capability";
import { startVaultBoot, type VaultBootHandle } from "./vault-boot";
import { VaultFdRegistry, type VaultShutdownResult } from "./vault-fd-registry";
import { VaultStorage, VaultIoError } from "./vault-storage";
import { PurgeCoordinator } from "./vault-purger";

export const IMPORT_VAULT_GATE: unique symbol = Symbol("IMPORT_VAULT_GATE");

export class ImportVaultGate {
  readonly boot: VaultBootHandle;
  readonly registry: VaultFdRegistry;
  readonly storage: VaultStorage;
  private purger?: PurgeCoordinator;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ImportSessionClock,
    env: NodeJS.ProcessEnv,
    cwd: string,
  ) {
    const captured = { ...env };
    this.registry = new VaultFdRegistry();
    this.boot = startVaultBoot(captured, resolveUploadsRoots(captured, cwd));
    const stop = () => {
      void this.registry.shutdown(this.boot.drainTimeoutMs);
    };
    this.boot.stopped.addEventListener("abort", stop, { once: true });
    if (this.boot.stopped.aborted) stop();
    this.storage = new VaultStorage(this.boot, this.registry, clock);
  }

  requirePurger(): PurgeCoordinator {
    const runtime = this.boot.runtime();
    if (!runtime)
      throw new VaultIoError({ kind: "UNAVAILABLE", step: "runtime" });
    this.purger ??= new PurgeCoordinator(
      this.prisma,
      this.clock,
      this.boot,
      this.registry,
      this.storage,
      runtime.config.drainTimeoutMs,
    );
    return this.purger;
  }

  shutdown(): Promise<VaultShutdownResult> {
    this.boot.revoke("SHUTDOWN");
    return this.registry.shutdown(this.boot.drainTimeoutMs);
  }

  async onModuleDestroy(): Promise<void> {
    const result = await this.shutdown();
    if (result !== "DRAINED")
      new Logger("ImportVaultGate").error({
        event: "vault_shutdown",
        outcome: result,
      });
  }
}

export function createImportVaultGate(
  prisma: PrismaService,
  clock: ImportSessionClock,
  env: NodeJS.ProcessEnv,
  cwd: string,
): ImportVaultGate {
  return new ImportVaultGate(prisma, clock, env, cwd);
}
