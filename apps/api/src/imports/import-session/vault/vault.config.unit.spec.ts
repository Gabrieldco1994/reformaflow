import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * B2a slice 1b RED: the SYNTACTIC vault configuration.
 *
 * `parseVaultConfig(env)` is pure and synchronous: it interprets the vault keys of the env object it is
 * handed and nothing else. `configured: true` means "the syntax is complete", NEVER `VaultState.ON`:
 * lock ownership (flock/fdinfo), the private root (realpath, owner/modes, outside UPLOADS_DIR,
 * symlinks), fsync and headroom are physical checks made later by a separate module, on Linux.
 *
 * The module does not exist yet. The function is loaded lazily and asserted, so the RED is an
 * assertion about a missing function and not a compile or import error; the local shape types keep
 * the file independent of the missing module.
 */
type VaultConfigReason =
  | "FLAG_OFF"
  | "NO_LOCK_FD"
  | "BAD_ROOT"
  | "IDLE_TIMEOUT_UNSET"
  | "HEADROOM_UNSET";
type Verdict =
  | { configured: false; reason: VaultConfigReason }
  | {
      configured: true;
      rootDir: string;
      lockFd: number;
      idleTimeoutMs: number;
      headroomBytes: number;
      drainTimeoutMs?: number;
    };
type Parse = (env: NodeJS.ProcessEnv) => Verdict;

