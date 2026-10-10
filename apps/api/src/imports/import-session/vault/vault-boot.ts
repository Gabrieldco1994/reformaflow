import { Logger } from "@nestjs/common";
import { posix } from "node:path";
import {
  parseVaultConfig,
  type VaultConfig,
  type VaultConfigReason,
} from "./vault.config";
import {
  availableBytes,
  boundedCode,
  fsyncProbe,
  type VaultErrno,
} from "./vault-durability";
import { decideLockProof, type LockProofReason } from "./vault-lock";
import { collectLockFacts, collectRootFacts } from "./vault-probe";
import {
  canonical,
  classifyRootFacts,
  headroomSatisfied,
  type RootFacts,
  type RootStep,
} from "./vault-root";

// Fail-closed policy, not a measured SLA. SRE must validate it on the target volume before ON.
export const VAULT_BOOT_DEADLINE_MS = 5000;
export type VaultReason =
  | VaultConfigReason
  | LockProofReason
  | "FSYNC_CHECK_FAILED"
  | "HEADROOM_INSUFFICIENT"
  | "BOOT_PENDING"
  | "BOOT_TIMEOUT"
  | "BOOT_CHECK_ERROR"
  | "LOCK_REPLACED"
  | "SHUTDOWN"
  | "LOCK_CHECK_ERROR";
type VaultStep =
  | "config"
  | "boot"
  | "lock"
  | "lock-recheck"
  | "root"
  | `root.${RootStep}`
  | "fsync"
  | "fsync-close"
  | "statfs";
type DiagnosticCode = VaultErrno | "INVALID_STATFS";
export interface VaultRuntime {
  readonly config: Readonly<Extract<VaultConfig, { configured: true }>>;
  readonly lockIdentity: Readonly<{ dev: bigint; ino: bigint }>;
}
export interface VaultBootHandle {
  state(): "ON" | "OFF";
  readonly reason?: VaultReason;
  readonly step?: VaultStep;
  readonly code?: DiagnosticCode;
  readonly closeCode?: VaultErrno;
  runtime(): Readonly<VaultRuntime> | null;
  readonly settled: Promise<void>;
  readonly stopped: AbortSignal;
  readonly drainTimeoutMs: number | null;
  revoke(reason: "LOCK_REPLACED" | "SHUTDOWN"): void;
  recheckLock(): Promise<VaultLockRecheck>;
}
export type VaultLockRecheck =
  | Readonly<{ ok: true; runtime: Readonly<VaultRuntime> }>
  | Readonly<{ ok: false }>;
type Off = {
  state: "OFF";
  reason: VaultReason;
  step: VaultStep;
  code?: DiagnosticCode;
  closeCode?: VaultErrno;
};
type Outcome =
  | Off
  | {
      state: "ON";
      runtime: Readonly<VaultRuntime>;
      reason?: never;
      step?: never;
      code?: never;
      closeCode?: never;
    };

/**
 * Inactive, synchronous handle factory: no provider, route or product switch consumes it.
 * Operational setup/probe failures settle OFF, not a rejected `settled` promise. Fatal process
 * failures are outside this boundary. Timeout cannot cancel kernel I/O or guarantee pool capacity;
 * a pending close can retain one own descriptor until exit. No retry after an OFF verdict.
 */
