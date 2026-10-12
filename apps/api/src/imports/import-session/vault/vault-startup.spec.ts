import { parseVaultConfig } from "./vault.config";
import { headroomSatisfied } from "./vault-root";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { decodeLinuxDev } from "./vault-lock";
import { prepareVaultStartup, parseStartupMounts } from "./vault-startup";

const explicitOn: NodeJS.ProcessEnv = {
  IMPORT_VAULT_ENABLED: "true",
  VAULT_DIR: "/data/import-vault",
  IMPORT_VAULT_LOCK_FD: "9",
  IMPORT_VAULT_IDLE_TIMEOUT_MS: "1",
  IMPORT_VAULT_HEADROOM_BYTES: "1",
  IMPORT_VAULT_DRAIN_TIMEOUT_MS: "0",
};

describe("canonical startup boundaries (no QA/production defaults)", () => {
  it.each(["IMPORT_VAULT_IDLE_TIMEOUT_MS", "IMPORT_VAULT_HEADROOM_BYTES"])(
    "%s accepts only explicit positive integers",
    (key) => {
      for (const value of [
        undefined,
        "-1",
        "0",
        "1.1",
        " 1",
        "9007199254740992",
      ]) {
        expect(
          parseVaultConfig({ ...explicitOn, [key]: value }).configured,
        ).toBe(false);
      }
      expect(parseVaultConfig({ ...explicitOn, [key]: "1" }).configured).toBe(
        true,
      );
    },
  );
  it.each([
    [undefined, false],
    ["-1", false],
    ["0", true],
    ["1", true],
    ["2147483647", true],
    ["2147483648", false],
  ])("canonical drain %s configured=%s", (value, configured) => {
    expect(
      parseVaultConfig({
        ...explicitOn,
        IMPORT_VAULT_DRAIN_TIMEOUT_MS: value as string | undefined,
      }).configured,
    ).toBe(configured);
  });

  describe("read-only layout validation and exclusive provisioning", () => {
    let temp: string;
    const originalPlatform = Object.getOwnPropertyDescriptor(
      process,
      "platform",
    )!;
    const originals = { ...fs.promises };
    const env = { ...explicitOn, UPLOADS_DIR: "/data/uploads" };
    const map = (target: fs.PathLike): fs.PathLike =>
      typeof target === "string" &&
      (target === "/data" || target.startsWith("/data/"))
        ? target.replace(/^\/data/, temp)
        : target;
    beforeEach(() => {
      temp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-layout-"));
      Object.defineProperty(process, "platform", {
        value: "linux",
        configurable: true,
      });
      const dev = decodeLinuxDev(fs.statSync(temp, { bigint: true }).dev)!;
      const mounts = `1 0 ${dev.major}:${dev.minor} / /data rw - ext4 /dev/synthetic rw\n`;
      jest
        .spyOn(fs.promises, "readFile")
        .mockImplementation(((target: fs.PathLike, ...args: unknown[]) =>
          target === "/proc/self/mountinfo"
            ? Promise.resolve(mounts)
            : (originals.readFile as Function)(
                map(target),
                ...args,
              )) as typeof fs.promises.readFile);
      for (const name of [
        "lstat",
        "mkdir",
        "open",
        "readdir",
        "realpath",
      ] as const) {
        jest
          .spyOn(fs.promises, name)
          .mockImplementation(((target: fs.PathLike, ...args: unknown[]) =>
            (originals[name] as Function)(map(target), ...args)) as never);
      }
    });
    afterEach(() => {
      jest.restoreAllMocks();
      Object.defineProperty(process, "platform", originalPlatform);
      fs.rmSync(temp, { recursive: true, force: true });
    });
    const vault = (): string => path.join(temp, "import-vault");
    const snapshot = (): string => {
      const nodes: unknown[] = [];
      const walk = (target: string): void => {
        const s = fs.lstatSync(target);
        nodes.push([
          target,
          s.mode,
          s.uid,
          s.dev,
          s.ino,
          s.nlink,
          s.isFile()
            ? fs.readFileSync(target, "hex")
            : s.isSymbolicLink()
              ? fs.readlinkSync(target)
              : null,
        ]);
        if (s.isDirectory())
          fs.readdirSync(target)
            .sort()
            .forEach((n) => walk(path.join(target, n)));
      };
      walk(temp);
      return JSON.stringify(nodes);
    };
    it("creates only missing private layout and reuses lock inode/bytes on restart", async () => {
      await prepareVaultStartup(env, temp);
      for (const node of ["", "t", "trash"]) {
        expect(fs.statSync(path.join(vault(), node)).mode & 0o7777).toBe(0o700);
      }
      expect(fs.statSync(path.join(vault(), ".lock")).mode & 0o7777).toBe(
        0o600,
      );
      fs.writeFileSync(path.join(vault(), "t", "synthetic.csv"), "synthetic", {
        mode: 0o600,
      });
      const before = snapshot();
      await prepareVaultStartup(env, temp);
      expect(snapshot()).toBe(before);
    });
    it.each(["", "t", "trash", ".lock"])(
      "rejects symlink %s without repair",
      async (node) => {
        await prepareVaultStartup(env, temp);
        const target = path.join(vault(), node);
        fs.rmSync(target, { recursive: true });
        fs.symlinkSync("missing-synthetic", target);
        const before = snapshot();
        await expect(prepareVaultStartup(env, temp)).rejects.toThrow();
        expect(snapshot()).toBe(before);
      },
    );
    it.each([
      ["t", 0o755],
      ["trash", 0o777],
      [".lock", 0o644],
      ["", 0o1700],
    ])("rejects mode %s:%s without chmod", async (node, mode) => {
      await prepareVaultStartup(env, temp);
      fs.chmodSync(path.join(vault(), node as string), mode as number);
      const before = snapshot();
      await expect(prepareVaultStartup(env, temp)).rejects.toThrow(
        "UNSAFE_LAYOUT",
      );
      expect(snapshot()).toBe(before);
    });
    it.each(["uploads", "private-uploads"])(
      "rejects descendant upload alias in %s",
      async (root) => {
        await prepareVaultStartup(env, temp);
        fs.mkdirSync(path.join(temp, root));
        fs.symlinkSync(vault(), path.join(temp, root, "alias"));
        const before = snapshot();
        await expect(prepareVaultStartup(env, temp)).rejects.toThrow(
          "UNSAFE_ALIAS",
        );
        expect(snapshot()).toBe(before);
      },
    );
    it("rejects hard-linked lock and documents without replacing any inode", async () => {
      await prepareVaultStartup(env, temp);
      fs.linkSync(path.join(vault(), ".lock"), path.join(temp, "alias"));
      const before = snapshot();
      await expect(prepareVaultStartup(env, temp)).rejects.toThrow(
        "UNSAFE_LAYOUT",
      );
      expect(snapshot()).toBe(before);
    });
    it("completes a valid partial layout without repairing existing nodes", async () => {
      fs.mkdirSync(vault(), { mode: 0o700 });
      const ino = fs.statSync(vault()).ino;
      await prepareVaultStartup(env, temp);
      expect(fs.statSync(vault()).ino).toBe(ino);
    });
    it.each(["tmpfs", "overlay"])(
      "rejects filesystem %s before mutation",
      async (type) => {
        (fs.promises.readFile as jest.Mock).mockResolvedValue(
          `1 0 0:1 / /data rw - ${type} synthetic rw\n`,
        );
        const before = snapshot();
        await expect(prepareVaultStartup(env, temp)).rejects.toThrow(
          "PERSISTENT_EXT4_REQUIRED",
        );
        expect(snapshot()).toBe(before);
      },
    );
    it("rejects malformed mount evidence", () => {
      for (const evidence of [
        "",
        "malformed\n",
        "1 0 0:1 / /data rw - ext4 synthetic rw",
      ]) {
        expect(() => parseStartupMounts(evidence)).toThrow(
          "BAD_MOUNT_EVIDENCE",
        );
      }
    });
  });
  it("headroom threshold is inclusive", () => {
    expect(
      [9n, 10n, 11n].map((available) => headroomSatisfied(available, 10)),
    ).toEqual([false, true, true]);
  });
});

