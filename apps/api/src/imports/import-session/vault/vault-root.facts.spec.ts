import type { UploadsRoots } from "../../../common/uploads-roots";

/**
 * B2a slice 2 RED (design v2.2 §3, RT1; decisions Q1-Q6): `classifyRootFacts`, the pure verdict over
 * ALREADY-COLLECTED facts about the private vault root.
 *
 * WHAT THIS DOES NOT PROVE: nothing here touches a filesystem. `resolved.*` is handed in as already
 * canonical (a future collector realpaths the deepest existing ancestor and appends the lexical
 * rest); the classifier only compares those strings and inspects the lstat-style facts. Symlink
 * resolution, TOCTOU and a real owner/mode on a real volume stay with the collector and the Linux
 * gate. Lexical alias cases are covered only in the form "the alias was already resolved to X".
 *
 * Contract pinned here (each numbered decision comes from the parent, the rest from design v2.2/v9.2):
 * - Q1 one argument: `RootFacts`; `resolved` is `UploadsRoots & { root }` (no third formula).
 * - Q2 root, `.lock`, `t/` and `trash/` must belong to the effective uid.
 * - Q3 `(mode & 0o7777) === 0o700` for directories, `0o600` for `.lock`: the lstat type bits are
 *   ignored (kind carries the type), setuid/setgid/sticky are refused.
 * - Q4 the FIRST failing check wins, in this order: euid, root, disjoint-public, disjoint-private,
 *   lock, t, trash.
 * - Q5 `step` is a bounded diagnostic token; the result never carries a path or an error text.
 * - Q6 Linux, case-sensitive, POSIX segments. `.`/`..`/repeated and trailing slashes are normalized
 *   lexically before comparing by segment (never by textual prefix); an empty, relative or
 *   NUL-carrying `resolved` value fails closed at the check it belongs to.
 *
 * `classifyRootFacts` does not exist yet. It is loaded lazily and asserted, so the RED is an
 * assertion about a missing function and not a compile error.
 */
type Kind = "dir" | "file" | "symlink" | "other";
type FsNode = { kind: "absent" } | { kind: Kind; mode: number; uid: number };
type Resolved = UploadsRoots & { root: string };
interface RootFacts {
  euid: number | null;
  resolved: Resolved;
  root: FsNode;
  lock: FsNode;
  t: FsNode;
  trash: FsNode;
}
type Step =
  | "euid"
  | "root"
  | "disjoint-public"
  | "disjoint-private"
  | "lock"
  | "t"
  | "trash";
type Verdict = { ok: true } | { ok: false; step: Step };
type Classify = (facts: RootFacts) => Verdict;

function load(): Classify {
  let loaded: { classifyRootFacts?: unknown } = {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loaded = require("./vault-root");
  } catch (error) {
    const missingSelf =
      (error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND" &&
      /^Cannot find module '\.\/vault-root'/.test((error as Error).message);
    if (!missingSelf) throw error;
  }
  expect(typeof loaded.classifyRootFacts).toBe("function");
  return loaded.classifyRootFacts as Classify;
}

const EUID = 1000;
const DIR_0700 = { kind: "dir", mode: 0o40700, uid: EUID } as const;
const LOCK_0600 = { kind: "file", mode: 0o100600, uid: EUID } as const;

function facts(
  over: Partial<Omit<RootFacts, "resolved">> = {},
  resolved: Partial<Resolved> = {},
): RootFacts {
  return {
    euid: EUID,
    resolved: {
      root: "/data/import-vault",
      publicDir: "/data/uploads",
      privateDir: "/data/private-uploads",
      ...resolved,
    },
    root: DIR_0700,
    lock: LOCK_0600,
    t: DIR_0700,
    trash: DIR_0700,
    ...over,
  };
}
const OK: Verdict = { ok: true };
const fail = (step: Step): Verdict => ({ ok: false, step });

describe("classifyRootFacts (RT1) - shape", () => {
  it("accepts the provisioned baseline with exactly {ok:true}, synchronously", () => {
    const classify = load();
    const out = classify(facts());
    expect(out).toEqual(OK);
    expect(Object.keys(out)).toEqual(["ok"]);
    expect(out).not.toHaveProperty("then");
  });

  it("fails with exactly {ok:false, step} and nothing else", () => {
    const classify = load();
    const out = classify(facts({ euid: null }));
    expect(out).toEqual(fail("euid"));
    expect(Object.keys(out).sort()).toEqual(["ok", "step"]);
  });

  it("is pure: frozen input is not mutated and repeated calls agree", () => {
    const classify = load();
    const input = facts();
    Object.freeze(input.resolved);
    for (const key of ["root", "lock", "t", "trash"] as const)
      Object.freeze(input[key]);
    Object.freeze(input);
    expect(classify(input)).toEqual(OK);
    expect(classify(input)).toEqual(OK);
    expect(input.resolved.root).toBe("/data/import-vault");
  });

  it("never leaks a path or text into the step, even for hostile strings", () => {
    const classify = load();
    const secret = "/data/SECRET-MARKER\u0000/x";
    const out = classify(
      facts({}, { publicDir: secret, root: "/data/SECRET-MARKER/vault" }),
    );
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).not.toContain("SECRET");
    expect((out as { step: string }).step).toMatch(/^[a-z]+(-[a-z]+)?$/);
  });
});

