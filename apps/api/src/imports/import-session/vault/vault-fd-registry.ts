export type VaultKey = `R:${string}` | `A:${string}`;
export type VaultFdOwner = Readonly<{
  tenantId: string;
  ownerProjectId: string;
  ownerUserId: string;
}>;
export type VaultFdLease = Readonly<{
  signal: AbortSignal;
  done: Promise<void>;
  exit(): void;
}>;
export type VaultAdmission =
  | Readonly<{ ok: true; lease: VaultFdLease }>
  | Readonly<{ ok: false; reason: "FENCED" }>;
export type VaultDrainResult = "DRAINED" | "TIMEOUT";
export type VaultShutdownResult = VaultDrainResult | "UNCONFIGURED";
export type VaultLiveUpload = Readonly<VaultFdOwner & { refId: string }>;
type Entry = {
  owner: VaultFdOwner;
  controller: AbortController;
  lease: VaultFdLease;
};

export class VaultFdRegistry {
  private readonly entries = new Map<VaultKey, Set<Entry>>();
  private readonly fences = new Set<VaultKey>();
  private sealed = false;
  private shutdownPromise?: Promise<VaultShutdownResult>;

  enter(key: VaultKey, owner: VaultFdOwner): VaultAdmission {
    if (this.sealed || this.fences.has(key))
      return { ok: false, reason: "FENCED" };
    const group = this.entries.get(key) ?? new Set<Entry>();
    const controller = new AbortController();
    let complete!: () => void;
    const done = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const lease: VaultFdLease = Object.freeze({
      signal: controller.signal,
      done,
      exit: () => {
        if (!group.delete(entry)) return;
        if (group.size === 0) this.entries.delete(key);
        complete();
      },
    });
    const entry: Entry = {
      owner: Object.freeze({
        tenantId: owner.tenantId,
        ownerProjectId: owner.ownerProjectId,
        ownerUserId: owner.ownerUserId,
      }),
      controller,
      lease,
    };
    group.add(entry);
    this.entries.set(key, group);
    return { ok: true, lease };
  }

  fence(key: VaultKey): void {
    this.fences.add(key);
  }
  releaseFence(key: VaultKey): void {
    this.fences.delete(key);
  }

  shutdown(timeoutMs: number | null): Promise<VaultShutdownResult> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (
      timeoutMs !== null &&
      (!Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 0 ||
        timeoutMs > 2147483647)
    )
      throw new RangeError("INVALID_DRAIN_TIMEOUT");
    this.sealed = true;
    const entries = [...this.entries.values()].flatMap((group) => [...group]);
    let settle!: (result: VaultShutdownResult) => void;
    this.shutdownPromise = new Promise((resolve) => {
      settle = resolve;
    });
    // Publish the shared promise before abort callbacks can re-enter shutdown.
    for (const entry of entries) entry.controller.abort();
    if (entries.length === 0) settle("DRAINED");
    else if (timeoutMs === null) settle("UNCONFIGURED");
    else {
      const timer = setTimeout(() => settle("TIMEOUT"), timeoutMs);
      timer.unref();
      void Promise.all(entries.map((entry) => entry.lease.done)).then(() => {
        clearTimeout(timer);
        settle("DRAINED");
      });
    }
    return this.shutdownPromise;
  }

  async abortAndDrain(
    key: VaultKey,
    timeoutMs: number,
  ): Promise<VaultDrainResult> {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 0 ||
      timeoutMs > 2147483647
    )
      throw new RangeError("INVALID_DRAIN_TIMEOUT");
    const entries = [...(this.entries.get(key) ?? [])];
    for (const entry of entries) entry.controller.abort();
    if (entries.length === 0) return "DRAINED";
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.all(entries.map((entry) => entry.lease.done)).then(
          (): VaultDrainResult => "DRAINED",
        ),
        new Promise<VaultDrainResult>((resolve) => {
          timer = setTimeout(() => resolve("TIMEOUT"), timeoutMs);
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  snapshotUploads(): readonly VaultLiveUpload[] {
    const result: VaultLiveUpload[] = [];
    for (const [key, entries] of this.entries) {
      if (!key.startsWith("R:")) continue;
      const first = entries.values().next().value as Entry | undefined;
      if (first)
        result.push(
          Object.freeze({
            refId: key.slice(2),
            tenantId: first.owner.tenantId,
            ownerProjectId: first.owner.ownerProjectId,
            ownerUserId: first.owner.ownerUserId,
          }),
        );
    }
    return Object.freeze(result);
  }
}