describe("production startup helper", () => {
  // Delayed require lets canonical RED evidence run even before the production module exists.
  const helper = (): {
    prepareVaultStartup(env: NodeJS.ProcessEnv, cwd: string): Promise<void>;
  } => require("./vault-startup");
  let temp: string;
  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-startup-"));
  });
  afterEach(() => {
    fs.rmSync(temp, { recursive: true, force: true });
  });

  it.each([undefined, "false", "TRUE", "1", ""])(
    "OFF %s never inspects vault",
    async (flag) => {
      const sentinel = path.join(temp, "sentinel");
      fs.writeFileSync(sentinel, "synthetic");
      await helper().prepareVaultStartup(
        {
          IMPORT_VAULT_ENABLED: flag,
          VAULT_DIR: `${sentinel}/invalid`,
        },
        temp,
      );
      expect(fs.readFileSync(sentinel, "utf8")).toBe("synthetic");
      expect(fs.readdirSync(temp)).toEqual(["sentinel"]);
    },
  );

  it.each([
    { IMPORT_VAULT_LOCK_FD: "8" },
    { VAULT_DIR: "/tmp/vault" },
    { VAULT_DIR: "/data/import-vault/." },
    { IMPORT_VAULT_HEADROOM_BYTES: undefined },
    { IMPORT_VAULT_IDLE_TIMEOUT_MS: undefined },
    { IMPORT_VAULT_DRAIN_TIMEOUT_MS: undefined },
  ])(
    "rejects explicit ON configuration before filesystem mutation: %j",
    async (override) => {
      await expect(
        helper().prepareVaultStartup({ ...explicitOn, ...override }, temp),
      ).rejects.toThrow();
      expect(fs.readdirSync(temp)).toEqual([]);
    },
  );

  it("does not accept an ordinary /data directory or non-Linux fallback", async () => {
    await expect(
      helper().prepareVaultStartup(explicitOn, temp),
    ).rejects.toThrow();
    expect(fs.readdirSync(temp)).toEqual([]);
  });
});