describe("classifyRootFacts (RT1) - euid (Q2)", () => {
  it("euid unavailable (null) fails at 'euid'", () => {
    expect(load()(facts({ euid: null }))).toEqual(fail("euid"));
  });

  it("a non-root euid is accepted when it owns every node", () => {
    const classify = load();
    expect(
      classify(
        facts({
          euid: 4242,
          root: { ...DIR_0700, uid: 4242 },
          lock: { ...LOCK_0600, uid: 4242 },
          t: { ...DIR_0700, uid: 4242 },
          trash: { ...DIR_0700, uid: 4242 },
        }),
      ),
    ).toEqual(OK);
  });

  it("euid 0 with everything owned by 0 is accepted (no special case for root)", () => {
    const classify = load();
    const owned = (node: FsNode) =>
      node.kind === "absent" ? node : { ...node, uid: 0 };
    expect(
      classify(
        facts({
          euid: 0,
          root: owned(DIR_0700),
          lock: owned(LOCK_0600),
          t: owned(DIR_0700),
          trash: owned(DIR_0700),
        }),
      ),
    ).toEqual(OK);
  });

  it("euid 0 does NOT bypass the owner check of a node owned by someone else", () => {
    expect(load()(facts({ euid: 0 }))).toEqual(fail("root"));
  });

  it.each([
    ["root", { root: { ...DIR_0700, uid: 1001 } }, "root"],
    ["lock", { lock: { ...LOCK_0600, uid: 1001 } }, "lock"],
    ["t", { t: { ...DIR_0700, uid: 1001 } }, "t"],
    ["trash", { trash: { ...DIR_0700, uid: 1001 } }, "trash"],
  ] as const)("%s owned by another uid fails at '%s'", (_name, over, step) => {
    expect(load()(facts(over))).toEqual(fail(step));
  });
});

describe("classifyRootFacts (RT1) - node kinds", () => {
  const notDir: FsNode[] = [
    { kind: "symlink", mode: 0o120700, uid: EUID },
    { kind: "file", mode: 0o100700, uid: EUID },
    { kind: "other", mode: 0o60700, uid: EUID },
    { kind: "absent" },
  ];
  const notFile: FsNode[] = [
    { kind: "dir", mode: 0o40600, uid: EUID },
    { kind: "symlink", mode: 0o120600, uid: EUID },
    { kind: "other", mode: 0o10600, uid: EUID },
    { kind: "absent" },
  ];

  it.each(notDir.map((node) => [node.kind, node] as const))(
    "root that is %s fails at 'root'",
    (_k, node) => {
      expect(load()(facts({ root: node }))).toEqual(fail("root"));
    },
  );
  it.each(notDir.map((node) => [node.kind, node] as const))(
    "t that is %s fails at 't'",
    (_k, node) => {
      expect(load()(facts({ t: node }))).toEqual(fail("t"));
    },
  );
  it.each(notDir.map((node) => [node.kind, node] as const))(
    "trash that is %s fails at 'trash'",
    (_k, node) => {
      expect(load()(facts({ trash: node }))).toEqual(fail("trash"));
    },
  );
  it.each(notFile.map((node) => [node.kind, node] as const))(
    ".lock that is %s fails at 'lock'",
    (_k, node) => {
      expect(load()(facts({ lock: node }))).toEqual(fail("lock"));
    },
  );
});