export function startVaultBoot(
  env: NodeJS.ProcessEnv,
  roots: Pick<RootFacts["resolved"], "publicDir" | "privateDir">,
): VaultBootHandle {
  let done = false;
  let currentStep: VaultStep = "config";
  let outcome: Outcome = {
    state: "OFF",
    reason: "BOOT_PENDING",
    step: currentStep,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadlineAt = 0;
  let bootInitialized = false;
  let drainTimeoutMs: number | null = null;
  const stop = new AbortController();
  let checking: Promise<VaultLockRecheck> | undefined;
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const handle: VaultBootHandle = Object.freeze({
    state: () => outcome.state,
    get reason() {
      return outcome.reason;
    },
    get step() {
      return done ? outcome.step : currentStep;
    },
    get code() {
      return outcome.code;
    },
    get closeCode() {
      return outcome.closeCode;
    },
    runtime: () => (outcome.state === "ON" ? outcome.runtime : null),
    settled,
    stopped: stop.signal,
    get drainTimeoutMs() {
      return drainTimeoutMs;
    },
    revoke: (reason: "LOCK_REPLACED" | "SHUTDOWN") => terminate(reason, "boot"),
    recheckLock: () => recheck(),
  });
  const report = (
    step: VaultStep,
    code?: DiagnosticCode,
    closeCode?: VaultErrno,
    reason?: VaultReason,
    late = false,
  ): void => {
    new Logger("VaultBoot").error({
      event: "vault_boot",
      step,
      ...(reason !== undefined ? { reason } : {}),
      ...(code !== undefined ? { code } : {}),
      ...(closeCode !== undefined ? { closeCode } : {}),
      late,
    });
  };
  const settle = (next: Outcome): void => {
    if (done) return;
    done = true;
    outcome = next;
    if (timer !== undefined) clearTimeout(timer);
    resolveSettled();
    if (next.state === "OFF") stop.abort();
  };
  const terminate = (
    reason: VaultReason,
    step: VaultStep,
    code?: DiagnosticCode,
  ): void => {
    if (stop.signal.aborted) return;
    done = true;
    outcome = { state: "OFF", reason, step, code };
    if (timer !== undefined) clearTimeout(timer);
    resolveSettled();
    stop.abort();
    if (reason !== "SHUTDOWN") report(step, code, undefined, reason);
  };
  const recheck = (): Promise<VaultLockRecheck> => {
    if (stop.signal.aborted || outcome.state !== "ON")
      return Promise.resolve({ ok: false });
    if (checking) return checking;
    const runtime = outcome.runtime;
    let complete!: (value: VaultLockRecheck) => void;
    const pending = new Promise<VaultLockRecheck>((resolve) => {
      complete = resolve;
    });
    checking = pending;
    const stopped = () => complete({ ok: false });
    stop.signal.addEventListener("abort", stopped, { once: true });
    const current = () =>
      !stop.signal.aborted &&
      outcome.state === "ON" &&
      outcome.runtime === runtime;
    void (async () => {
      try {
        const facts = await collectLockFacts(
          runtime.config.lockFd,
          posix.join(runtime.config.rootDir, ".lock"),
          process.platform,
          () => !current(),
        );
        if (!current()) return;
        const proof = decideLockProof(facts);
        if (!proof.ok) {
          terminate(proof.reason, "lock-recheck");
          return;
        }
        if (
          facts.fd.kind !== "file" ||
          facts.fd.dev !== runtime.lockIdentity.dev ||
          facts.fd.ino !== runtime.lockIdentity.ino
        ) {
          terminate("LOCK_REPLACED", "lock-recheck");
          return;
        }
        complete({ ok: true, runtime });
      } catch (error) {
        const code = boundedCode(error);
        if (current()) terminate("LOCK_CHECK_ERROR", "lock-recheck", code);
        else report("lock-recheck", code, undefined, undefined, true);
      } finally {
        complete({ ok: false });
        stop.signal.removeEventListener("abort", stopped);
        if (checking === pending) checking = undefined;
      }
    })();
    return pending;
  };
  const fail = (
    reason: VaultReason,
    step: VaultStep,
    code?: DiagnosticCode,
    closeCode?: VaultErrno,
  ): void => {
    if (done) return;
    settle({ state: "OFF", reason, step, code, closeCode });
    if (reason !== "FLAG_OFF") report(step, code, closeCode, reason);
  };
  const isSettled = (): boolean => {
    if (!done && performance.now() >= deadlineAt)
      fail("BOOT_TIMEOUT", currentStep);
    return done;
  };
  const operationalError = (error: unknown): void => {
    if (bootInitialized) isSettled();
    const code = boundedCode(error);
    if (done) report(currentStep, code, undefined, undefined, true);
    else fail("BOOT_CHECK_ERROR", currentStep, code);
  };

  try {
    if (typeof env !== "object" || env === null) {
      fail("BOOT_CHECK_ERROR", "config", "UNKNOWN");
      return handle;
    }
    const config = parseVaultConfig(env);
    if (!config.configured) {
      fail(config.reason, "config");
      return handle;
    }
    drainTimeoutMs = config.drainTimeoutMs;
    const V = canonical(config.rootDir);
    if (V === null) {
      fail("BAD_ROOT", "config");
      return handle;
    }
    currentStep = "boot";
    const platform = process.platform;
    const euid = process.geteuid?.() ?? null;
    deadlineAt = performance.now() + VAULT_BOOT_DEADLINE_MS;
    timer = setTimeout(
      () => fail("BOOT_TIMEOUT", currentStep),
      VAULT_BOOT_DEADLINE_MS,
    );
    timer.unref();
    bootInitialized = true;
    const run = async (): Promise<void> => {
      try {
        if (isSettled()) return;
        currentStep = "lock";
        const lock = await collectLockFacts(
          config.lockFd,
          posix.join(V, ".lock"),
          platform,
          isSettled,
        );
        if (isSettled()) return;
        const proof = decideLockProof(lock);
        if (!proof.ok) return fail(proof.reason, "lock");
        const identity = lock.fd;
        if (identity.kind !== "file") return fail("FD_NOT_LOCKFILE", "lock");
        currentStep = "root";
        const facts = await collectRootFacts(V, roots, euid, isSettled);
        if (isSettled()) return;
        const root = classifyRootFacts(facts);
        if (!root.ok) return fail("BAD_ROOT", `root.${root.step}`);
        const t = posix.join(V, "t");
        currentStep = "fsync";
        const sync = await fsyncProbe(t, isSettled, (error) => {
          report("fsync-close", boundedCode(error), undefined, undefined, done);
        });
        const syncSettled = isSettled();
        if (!sync.ok && sync.outcome === "FS_ERROR") {
          const code = boundedCode(sync);
          const closeCode =
            sync.closeCode === undefined
              ? undefined
              : boundedCode({ code: sync.closeCode });
          if (syncSettled) report("fsync", code, closeCode, undefined, true);
          else fail("FSYNC_CHECK_FAILED", "fsync", code, closeCode);
          return;
        }
        if (syncSettled) return;
        if (!sync.ok) return fail("FSYNC_CHECK_FAILED", "fsync");
        currentStep = "statfs";
        const space = await availableBytes(t, isSettled);
        const spaceSettled = isSettled();
        if (!space.ok && space.outcome !== "SETTLED") {
          const code =
            space.outcome === "INVALID_STATFS"
              ? "INVALID_STATFS"
              : boundedCode(space);
          if (spaceSettled) report("statfs", code, undefined, undefined, true);
          else fail("BOOT_CHECK_ERROR", "statfs", code);
          return;
        }
        if (spaceSettled) return;
        if (!space.ok) return fail("BOOT_CHECK_ERROR", "statfs");
        if (!headroomSatisfied(space.available, config.headroomBytes))
          return fail("HEADROOM_INSUFFICIENT", "statfs");
        if (isSettled()) return;
        settle({
          state: "ON",
          runtime: Object.freeze({
            config: Object.freeze({ ...config, rootDir: V }),
            lockIdentity: Object.freeze({
              dev: identity.dev,
              ino: identity.ino,
            }),
          }),
        });
      } catch (error) {
        operationalError(error);
      }
    };
    void run();
  } catch (error) {
    operationalError(error);
  }
  return handle;
}