function load(): Parse {
  let loaded: { parseVaultConfig?: unknown } = {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loaded = require("./vault.config");
  } catch (error) {
    // Only the module under test may be "absent"; a missing transitive dependency is a real error.
    const missingSelf =
      (error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND" &&
      /^Cannot find module '\.\/vault\.config'/.test((error as Error).message);
    if (!missingSelf) throw error;
  }
  expect(typeof loaded.parseVaultConfig).toBe("function");
  return loaded.parseVaultConfig as Parse;
}

const KEYS = {
  flag: "IMPORT_VAULT_ENABLED",
  fd: "IMPORT_VAULT_LOCK_FD",
  root: "VAULT_DIR",
  idle: "IMPORT_VAULT_IDLE_TIMEOUT_MS",
  headroom: "IMPORT_VAULT_HEADROOM_BYTES",
  drain: "IMPORT_VAULT_DRAIN_TIMEOUT_MS",
} as const;
const withRuntimeComposition = existsSync(join(__dirname, "vault-state.ts"));
const ALL_KEYS = (
  withRuntimeComposition
    ? Object.values(KEYS)
    : [KEYS.flag, KEYS.fd, KEYS.root, KEYS.idle, KEYS.headroom]
).sort();

const VALID: Record<string, string> = {
  [KEYS.flag]: "true",
  [KEYS.fd]: "7",
  [KEYS.root]: "/srv/import-vault",
  [KEYS.idle]: "30000",
  [KEYS.headroom]: "268435456",
  [KEYS.drain]: "73",
};
const env = (overrides: Record<string, string | undefined> = {}) => {
  const out: NodeJS.ProcessEnv = { ...VALID };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out;
};
const off = (reason: VaultConfigReason): Verdict => ({
  configured: false,
  reason,
});
const ON: Verdict = {
  configured: true,
  rootDir: "/srv/import-vault",
  lockFd: 7,
  idleTimeoutMs: 30000,
  headroomBytes: 268435456,
  ...(withRuntimeComposition ? { drainTimeoutMs: 73 } : {}),
};
/** An env that records every key read from it. */
function spied(base: NodeJS.ProcessEnv): {
  env: NodeJS.ProcessEnv;
  reads: string[];
} {
  const reads: string[] = [];
  const proxy = new Proxy(base, {
    get(target, key, receiver) {
      if (typeof key === "string") reads.push(key);
      return Reflect.get(target, key, receiver);
    },
    has(target, key) {
      if (typeof key === "string") reads.push(key);
      return Reflect.has(target, key);
    },
  });
  return { env: proxy, reads };
}

// Canonical positive decimal integers that are safe JS integers; everything else is rejected.
const NOT_A_POSITIVE_SAFE_INTEGER: [string, string | undefined][] = [
  ["absent", undefined],
  ["empty", ""],
  ["whitespace", " "],
  ["zero", "0"],
  ["negative", "-5"],
  ["explicit plus", "+5"],
  ["exponent", "1e3"],
  ["float", "1.5"],
  ["integral float", "10.0"],
  ["hex", "0x10"],
  ["binary", "0b11"],
  ["suffix", "10ms"],
  ["trailing space", "10 "],
  ["leading space", " 10"],
  ["trailing newline", "10\n"],
  ["thousands separator", "1,000"],
  ["underscore", "1_000"],
  ["non-ASCII digits", "١٠"],
  ["NaN", "NaN"],
  ["Infinity", "Infinity"],
  ["2^53 (first unsafe integer)", "9007199254740992"],
  ["overflow", "99999999999999999999999"],
];

describe("B2a slice 1b — parseVaultConfig (syntax only, never VaultState.ON)", () => {
  it("is exported by vault/vault.config.ts as a function", () => {
    expect(typeof load()).toBe("function");
  });

  describe("the configured shape", () => {
    it("a complete env has the exact baseline shape, or the explicit drain binding with the full runtime composition", () => {
      const verdict = load()(env());
      expect(verdict).toStrictEqual(ON);
      const fields = [
        "configured",
        "headroomBytes",
        "idleTimeoutMs",
        "lockFd",
        "rootDir",
      ];
      if (withRuntimeComposition) fields.push("drainTimeoutMs");
      expect(Object.keys(verdict).sort()).toEqual(fields.sort());
    });

    it("a refusal is exactly { configured:false, reason }: no enabled, no nullable fields", () => {
      const verdict = load()(env({ [KEYS.fd]: undefined }));
      expect(verdict).toStrictEqual(off("NO_LOCK_FD"));
      expect(Object.keys(verdict).sort()).toEqual(["configured", "reason"]);
    });

    it("is synchronous", () => {
      expect(load()(env())).not.toHaveProperty("then");
    });

    it("the largest safe integers are accepted for idle and headroom", () => {
      expect(
        load()(
          env({
            [KEYS.idle]: "9007199254740991",
            [KEYS.headroom]: "9007199254740991",
          }),
        ),
      ).toStrictEqual({
        ...ON,
        idleTimeoutMs: Number.MAX_SAFE_INTEGER,
        headroomBytes: Number.MAX_SAFE_INTEGER,
      });
    });

    it("the smallest accepted values are 3 for the lock fd and 1 for idle and headroom", () => {
      expect(
        load()(env({ [KEYS.fd]: "3", [KEYS.idle]: "1", [KEYS.headroom]: "1" })),
      ).toStrictEqual({ ...ON, lockFd: 3, idleTimeoutMs: 1, headroomBytes: 1 });
    });
  });

  describe("leading zeros are plain decimal digits (never octal); the minimums still apply", () => {
    it("accepts 007, 0003, 010 and friends as 7, 3 and 10", () => {
      expect(
        load()(
          env({
            [KEYS.fd]: "007",
            [KEYS.idle]: "0250",
            [KEYS.headroom]: "0001",
          }),
        ),
      ).toStrictEqual({
        ...ON,
        lockFd: 7,
        idleTimeoutMs: 250,
        headroomBytes: 1,
      });
      expect(load()(env({ [KEYS.fd]: "0003" }))).toStrictEqual({
        ...ON,
        lockFd: 3,
      });
      expect(
        load()(
          env({ [KEYS.fd]: "010", [KEYS.idle]: "010", [KEYS.headroom]: "010" }),
        ),
      ).toStrictEqual({
        ...ON,
        lockFd: 10,
        idleTimeoutMs: 10,
        headroomBytes: 10,
      });
    });

    it.each([
      ["fd 000", KEYS.fd, "000", "NO_LOCK_FD"],
      ["fd 002 (below 3)", KEYS.fd, "002", "NO_LOCK_FD"],
      ["idle 000", KEYS.idle, "000", "IDLE_TIMEOUT_UNSET"],
      ["headroom 00", KEYS.headroom, "00", "HEADROOM_UNSET"],
    ])("%s stays invalid", (_n, key, raw, reason) => {
      expect(load()(env({ [key]: raw }))).toStrictEqual(
        off(reason as VaultConfigReason),
      );
    });

    it("leading zeros do not defeat the safe-integer bound", () => {
      expect(
        load()(env({ [KEYS.idle]: "00009007199254740992" })),
      ).toStrictEqual(off("IDLE_TIMEOUT_UNSET"));
      expect(
        load()(env({ [KEYS.idle]: "00009007199254740991" })),
      ).toStrictEqual({ ...ON, idleTimeoutMs: Number.MAX_SAFE_INTEGER });
    });
  });

  describe("the flag: only the literal 'true' turns configuration on", () => {
    it.each([
      ["absent", undefined],
      ["empty", ""],
      ["false", "false"],
      ["1", "1"],
      ["0", "0"],
      ["yes", "yes"],
      ["on", "on"],
      ["TRUE", "TRUE"],
      ["True", "True"],
      ["leading space", " true"],
      ["trailing space", "true "],
      ["trailing newline", "true\n"],
      ["quoted", '"true"'],
    ])("flag %s => FLAG_OFF even with every other key valid", (_n, value) => {
      expect(load()(env({ [KEYS.flag]: value }))).toStrictEqual(
        off("FLAG_OFF"),
      );
    });

    it("FLAG_OFF wins over every other error and the other keys are not even read", () => {
      const { env: probe, reads } = spied({
        [KEYS.flag]: "false",
        [KEYS.fd]: "garbage",
        [KEYS.root]: "relative",
      });
      expect(load()(probe)).toStrictEqual(off("FLAG_OFF"));
      expect(reads).toEqual([KEYS.flag]);
    });

    it("an empty env is FLAG_OFF", () => {
      expect(load()({})).toStrictEqual(off("FLAG_OFF"));
    });
  });

  describe("syntactic precedence: FLAG_OFF -> NO_LOCK_FD -> BAD_ROOT -> IDLE_TIMEOUT_UNSET -> HEADROOM_UNSET", () => {
    const BAD = "not-valid";
    it.each<[string, Record<string, string | undefined>, VaultConfigReason]>([
      [
        "everything invalid",
        {
          [KEYS.fd]: BAD,
          [KEYS.root]: BAD,
          [KEYS.idle]: BAD,
          [KEYS.headroom]: BAD,
        },
        "NO_LOCK_FD",
      ],
      [
        "fd and root invalid",
        { [KEYS.fd]: BAD, [KEYS.root]: BAD },
        "NO_LOCK_FD",
      ],
      [
        "fd and headroom invalid",
        { [KEYS.fd]: BAD, [KEYS.headroom]: undefined },
        "NO_LOCK_FD",
      ],
      [
        "root, idle and headroom invalid",
        { [KEYS.root]: BAD, [KEYS.idle]: BAD, [KEYS.headroom]: BAD },
        "BAD_ROOT",
      ],
      [
        "root and idle invalid",
        { [KEYS.root]: undefined, [KEYS.idle]: undefined },
        "BAD_ROOT",
      ],
      [
        "idle and headroom invalid",
        { [KEYS.idle]: BAD, [KEYS.headroom]: BAD },
        "IDLE_TIMEOUT_UNSET",
      ],
      [
        "idle absent and headroom absent",
        { [KEYS.idle]: undefined, [KEYS.headroom]: undefined },
        "IDLE_TIMEOUT_UNSET",
      ],
      ["only headroom invalid", { [KEYS.headroom]: BAD }, "HEADROOM_UNSET"],
    ])("%s => %s", (_name, overrides, reason) => {
      expect(load()(env(overrides))).toStrictEqual(off(reason));
    });

    it("the reasons are only the syntactic subset: never a physical VaultReason", () => {
      const seen = new Set<string>();
      const parse = load();
      for (const overrides of [
        { [KEYS.flag]: "no" },
        { [KEYS.fd]: undefined },
        { [KEYS.root]: undefined },
        { [KEYS.idle]: undefined },
        { [KEYS.headroom]: undefined },
      ]) {
        const verdict = parse(env(overrides));
        if (!verdict.configured) seen.add(verdict.reason);
      }
      expect([...seen].sort()).toEqual([
        "BAD_ROOT",
        "FLAG_OFF",
        "HEADROOM_UNSET",
        "IDLE_TIMEOUT_UNSET",
        "NO_LOCK_FD",
      ]);
    });
  });

  describe("the lock fd: a decimal safe integer >= 3", () => {
    it.each(["3", "4", "7", "1023"])("%s is accepted as that number", (raw) => {
      const verdict = load()(env({ [KEYS.fd]: raw }));
      expect(verdict).toStrictEqual({ ...ON, lockFd: Number(raw) });
    });

    it.each([
      ...NOT_A_POSITIVE_SAFE_INTEGER,
      ["stdin", "0"],
      ["stdout", "1"],
      ["stderr", "2"],
    ] as [string, string | undefined][])("%s (%j) => NO_LOCK_FD", (_n, raw) => {
      expect(load()(env({ [KEYS.fd]: raw }))).toStrictEqual(off("NO_LOCK_FD"));
    });
  });

  describe("idle timeout and headroom: positive decimal safe integers, no default", () => {
    it.each([
      ["idle", KEYS.idle, "IDLE_TIMEOUT_UNSET"],
      ["headroom", KEYS.headroom, "HEADROOM_UNSET"],
    ] as [string, string, VaultConfigReason][])(
      "%s rejects every non-positive-safe-integer spelling",
      (_name, key, reason) => {
        for (const [label, raw] of NOT_A_POSITIVE_SAFE_INTEGER) {
          expect([label, load()(env({ [key]: raw }))]).toEqual([
            label,
            off(reason),
          ]);
        }
      },
    );

    it.each([
      ["idle", KEYS.idle, "idleTimeoutMs"],
      ["headroom", KEYS.headroom, "headroomBytes"],
    ])(
      "%s accepts plain decimals and returns them as numbers",
      (_n, key, field) => {
        for (const raw of ["1", "250", "30000", "4294967296"]) {
          expect(load()(env({ [key]: raw }))).toStrictEqual({
            ...ON,
            [field]: Number(raw),
          });
        }
      },
    );
  });

  describe("the root: syntax only, the path is preserved verbatim (the physical check is elsewhere)", () => {
    it.each([
      ["absent", undefined],
      ["empty", ""],
      ["whitespace", "   "],
      ["relative", "vault"],
      ["dot-relative", "./vault"],
      ["parent-relative", "../vault"],
      ["home shorthand", "~/vault"],
      ["leading space", " /srv/vault"],
      ["NUL byte", "/srv/va\0ult"],
    ] as [string, string | undefined][])("%s => BAD_ROOT", (_n, raw) => {
      expect(load()(env({ [KEYS.root]: raw }))).toStrictEqual(off("BAD_ROOT"));
    });

    it.each([
      "/srv/import-vault",
      "/srv/import-vault/",
      "/",
      "/a/../b",
      "/tmp/../tmp/vault",
      "/srv//double//slash",
      "/srv/with space/vault",
    ])("the absolute path %j is returned unchanged, not normalised", (path) => {
      expect(load()(env({ [KEYS.root]: path }))).toStrictEqual({
        ...ON,
        rootDir: path,
      });
    });

    it("no filesystem is consulted: a root that exists nowhere, or lives inside UPLOADS_DIR, is still syntactically configured", () => {
      const missing = `/definitely/not/there/${"x".repeat(12)}`;
      expect(load()(env({ [KEYS.root]: missing }))).toStrictEqual({
        ...ON,
        rootDir: missing,
      });
      // UPLOADS_DIR is not an input of the parser: keeping the vault outside it is the physical gate.
      expect(
        load()(
          env({
            [KEYS.root]: "/srv/uploads/vault",
            UPLOADS_DIR: "/srv/uploads",
          }),
        ),
      ).toStrictEqual({ ...ON, rootDir: "/srv/uploads/vault" });
    });
  });

  describe("purity and isolation", () => {
    it("reads only the baseline keys or the explicit future drain key, never the write switch or UPLOADS_DIR", () => {
      const { env: probe, reads } = spied({
        ...VALID,
        IMPORT_SESSION_WRITES_ENABLED: "true",
        UPLOADS_DIR: "/srv/uploads",
      });
      load()(probe);
      expect([...new Set(reads)].sort()).toEqual(ALL_KEYS);
    });

    it("IMPORT_SESSION_WRITES_ENABLED has no effect on the verdict", () => {
      const parse = load();
      expect(
        parse(env({ IMPORT_SESSION_WRITES_ENABLED: "true" })),
      ).toStrictEqual(ON);
      expect(
        parse(
          env({ IMPORT_SESSION_WRITES_ENABLED: "true", [KEYS.flag]: "no" }),
        ),
      ).toStrictEqual(off("FLAG_OFF"));
    });

    it("mutates nothing: a frozen env is accepted and the process environment is unchanged", () => {
      const before = JSON.stringify(process.env);
      const frozen = Object.freeze({ ...VALID }) as NodeJS.ProcessEnv;
      expect(load()(frozen)).toStrictEqual(ON);
      expect(JSON.stringify(process.env)).toBe(before);
    });

    it("is deterministic: the same env gives an equal verdict", () => {
      const parse = load();
      expect(parse(env())).toStrictEqual(parse(env()));
      expect(parse(env({ [KEYS.idle]: "x" }))).toStrictEqual(
        parse(env({ [KEYS.idle]: "x" })),
      );
    });
  });
});

/** Static half: what the module may and may not be, checked on the sources of the intake tree. */
describe("B2a slice 1b — vault.config.ts as a module (static)", () => {
  const srcRoot = join(__dirname, "../../..");
  const productionFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory())
        return entry.name === "test-utils" ? [] : productionFiles(full);
      return /\.ts$/.test(entry.name) && !/\.(spec|test)\.ts$/.test(entry.name)
        ? [full]
        : [];
    });
  const rel = (file: string) => relative(srcRoot, file);
  const configPath = join(__dirname, "vault.config.ts");

  it("vault/vault.config.ts exists", () => {
    expect(existsSync(configPath)).toBe(true);
  });

  it("only vault.config.ts interprets the IMPORT_VAULT_* keys and VAULT_DIR in production code", () => {
    const configMention = (file: string, text: string): boolean => {
      const gateConsumer = [
        "imports/import-session/import-session.module.ts",
        "imports/import-session/vault/vault-state.ts",
        "imports/import-session/vault/import-upload.service.ts",
        "imports/import-session/vault/import-content.service.ts",
        "imports/import-session/vault/vault-reaper.ts",
      ].includes(file);
      return (
        gateConsumer
          ? /\bIMPORT_VAULT_(?!GATE\b)[A-Z_]+|\bVAULT_DIR\b/
          : /\bIMPORT_VAULT_[A-Z_]+|\bVAULT_DIR\b/
      ).test(text);
    };
    expect(
      configMention(
        "imports/import-session/vault/vault-state.ts",
        'export const IMPORT_VAULT_GATE = Symbol("IMPORT_VAULT_GATE");',
      ),
    ).toBe(false);
    for (const name of [
      "IMPORT_VAULT_DRAIN_TIMEOUT_MS",
      "IMPORT_VAULT_GATE_TIMEOUT_MS",
      "IMPORT_VAULT_GATEWAY",
      "VAULT_DIR",
    ])
      expect(
        configMention("imports/import-session/vault/vault-state.ts", name),
      ).toBe(true);
    for (const file of [
      "other.ts",
      "imports/import-session/vault/import-attachment.controller.ts",
      "imports/import-session/vault/other/vault-state.ts",
    ])
      expect(configMention(file, "IMPORT_VAULT_GATE")).toBe(true);
    const readers = productionFiles(srcRoot)
      .filter((file) => configMention(rel(file), readFileSync(file, "utf8")))
      .map(rel);
    expect(readers).toEqual(["imports/import-session/vault/vault.config.ts"]);
  });

  it("vault.config.ts takes its env as an argument: no process.env, no ConfigService, no fs, no new framework", () => {
    expect(existsSync(configPath)).toBe(true);
    const text = readFileSync(configPath, "utf8");
    for (const forbidden of [
      /\bprocess\.env\b/,
      /\bprocess\b\s*\[/,
      /\bConfigService\b/,
      /\bConfigModule\b/,
      /@nestjs\/config/,
      /from ["'](node:)?fs(\/promises)?["']/,
      /from ["'](node:)?(child_process|net|http|https)["']/,
      /\brequire\(/,
      /IMPORT_SESSION_WRITES_ENABLED/,
    ]) {
      expect([String(forbidden), forbidden.test(text)]).toEqual([
        String(forbidden),
        false,
      ]);
    }
  });

  it("control: no configuration framework dependency is added to the API for this", () => {
    const manifest = JSON.parse(
      readFileSync(join(srcRoot, "../package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain(
      "@nestjs/config",
    );
  });
});