describe("classifyRootFacts (RT1) - modes (Q3)", () => {
  it.each([
    ["full S_IFDIR + 0700", 0o40700],
    ["bare 0700", 0o700],
    ["type bits are ignored (kind carries the type)", 0o100700],
  ])("directory mode accepted: %s", (_n, mode) => {
    const classify = load();
    const dir: FsNode = { kind: "dir", mode, uid: EUID };
    expect(classify(facts({ root: dir }))).toEqual(OK);
    expect(classify(facts({ t: dir }))).toEqual(OK);
    expect(classify(facts({ trash: dir }))).toEqual(OK);
  });

  it.each([
    ["0777", 0o40777],
    ["0755", 0o40755],
    ["0750", 0o40750],
    ["0710", 0o40710],
    ["0701", 0o40701],
    ["0600", 0o40600],
    ["0500", 0o40500],
    ["0000", 0o40000],
    ["sticky 1700", 0o41700],
    ["setgid 2700", 0o42700],
    ["setuid 4700", 0o44700],
    ["all special 7700", 0o47700],
  ])("directory mode refused: %s", (_n, mode) => {
    const classify = load();
    const dir: FsNode = { kind: "dir", mode, uid: EUID };
    expect(classify(facts({ root: dir }))).toEqual(fail("root"));
    expect(classify(facts({ t: dir }))).toEqual(fail("t"));
    expect(classify(facts({ trash: dir }))).toEqual(fail("trash"));
  });

  it.each([
    ["full S_IFREG + 0600", 0o100600],
    ["bare 0600", 0o600],
  ])(".lock mode accepted: %s", (_n, mode) => {
    expect(load()(facts({ lock: { kind: "file", mode, uid: EUID } }))).toEqual(
      OK,
    );
  });

  it.each([
    ["0644", 0o100644],
    ["0666", 0o100666],
    ["0640", 0o100640],
    ["0700", 0o100700],
    ["0400", 0o100400],
    ["0000", 0o100000],
    ["setuid 4600", 0o104600],
    ["setgid 2600", 0o102600],
    ["sticky 1600", 0o101600],
  ])(".lock mode refused: %s", (_n, mode) => {
    expect(load()(facts({ lock: { kind: "file", mode, uid: EUID } }))).toEqual(
      fail("lock"),
    );
  });
});

