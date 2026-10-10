import type { VehicleDocumentService as VehicleDocumentServiceType } from "./vehicle-document/vehicle-document.service";

/**
 * CHARACTERIZATION (B2a, before any canonical uploads-root source exists): what the two REAL
 * consumers resolve today from `UPLOADS_DIR` / `PRIVATE_UPLOADS_DIR`. It pins observable behaviour
 * only, through the real `app.module.ts` (the `ServeStaticModule.forRoot` argument) and the real
 * `VehicleDocumentService` (the paths it hands to `fs`), with the I/O boundary replaced:
 *  - `@nestjs/serve-static` is stubbed so nothing is served and nothing is read;
 *  - `fs` is a spread of the real module with five calls replaced by spies. `mkdirSync`,
 *    `writeFileSync` and `rmSync` are pure no-ops, so no directory is created and no file is
 *    written or removed. `readFileSync` and `existsSync` answer only for paths that contain
 *    `vehicle-documents` and DELEGATE TO THE REAL fs for everything else (e.g. loading the Prisma
 *    client), so reads outside the service's own directory are real.
 * Neither formula is copied here and nothing private is exported. Both roots are computed when the
 * module is IMPORTED, so every case loads a fresh copy inside `jest.isolateModules` after setting
 * the environment, and restores the environment afterwards.
 *
 * The behaviours below are what exists, not what is desirable: a later extraction of a canonical
 * source must keep them (or change them in its own reviewed step).
 */
const CWD = process.cwd();
const OWN_DIR = "vehicle-documents";
/** Calls that concern the service's own directory (the Prisma client also reads through fs). */
const ownCalls = (spy: jest.Mock) =>
  spy.mock.calls.filter((call) => String(call[0]).includes(OWN_DIR));
const KEYS = ["UPLOADS_DIR", "PRIVATE_UPLOADS_DIR"] as const;
type Env = Partial<Record<(typeof KEYS)[number], string>>;

