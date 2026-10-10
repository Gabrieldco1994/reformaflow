import { promises as fs, constants, type BigIntStats } from "node:fs";
import { posix } from "node:path";
import { resolveUploadsRoots } from "../../../common/uploads-roots";
import { parseVaultConfig, type VaultConfig } from "./vault.config";
import { canonical, classifyRootFacts } from "./vault-root";
import { collectRootFacts } from "./vault-probe";
import { decodeLinuxDev } from "./vault-lock";
import { startVaultBoot } from "./vault-boot";

export const PRODUCTION_VAULT_ROOT = "/data/import-vault";
export const PRODUCTION_VAULT_FD = 9;
const DATA_MOUNT = "/data";
const DIR_MODE = 0o700;
const LOCK_MODE = 0o600;
const PERMISSIONS = 0o7777;
const LOCK_NAME = ".lock";
const LAYOUT_DIRS = ["t", "trash"] as const;
type OnConfig = Extract<VaultConfig, { configured: true }>;

export class VaultStartupError extends Error {
  constructor(readonly token: string) {
    super(token);
    this.name = "VaultStartupError";
  }
}

function reject(token: string): never {
  throw new VaultStartupError(token);
}

function configuration(env: NodeJS.ProcessEnv): OnConfig | null {
  const config = parseVaultConfig({
    ...env,
    IMPORT_VAULT_LOCK_FD:
      env.IMPORT_VAULT_LOCK_FD ?? String(PRODUCTION_VAULT_FD),
  });
  if (!config.configured) {
    if (config.reason === "FLAG_OFF") return null;
    reject(config.reason);
  }
  if (config.lockFd !== PRODUCTION_VAULT_FD) reject("BAD_STARTUP_FD");
  if (config.rootDir !== PRODUCTION_VAULT_ROOT) reject("BAD_STARTUP_ROOT");
  return config;
}

function within(target: string, ancestor: string): boolean {
  return target === ancestor || target.startsWith(`${ancestor}/`);
}