describe("classifyRootFacts (RT1) - disjoint roots (v2.2 section 3, both directions)", () => {
  const classify = (resolved: Partial<Resolved>) => load()(facts({}, resolved));

  it.each([
    ["equal", "/data/uploads"],
    ["descendant", "/data/uploads/vault"],
    ["deep descendant", "/data/uploads/a/b/c"],
    ["ancestor", "/data"],
    ["filesystem root as ancestor", "/"],
  ])(
    "vault %s of the public root is refused at 'disjoint-public'",
    (_n, root) => {
      expect(classify({ root })).toEqual(fail("disjoint-public"));
    },
  );

  it.each([
    ["equal", "/data/private-uploads"],
    ["descendant", "/data/private-uploads/vault"],
    ["ancestor (written with a parent segment)", "/data/private-uploads/.."],
  ])(
    "vault %s of the private root is refused (default private sibling)",
    (_n, root) => {
      const out = classify({ root, publicDir: "/elsewhere/uploads" });
      expect(out).toEqual(fail("disjoint-private"));
    },
  );

  it("V=/data is refused: it contains uploads, private-uploads and the database", () => {
    expect(classify({ root: "/data" })).toEqual(fail("disjoint-public"));
  });

  it("the public root is a descendant of the vault (both directions of the rule)", () => {
    expect(
      classify({
        root: "/srv/vault",
        publicDir: "/srv/vault/uploads",
        privateDir: "/srv/other",
      }),
    ).toEqual(fail("disjoint-public"));
  });

  it("the private root is a descendant of the vault", () => {
    expect(
      classify({
        root: "/srv/vault",
        publicDir: "/srv/uploads",
        privateDir: "/srv/vault/private",
      }),
    ).toEqual(fail("disjoint-private"));
  });

  it.each([
    ["V/t", "/srv/vault/t/x"],
    ["V/trash", "/srv/vault/trash"],
    ["V/t itself", "/srv/vault/t"],
  ])("a public root inside %s is refused", (_n, publicDir) => {
    expect(
      classify({ root: "/srv/vault", publicDir, privateDir: "/srv/other" }),
    ).toEqual(fail("disjoint-public"));
  });

  it.each([
    ["V/t", "/srv/vault/t/x"],
    ["V/trash", "/srv/vault/trash"],
  ])("a private root inside %s is refused", (_n, privateDir) => {
    expect(
      classify({ root: "/srv/vault", publicDir: "/srv/uploads", privateDir }),
    ).toEqual(fail("disjoint-private"));
  });

  it("the canonical sibling layout is accepted", () => {
    expect(classify({})).toEqual(OK);
  });

  it("a custom private root (PRIVATE_UPLOADS_DIR) elsewhere is accepted", () => {
    expect(classify({ privateDir: "/srv/private" })).toEqual(OK);
  });

  it("a custom private root that contains the vault is refused", () => {
    expect(classify({ privateDir: "/data" })).toEqual(fail("disjoint-private"));
  });

  it("a custom private root equal to the vault is refused", () => {
    expect(classify({ privateDir: "/data/import-vault" })).toEqual(
      fail("disjoint-private"),
    );
  });

  it.each([
    [
      "vault name extends the public name",
      "/data/uploads-vault",
      "/data/uploads",
    ],
    ["vault name prefixes the public name", "/data/upload", "/data/uploads"],
    [
      "public name extends the vault name",
      "/data/import-vault",
      "/data/import-vault2",
    ],
    [
      "vault extends the private name",
      "/data/private-uploads-2",
      "/data/uploads",
    ],
    [
      "common textual prefix, different segment",
      "/data/uploads2",
      "/data/uploads",
    ],
  ])(
    "siblings sharing a textual prefix are valid: %s",
    (_n, root, publicDir) => {
      expect(classify({ root, publicDir })).toEqual(OK);
    },
  );

  it("a sibling with a textual prefix of the PRIVATE root is valid", () => {
    expect(
      classify({ root: "/data/private", privateDir: "/data/private-uploads" }),
    ).toEqual(OK);
  });

  describe("lexical normalization (Q6)", () => {
    it.each([
      [
        "trailing slash on the public root",
        { publicDir: "/data/uploads/" },
        "/data/uploads",
        "disjoint-public",
      ],
      [
        "repeated slashes",
        { publicDir: "/data//uploads" },
        "/data/uploads",
        "disjoint-public",
      ],
      [
        "dot segment",
        { publicDir: "/data/./uploads" },
        "/data/uploads",
        "disjoint-public",
      ],
      [
        "parent segment",
        { publicDir: "/data/x/../uploads" },
        "/data/uploads",
        "disjoint-public",
      ],
      [
        "trailing slash on the private root",
        { privateDir: "/data/private-uploads/" },
        "/data/private-uploads",
        "disjoint-private",
      ],
    ] as const)(
      "%s normalizes before comparing (equal is refused)",
      (_n, over, root, step) => {
        expect(classify({ ...over, root })).toEqual(fail(step));
      },
    );

    it("a vault written with dots that lands inside the public root is refused", () => {
      expect(classify({ root: "/data/import-vault/../uploads/vault" })).toEqual(
        fail("disjoint-public"),
      );
    });

    it("a vault written with dots that lands beside the public root is accepted", () => {
      expect(classify({ root: "/data/uploads/../import-vault" })).toEqual(OK);
    });

    it("a trailing slash on the vault does not hide that it contains the public or private root", () => {
      expect(
        classify({ root: "/data/uploads/", publicDir: "/data/uploads/inner" }),
      ).toEqual(fail("disjoint-public"));
      expect(
        classify({
          root: "/srv/vault/",
          publicDir: "/srv/uploads",
          privateDir: "/srv/vault/private",
        }),
      ).toEqual(fail("disjoint-private"));
    });

    it("a trailing slash on the public or private root does not hide that it contains the vault", () => {
      expect(
        classify({ root: "/data/uploads/vault", publicDir: "/data/uploads/" }),
      ).toEqual(fail("disjoint-public"));
      expect(
        classify({
          root: "/srv/private/vault",
          publicDir: "/srv/uploads",
          privateDir: "/srv/private/",
        }),
      ).toEqual(fail("disjoint-private"));
    });

    it("a trailing slash on the vault itself does not hide equality", () => {
      expect(classify({ root: "/data/uploads/" })).toEqual(
        fail("disjoint-public"),
      );
    });

    it("parent segments cannot climb above the filesystem root to fake a sibling", () => {
      expect(classify({ root: "/../data/uploads" })).toEqual(
        fail("disjoint-public"),
      );
    });
  });

  describe("Linux is case-sensitive (Q6)", () => {
    it("differs in case: not the same directory", () => {
      expect(classify({ root: "/data/Uploads" })).toEqual(OK);
    });
    it("a different-case prefix is not an ancestor", () => {
      expect(classify({ root: "/DATA/import-vault" })).toEqual(OK);
    });
    it("a different-case path under the public root is not inside it", () => {
      expect(classify({ root: "/data/UPLOADS/vault" })).toEqual(OK);
    });
    it("the same case is still refused", () => {
      expect(classify({ root: "/data/uploads/vault" })).toEqual(
        fail("disjoint-public"),
      );
    });
  });

  describe("already-resolved aliases (the classifier does not prove realpath)", () => {
    it("an alias the collector resolved INTO the public root is refused", () => {
      expect(classify({ root: "/data/uploads/vault-link-target" })).toEqual(
        fail("disjoint-public"),
      );
    });
    it("an alias the collector resolved to a real sibling is accepted", () => {
      expect(classify({ root: "/mnt/volume/import-vault" })).toEqual(OK);
    });
  });

  describe("fail closed on unusable resolved values (Q6)", () => {
    it.each([
      ["empty", ""],
      ["relative", "data/import-vault"],
      ["dot-relative", "./import-vault"],
      ["NUL byte", "/data/import\u0000-vault"],
    ])("resolved.root %s fails at 'root'", (_n, root) => {
      expect(classify({ root })).toEqual(fail("root"));
    });
    it.each([
      ["empty", ""],
      ["relative", "uploads"],
      ["NUL byte", "/data/up\u0000loads"],
    ])("resolved.publicDir %s fails at 'disjoint-public'", (_n, publicDir) => {
      expect(classify({ publicDir })).toEqual(fail("disjoint-public"));
    });
    it.each([
      ["empty", ""],
      ["relative", "private-uploads"],
      ["NUL byte", "/data/private\u0000-uploads"],
    ])(
      "resolved.privateDir %s fails at 'disjoint-private'",
      (_n, privateDir) => {
        expect(classify({ privateDir })).toEqual(fail("disjoint-private"));
      },
    );
  });
});