function withEnv<T>(env: Env, run: () => T): T {
  const saved = KEYS.map((key) => [key, process.env[key]] as const);
  for (const key of KEYS) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** The `rootPath` / `serveRoot` app.module.ts hands to ServeStaticModule.forRoot(). */
function serveStaticOptions(env: Env): { rootPath: string; serveRoot: string } {
  return withEnv(env, () => {
    let received: unknown;
    jest.isolateModules(() => {
      jest.doMock("@nestjs/serve-static", () => ({
        ServeStaticModule: {
          forRoot: (options: unknown) => {
            received = options;
            return { module: class StubServeStatic {} };
          },
        },
      }));
      try {
        require("./app.module");
      } finally {
        jest.dontMock("@nestjs/serve-static");
      }
    });
    return received as { rootPath: string; serveRoot: string };
  });
}

interface FsSpies {
  mkdirSync: jest.Mock;
  writeFileSync: jest.Mock;
  readFileSync: jest.Mock;
  existsSync: jest.Mock;
  rmSync: jest.Mock;
}
interface Loaded {
  VehicleDocumentService: typeof VehicleDocumentServiceType;
  spies: FsSpies;
}
/** Imports the real service with the five fs spies described in the header. */
function loadVehicleDocument(env: Env): Loaded {
  return withEnv(env, () => {
    // Everything that is not a vehicle-documents path (e.g. loading the Prisma client) keeps the
    // real behaviour; the spies only answer for, and record, the service's own paths.
    const real = jest.requireActual<typeof import("fs")>("fs");
    const own = (target: unknown) => String(target).includes(OWN_DIR);
    const spies: FsSpies = {
      mkdirSync: jest.fn(),
      writeFileSync: jest.fn(),
      readFileSync: jest.fn((...args: Parameters<typeof real.readFileSync>) =>
        own(args[0]) ? Buffer.from("stored") : real.readFileSync(...args),
      ),
      existsSync: jest.fn((...args: Parameters<typeof real.existsSync>) =>
        own(args[0]) ? true : real.existsSync(...args),
      ),
      rmSync: jest.fn(),
    };
    let service: typeof VehicleDocumentServiceType | undefined;
    jest.isolateModules(() => {
      jest.doMock("fs", () => ({
        ...jest.requireActual<typeof import("fs")>("fs"),
        ...spies,
      }));
      try {
        service =
          require("./vehicle-document/vehicle-document.service").VehicleDocumentService;
      } finally {
        jest.dontMock("fs");
      }
    });
    return { VehicleDocumentService: service!, spies };
  });
}

const DOCUMENT = {
  id: "doc-1",
  tenantId: "t1",
  projectId: "p1",
  reminderId: null,
  deletedAt: null,
};
function vehicleService(loaded: Loaded, storedKey = "stored.pdf") {
  const prisma = {
    vehicleDocument: { findFirst: jest.fn().mockResolvedValue(DOCUMENT) },
    attachment: {
      create: jest.fn().mockResolvedValue({
        id: "att-1",
        fileName: "a.pdf",
        mimeType: "application/pdf",
        uploadedBy: "u1",
        createdAt: new Date(0),
      }),
      findFirst: jest.fn().mockResolvedValue({
        id: "att-1",
        url: storedKey,
        mimeType: "application/pdf",
        fileName: "a.pdf",
      }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  return new loaded.VehicleDocumentService(prisma as never);
}
const pdfFile = () =>
  ({
    buffer: Buffer.from("%PDF-1.4 synthetic"),
    mimetype: "application/pdf",
    originalname: "a.pdf",
  }) as Express.Multer.File;

/** The directory the vehicle-documents service creates at construction. */
const vehicleDir = (env: Env): string => {
  const loaded = loadVehicleDocument(env);
  vehicleService(loaded);
  expect(loaded.spies.mkdirSync).toHaveBeenCalledTimes(1);
  expect(loaded.spies.mkdirSync.mock.calls[0]![1]).toEqual({ recursive: true });
  return loaded.spies.mkdirSync.mock.calls[0]![0] as string;
};

describe("instrument: the environment is restored exactly", () => {
  it("a previous non-empty value survives every helper, whether the case sets, changes or clears it", () => {
    const saved = KEYS.map((key) => [key, process.env[key]] as const);
    process.env["UPLOADS_DIR"] = "/srv/original/uploads";
    process.env["PRIVATE_UPLOADS_DIR"] = "/srv/original/private";
    try {
      serveStaticOptions({ UPLOADS_DIR: "/srv/other" });
      serveStaticOptions({});
      vehicleDir({ PRIVATE_UPLOADS_DIR: "/srv/other" });
      vehicleDir({});
      const loaded = loadVehicleDocument({});
      withEnv({ PRIVATE_UPLOADS_DIR: "/srv/late" }, () =>
        vehicleService(loaded),
      );
      expect(process.env["UPLOADS_DIR"]).toBe("/srv/original/uploads");
      expect(process.env["PRIVATE_UPLOADS_DIR"]).toBe("/srv/original/private");
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("an absent variable stays absent afterwards", () => {
    const saved = KEYS.map((key) => [key, process.env[key]] as const);
    for (const key of KEYS) delete process.env[key];
    try {
      vehicleDir({ PRIVATE_UPLOADS_DIR: "/srv/other" });
      expect(KEYS.map((key) => key in process.env)).toEqual([false, false]);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("app.module.ts — the public uploads root handed to ServeStaticModule", () => {
  it.each<[string, Env, string]>([
    ["UPLOADS_DIR absent", {}, `${CWD}/uploads`],
    ["UPLOADS_DIR empty (falsy)", { UPLOADS_DIR: "" }, `${CWD}/uploads`],
    [
      "UPLOADS_DIR relative is anchored on the process cwd",
      { UPLOADS_DIR: "data/pub" },
      `${CWD}/data/pub`,
    ],
    [
      "UPLOADS_DIR relative with dot segments is normalised by the anchoring",
      { UPLOADS_DIR: "./a/../pub" },
      `${CWD}/pub`,
    ],
    [
      "UPLOADS_DIR absolute is used as given",
      { UPLOADS_DIR: "/srv/public/uploads" },
      "/srv/public/uploads",
    ],
    [
      "UPLOADS_DIR absolute keeps its trailing slash (no normalisation)",
      { UPLOADS_DIR: "/srv/public/uploads/" },
      "/srv/public/uploads/",
    ],
    [
      "UPLOADS_DIR absolute keeps dot segments verbatim (no normalisation)",
      { UPLOADS_DIR: "/srv/a/../public" },
      "/srv/a/../public",
    ],
    [
      "PRIVATE_UPLOADS_DIR does not change the public root (the result is independent of it)",
      { PRIVATE_UPLOADS_DIR: "/srv/private" },
      `${CWD}/uploads`,
    ],
  ])("%s", (_name, env, expected) => {
    expect(serveStaticOptions(env)).toEqual({
      rootPath: expected,
      serveRoot: "/uploads",
    });
  });

  it("is decided when app.module.ts is imported, not later", () => {
    const first = serveStaticOptions({ UPLOADS_DIR: "/srv/one" });
    const second = serveStaticOptions({ UPLOADS_DIR: "/srv/two" });
    expect([first.rootPath, second.rootPath]).toEqual(["/srv/one", "/srv/two"]);

    // The environment changed AFTER the import: the loaded module keeps the old value.
    let received: { rootPath: string } | undefined;
    withEnv({ UPLOADS_DIR: "/srv/early" }, () => {
      jest.isolateModules(() => {
        jest.doMock("@nestjs/serve-static", () => ({
          ServeStaticModule: {
            forRoot: (options: { rootPath: string }) => {
              received = options;
              return { module: class StubServeStatic {} };
            },
          },
        }));
        try {
          require("./app.module");
          process.env["UPLOADS_DIR"] = "/srv/late";
        } finally {
          jest.dontMock("@nestjs/serve-static");
        }
      });
    });
    expect(received?.rootPath).toBe("/srv/early");
  });
});

describe("vehicle-document.service.ts — the private root and the fs paths it uses", () => {
  it.each<[string, Env, string]>([
    [
      "both absent: a private-uploads sibling of ./uploads, i.e. inside the cwd",
      {},
      `${CWD}/private-uploads/vehicle-documents`,
    ],
    [
      "PRIVATE_UPLOADS_DIR absolute is used as given",
      { PRIVATE_UPLOADS_DIR: "/srv/private" },
      "/srv/private/vehicle-documents",
    ],
    [
      "PRIVATE_UPLOADS_DIR absolute with a trailing slash",
      { PRIVATE_UPLOADS_DIR: "/srv/private/" },
      "/srv/private/vehicle-documents",
    ],
    [
      "PRIVATE_UPLOADS_DIR absolute with dot segments is normalised by the final join",
      { PRIVATE_UPLOADS_DIR: "/srv/a/../b" },
      "/srv/b/vehicle-documents",
    ],
    [
      "PRIVATE_UPLOADS_DIR relative is anchored on the cwd",
      { PRIVATE_UPLOADS_DIR: "priv" },
      `${CWD}/priv/vehicle-documents`,
    ],
    [
      "PRIVATE_UPLOADS_DIR empty (falsy) falls back to the UPLOADS_DIR sibling",
      { PRIVATE_UPLOADS_DIR: "", UPLOADS_DIR: "/srv/public/uploads" },
      "/srv/public/private-uploads/vehicle-documents",
    ],
    [
      "PRIVATE_UPLOADS_DIR wins over UPLOADS_DIR",
      {
        PRIVATE_UPLOADS_DIR: "/srv/private",
        UPLOADS_DIR: "/srv/public/uploads",
      },
      "/srv/private/vehicle-documents",
    ],
    [
      "UPLOADS_DIR absolute only: private-uploads beside it",
      { UPLOADS_DIR: "/srv/public/uploads" },
      "/srv/public/private-uploads/vehicle-documents",
    ],
    [
      "UPLOADS_DIR absolute with a trailing slash: the same sibling",
      { UPLOADS_DIR: "/srv/public/uploads/" },
      "/srv/public/private-uploads/vehicle-documents",
    ],
    [
      "UPLOADS_DIR relative only: sibling of the cwd-anchored path",
      { UPLOADS_DIR: "data/uploads" },
      `${CWD}/data/private-uploads/vehicle-documents`,
    ],
    [
      "UPLOADS_DIR empty (falsy): the default ./uploads sibling",
      { UPLOADS_DIR: "" },
      `${CWD}/private-uploads/vehicle-documents`,
    ],
    [
      "UPLOADS_DIR at the filesystem root puts the sibling at the root too (a quirk, pinned)",
      { UPLOADS_DIR: "/" },
      "/private-uploads/vehicle-documents",
    ],
  ])("%s", (_name, env, expected) => {
    expect(vehicleDir(env)).toBe(expected);
  });

  it("is decided when the module is imported, not when the service is built", () => {
    const loaded = loadVehicleDocument({ PRIVATE_UPLOADS_DIR: "/srv/early" });
    withEnv({ PRIVATE_UPLOADS_DIR: "/srv/late" }, () => vehicleService(loaded));
    expect(loaded.spies.mkdirSync.mock.calls[0]![0]).toBe(
      "/srv/early/vehicle-documents",
    );
  });

  it("creates the directory once per service instance and nothing at import time", () => {
    const loaded = loadVehicleDocument({ PRIVATE_UPLOADS_DIR: "/srv/p" });
    expect(loaded.spies.mkdirSync).not.toHaveBeenCalled();
    vehicleService(loaded);
    vehicleService(loaded);
    expect(loaded.spies.mkdirSync).toHaveBeenCalledTimes(2);
  });

  describe("the same root serves every file operation", () => {
    const env: Env = { PRIVATE_UPLOADS_DIR: "/srv/priv" };

    it("upload writes <root>/<uuid>.pdf", async () => {
      const loaded = loadVehicleDocument(env);
      await vehicleService(loaded).addAttachment(
        "t1",
        "p1",
        "doc-1",
        "u1",
        pdfFile(),
      );
      const [target, bytes] = loaded.spies.writeFileSync.mock.calls[0]!;
      expect(target).toMatch(
        /^\/srv\/priv\/vehicle-documents\/[0-9a-f-]{36}\.pdf$/,
      );
      expect(Buffer.from(bytes as Buffer).toString()).toBe(
        "%PDF-1.4 synthetic",
      );
    });

    it("download checks and reads <root>/<stored key>", async () => {
      const loaded = loadVehicleDocument(env);
      const result = await vehicleService(loaded).getAttachmentContent(
        "t1",
        "p1",
        "doc-1",
        "att-1",
      );
      expect(loaded.spies.existsSync).toHaveBeenCalledWith(
        "/srv/priv/vehicle-documents/stored.pdf",
      );
      expect(loaded.spies.readFileSync).toHaveBeenCalledWith(
        "/srv/priv/vehicle-documents/stored.pdf",
      );
      expect(result.buffer.toString()).toBe("stored");
    });

    it("remove deletes <root>/<stored key> with force", async () => {
      const loaded = loadVehicleDocument(env);
      await vehicleService(loaded).removeAttachment(
        "t1",
        "p1",
        "doc-1",
        "att-1",
      );
      expect(loaded.spies.rmSync).toHaveBeenCalledWith(
        "/srv/priv/vehicle-documents/stored.pdf",
        { force: true },
      );
    });

    it.each(["../escape.pdf", "sub/dir.pdf", "/abs.pdf"])(
      "a stored key that is not a bare file name (%s) is refused before any fs call",
      async (key) => {
        const loaded = loadVehicleDocument(env);
        await expect(
          vehicleService(loaded, key).getAttachmentContent(
            "t1",
            "p1",
            "doc-1",
            "att-1",
          ),
        ).rejects.toThrow("Caminho de anexo inválido");
        expect(ownCalls(loaded.spies.existsSync)).toEqual([]);
        expect(ownCalls(loaded.spies.readFileSync)).toEqual([]);
      },
    );
  });
});

describe("the two consumers together", () => {
  it.each<[string, Env]>([
    ["no environment", {}],
    ["UPLOADS_DIR absolute only", { UPLOADS_DIR: "/srv/public/uploads" }],
    ["UPLOADS_DIR relative only", { UPLOADS_DIR: "data/uploads" }],
    [
      "UPLOADS_DIR with a trailing slash",
      { UPLOADS_DIR: "/srv/public/uploads/" },
    ],
  ])(
    "%s: the default private root is a sibling, never inside the public root",
    (_name, env) => {
      const pub = serveStaticOptions(env).rootPath.replace(/\/+$/, "");
      const priv = vehicleDir(env);
      expect(priv.startsWith(`${pub}/`)).toBe(false);
      expect(priv).not.toBe(pub);
    },
  );

  it("an explicit PRIVATE_UPLOADS_DIR inside the public root is NOT prevented today (no guard exists)", () => {
    const env: Env = {
      UPLOADS_DIR: "/srv/public/uploads",
      PRIVATE_UPLOADS_DIR: "/srv/public/uploads/secret",
    };
    expect(serveStaticOptions(env).rootPath).toBe("/srv/public/uploads");
    expect(vehicleDir(env)).toBe(
      "/srv/public/uploads/secret/vehicle-documents",
    );
  });
});