function errno(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

async function existing(target: string): Promise<BigIntStats | null> {
  try {
    return await fs.lstat(target, { bigint: true });
  } catch (error) {
    if (errno(error) === "ENOENT") return null;
    throw error;
  }
}

async function noSymlinkComponents(target: string): Promise<void> {
  if (canonical(target) !== target) reject("NONCANONICAL_UPLOAD_ROOT");
  let prefix = "/";
  for (const part of target.split("/").filter(Boolean)) {
    prefix = posix.join(prefix, part);
    const stats = await existing(prefix);
    if (!stats) return;
    if (!stats.isDirectory()) reject("UNSAFE_ANCESTOR");
  }
}

type Mount = { point: string; device: string; type: string; writable: boolean };
/** Strict mountinfo reader; unknown/malformed evidence cannot authorize persistent storage. */
export function parseStartupMounts(text: string): readonly Mount[] {
  const unescape = (value: string): string => {
    const decoded = value.replace(/\\(040|011|012|134)/g, (_, octal: string) =>
      String.fromCharCode(parseInt(octal, 8)),
    );
    if (decoded.includes("\\") || decoded.includes("\0"))
      reject("BAD_MOUNT_EVIDENCE");
    return decoded;
  };
  if (!text.endsWith("\n")) reject("BAD_MOUNT_EVIDENCE");
  return text
    .trimEnd()
    .split("\n")
    .map((line) => {
      const fields = line.split(" ");
      const separator = fields.indexOf("-");
      if (
        separator < 6 ||
        fields.length !== separator + 4 ||
        !/^\d+$/.test(fields[0]) ||
        !/^\d+$/.test(fields[1]) ||
        !/^\d+:\d+$/.test(fields[2]) ||
        !fields[3].startsWith("/")
      )
        reject("BAD_MOUNT_EVIDENCE");
      const point = unescape(fields[4]);
      if (canonical(point) !== point) reject("BAD_MOUNT_EVIDENCE");
      return {
        point,
        device: fields[2],
        type: fields[separator + 1],
        writable:
          fields[5].split(",").includes("rw") &&
          fields[separator + 3].split(",").includes("rw"),
      };
    });
}

function identity(stats: BigIntStats): string {
  return `${stats.dev}:${stats.ino}`;
}

async function walk(
  target: string,
  visit: (stats: BigIntStats) => void,
): Promise<void> {
  const stats = await existing(target);
  if (!stats) return;
  if (stats.isSymbolicLink()) reject("UNSAFE_ALIAS");
  visit(stats);
  if (stats.isDirectory()) {
    for (const name of await fs.readdir(target)) {
      await walk(posix.join(target, name), visit);
    }
  }
}

/**
 * Read-only preflight, repeated after creation, flock and in the actual API.
 * No chmod/repair. Assumes no hostile same-EUID/privileged path mutation; Node path APIs
 * do not provide an openat boundary. SRE must quiesce mount/alias changes while ON.
 */
async function inspect(
  config: OnConfig,
  env: NodeJS.ProcessEnv,
  cwd: string,
  complete: boolean,
): Promise<void> {
  if (process.platform !== "linux" || !process.geteuid)
    reject("LINUX_REQUIRED");
  const roots = resolveUploadsRoots(env, cwd);
  await noSymlinkComponents(DATA_MOUNT);
  for (const root of [roots.publicDir, roots.privateDir]) {
    if (within(root, config.rootDir) || within(config.rootDir, root))
      reject("UPLOAD_ROOT_OVERLAP");
    await noSymlinkComponents(root);
  }
  const mounts = parseStartupMounts(
    await fs.readFile("/proc/self/mountinfo", "utf8"),
  );
  const dataMounts = mounts.filter((mount) => mount.point === DATA_MOUNT);
  if (
    dataMounts.length !== 1 ||
    dataMounts[0].type !== "ext4" ||
    !dataMounts[0].writable
  )
    reject("PERSISTENT_EXT4_REQUIRED");
  for (const mount of mounts) {
    if (
      within(mount.point, config.rootDir) ||
      [roots.publicDir, roots.privateDir].some((root) =>
        within(mount.point, root),
      )
    )
      reject("NESTED_MOUNT");
  }
  const data = await fs.lstat(DATA_MOUNT, { bigint: true });
  const device = decodeLinuxDev(data.dev);
  if (!device || `${device.major}:${device.minor}` !== dataMounts[0].device)
    reject("MOUNT_DEVICE_MISMATCH");
  const euid = BigInt(process.geteuid());
  const expected = [
    [config.rootDir, true, DIR_MODE],
    ...LAYOUT_DIRS.map(
      (name) => [posix.join(config.rootDir, name), true, DIR_MODE] as const,
    ),
    [posix.join(config.rootDir, LOCK_NAME), false, LOCK_MODE],
  ] as const;
  for (const [target, directory, mode] of expected) {
    const stats = await existing(target);
    if (!stats) {
      if (complete) reject("LAYOUT_INCOMPLETE");
      continue;
    }
    if (
      stats.uid !== euid ||
      stats.dev !== data.dev ||
      Number(stats.mode & BigInt(PERMISSIONS)) !== mode ||
      (directory ? !stats.isDirectory() : !stats.isFile() || stats.nlink !== 1n)
    )
      reject("UNSAFE_LAYOUT");
  }
  const vaultIdentities = new Set([identity(data)]);
  await walk(config.rootDir, (stats) => {
    if (
      stats.dev !== data.dev ||
      (!stats.isDirectory() && !stats.isFile()) ||
      (stats.isFile() && stats.nlink !== 1n)
    )
      reject("UNSAFE_ALIAS");
    vaultIdentities.add(identity(stats));
  });
  for (const root of [roots.publicDir, roots.privateDir]) {
    await walk(root, (stats) => {
      if (vaultIdentities.has(identity(stats))) reject("UNSAFE_ALIAS");
    });
  }
  if (complete) {
    const verdict = classifyRootFacts(
      await collectRootFacts(config.rootDir, roots, Number(euid), () => false),
    );
    if (!verdict.ok) reject("UNSAFE_LAYOUT");
  }
}

export async function prepareVaultStartup(
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<void> {
  const config = configuration(env);
  if (!config) return; // OFF: no filesystem/proc reads, opens or provisioning.
  await inspect(config, env, cwd, false);
  const previousUmask = process.umask(0o077);
  try {
    for (const target of [
      config.rootDir,
      ...LAYOUT_DIRS.map((name) => posix.join(config.rootDir, name)),
    ]) {
      try {
        await fs.mkdir(target, { mode: DIR_MODE });
      } catch (error) {
        if (errno(error) !== "EEXIST") throw error;
      }
    }
    try {
      const lock = await fs.open(
        posix.join(config.rootDir, LOCK_NAME),
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        LOCK_MODE,
      );
      await lock.close();
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;
    }
  } finally {
    process.umask(previousUmask);
  }
  await inspect(config, env, cwd, true);
}

export async function verifyVaultStartup(
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<void> {
  const config = configuration(env);
  if (!config) return;
  await inspect(config, env, cwd, true);
}

async function cli(): Promise<void> {
  const env = process.env;
  const config = configuration(env);
  const action = process.argv[2];
  if (action === "prepare") {
    await prepareVaultStartup(env, process.cwd());
    process.stdout.write(config ? "ON\n" : "OFF\n");
  } else if (action === "verify") {
    if (!config) reject("ON_REQUIRED");
    await verifyVaultStartup(env, process.cwd());
    const boot = startVaultBoot(env, resolveUploadsRoots(env, process.cwd()));
    await boot.settled;
    if (boot.state() !== "ON") reject(boot.reason ?? "BOOT_CHECK_ERROR");
  } else reject("BAD_STARTUP_ACTION");
}

if (require.main === module) {
  void cli().catch((error: unknown) => {
    // No paths, raw errno messages, settings, or document bytes in launcher diagnostics.
    process.stderr.write(
      `vault_startup:${error instanceof VaultStartupError ? error.token : "INSPECTION_FAILED"}\n`,
    );
    process.exitCode = 1;
  });
}