describe("classifyRootFacts (RT1) - the first failing check wins (Q4)", () => {
  const bad = { kind: "absent" } as const;
  const classify = load;

  it("euid outranks every other failure", () => {
    expect(
      classify()(
        facts(
          { euid: null, root: bad, lock: bad, t: bad, trash: bad },
          {
            root: "/data",
            publicDir: "/data/uploads",
            privateDir: "/data/private-uploads",
          },
        ),
      ),
    ).toEqual(fail("euid"));
  });

  it("root outranks disjointness", () => {
    expect(classify()(facts({ root: bad }, { root: "/data" }))).toEqual(
      fail("root"),
    );
  });

  it("a root that is not a directory outranks a bad lock, t and trash", () => {
    expect(
      classify()(
        facts({
          root: { kind: "symlink", mode: 0o120777, uid: EUID },
          lock: bad,
          t: bad,
          trash: bad,
        }),
      ),
    ).toEqual(fail("root"));
  });

  it("disjoint-public outranks disjoint-private", () => {
    expect(classify()(facts({}, { root: "/data" }))).toEqual(
      fail("disjoint-public"),
    );
  });

  it("disjoint-private outranks lock", () => {
    expect(classify()(facts({ lock: bad }, { privateDir: "/data" }))).toEqual(
      fail("disjoint-private"),
    );
  });

  it("disjoint-public outranks lock", () => {
    expect(classify()(facts({ lock: bad }, { publicDir: "/data" }))).toEqual(
      fail("disjoint-public"),
    );
  });

  it("lock outranks t and trash", () => {
    expect(classify()(facts({ lock: bad, t: bad, trash: bad }))).toEqual(
      fail("lock"),
    );
  });

  it("t outranks trash", () => {
    expect(classify()(facts({ t: bad, trash: bad }))).toEqual(fail("t"));
  });

  it("trash is reported when it is the only failure", () => {
    expect(classify()(facts({ trash: bad }))).toEqual(fail("trash"));
  });

  it("a wrong mode on an earlier node outranks a wrong owner on a later one", () => {
    expect(
      classify()(
        facts({
          root: { ...DIR_0700, mode: 0o40755 },
          lock: { ...LOCK_0600, uid: 1 },
        }),
      ),
    ).toEqual(fail("root"));
  });
});
