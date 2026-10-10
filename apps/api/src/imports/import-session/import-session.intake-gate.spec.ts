import {
  ImportSessionDocumentFormat,
  ImportSessionErrorCode,
} from "@reformaflow/domain";
import {
  DefaultImportSessionCapability,
  createImportSessionCapability,
  type ImportSessionCapability,
} from "./import-session.capability";
import {
  assertImportSessionIntakeAvailable,
  projectImportSessionEntry,
} from "./import-session.intake-gate";
import { ImportSessionError } from "./import-session.errors";
import type {
  VaultBootHandle,
  VaultLockRecheck,
  VaultRuntime,
} from "./vault/vault-boot";
import type { ImportVaultGate } from "./vault/vault-state";

const runtime = Object.freeze({
  config: Object.freeze({
    configured: true as const,
    rootDir: "/private/import-vault",
    lockFd: 7,
    idleTimeoutMs: 1,
    headroomBytes: 1,
    drainTimeoutMs: 1,
  }),
  lockIdentity: Object.freeze({ dev: 1n, ino: 2n }),
});

function vault(
  options: {
    state?: "ON" | "OFF";
    stopped?: boolean;
    runtime?: Readonly<VaultRuntime> | null;
    recheck?: VaultLockRecheck;
  } = {},
): ImportVaultGate {
  const stopped = new AbortController();
  if (options.stopped) stopped.abort();
  const boot = {
    state: () => options.state ?? "ON",
    runtime: () => (options.runtime === undefined ? runtime : options.runtime),
    stopped: stopped.signal,
    recheckLock: jest
      .fn()
      .mockResolvedValue(options.recheck ?? { ok: true, runtime }),
  } as unknown as VaultBootHandle;
  return { boot } as ImportVaultGate;
}

const capability = (
  writesEnabled: boolean,
  formats: unknown,
): ImportSessionCapability =>
  ({
    writesEnabled: () => writesEnabled,
    newImportFormats: () => formats,
  }) as ImportSessionCapability;

describe("production import intake configuration", () => {
  it.each([undefined, "off"] as const)(
    "snapshots %j as immutable OFF",
    (mode) => {
      const env: NodeJS.ProcessEnv = { IMPORT_SESSION_INTAKE_MODE: mode };
      const configured = createImportSessionCapability(env);
      env.IMPORT_SESSION_INTAKE_MODE = "csv";
      expect(configured.writesEnabled()).toBe(false);
      expect(configured.newImportFormats()).toEqual([]);
      expect(Object.isFrozen(configured.newImportFormats())).toBe(true);
    },
  );

  it("snapshots exact csv as immutable CSV-only", () => {
    const env: NodeJS.ProcessEnv = { IMPORT_SESSION_INTAKE_MODE: "csv" };
    const configured = createImportSessionCapability(env);
    env.IMPORT_SESSION_INTAKE_MODE = "off";
    expect(configured.writesEnabled()).toBe(true);
    expect(configured.newImportFormats()).toEqual([
      ImportSessionDocumentFormat.CSV,
    ]);
    expect(Object.isFrozen(configured.newImportFormats())).toBe(true);
  });

  it.each([
    "",
    " ",
    "CSV",
    " csv",
    "csv ",
    "off ",
    "true",
    "csv,off",
    "csv,CSV",
  ])("rejects malformed mode %j during construction", (mode) => {
    expect(() =>
      createImportSessionCapability({ IMPORT_SESSION_INTAKE_MODE: mode }),
    ).toThrow(TypeError);
  });

  it("ignores legacy environment values", () => {
    const configured = createImportSessionCapability({
      IMPORT_SESSION_WRITES_ENABLED: "true",
      IMPORT_SESSION_FORMATS: "CSV",
      IMPORT_SESSION_INTAKE: "csv",
    });
    expect(configured).toBeInstanceOf(DefaultImportSessionCapability);
    expect(configured.writesEnabled()).toBe(false);
    expect(configured.newImportFormats()).toEqual([]);
  });
});

describe("shared server-owned import intake gate", () => {
  it.each([
    {
      name: "writes disabled",
      capability: capability(false, ["CSV"]),
      gate: vault(),
      expected: "NOT_ENABLED",
    },
    {
      name: "boot state OFF",
      capability: capability(true, ["CSV"]),
      gate: vault({ state: "OFF" }),
      expected: "RUNTIME_UNAVAILABLE",
    },
    {
      name: "runtime null",
      capability: capability(true, ["CSV"]),
      gate: vault({ runtime: null }),
      expected: "RUNTIME_UNAVAILABLE",
    },
    {
      name: "stopped runtime",
      capability: capability(true, ["CSV"]),
      gate: vault({ stopped: true }),
      expected: "RUNTIME_UNAVAILABLE",
    },
    {
      name: "no qualified format",
      capability: capability(true, []),
      gate: vault(),
      expected: "NO_QUALIFIED_FORMAT",
    },
  ])("projects bounded reason with precedence: $name", (scenario) => {
    expect(
      projectImportSessionEntry(scenario.capability, scenario.gate),
    ).toEqual({
      kind: "UNAVAILABLE",
      version: 1,
      reason: scenario.expected,
    });
  });

  it("projects only the versioned immutable CSV positive entry", () => {
    const entry = projectImportSessionEntry(capability(true, ["CSV"]), vault());
    expect(entry).toEqual({
      kind: "CARD_INVOICE",
      version: 1,
      formats: ["CSV"],
    });
    if (entry.kind !== "CARD_INVOICE")
      throw new Error("expected positive entry");
    expect(Object.isFrozen(entry.formats)).toBe(true);
  });

  it.each([
    null,
    "CSV",
    { format: "CSV" },
    Array(1),
    ["CSV", "CSV"],
    ["PDF"],
    ["CSV", undefined],
  ])(
    "malformed producer fails before every availability predicate: %p",
    (formats) => {
      const producer = capability(false, formats);
      const gate = vault({ state: "OFF", stopped: true, runtime: null });
      expect(() => projectImportSessionEntry(producer, gate)).toThrow(
        TypeError,
      );
    },
  );

  it("rechecks the live lock and collapses every unavailable reason to the closed 503", async () => {
    const gate = vault({ recheck: { ok: false } });
    await expect(
      assertImportSessionIntakeAvailable(capability(true, ["CSV"]), gate),
    ).rejects.toEqual(
      expect.objectContaining({
        code: ImportSessionErrorCode.CAPABILITY_DISABLED,
        reason: null,
      }),
    );
    expect(gate.boot.recheckLock).toHaveBeenCalledTimes(1);
  });

  it("re-evaluates the producer after lock proof to catch revocation", async () => {
    const formats = jest
      .fn<ReturnType<ImportSessionCapability["newImportFormats"]>, []>()
      .mockReturnValueOnce(["CSV"])
      .mockReturnValueOnce([]);
    const producer: ImportSessionCapability = {
      writesEnabled: () => true,
      newImportFormats: formats,
    };
    await expect(
      assertImportSessionIntakeAvailable(producer, vault()),
    ).rejects.toBeInstanceOf(ImportSessionError);
    expect(formats).toHaveBeenCalledTimes(2);
  });
});
