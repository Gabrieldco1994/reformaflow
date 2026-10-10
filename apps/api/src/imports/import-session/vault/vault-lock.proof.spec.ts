import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import type {
  FdinfoLockEntry as LockEntry,
  FlockMode as Mode,
  LockFacts,
  LockProof as Proof,
  LockProofReason as Reason,
} from "./vault-lock";
import { parseVaultConfig } from "./vault.config";

/**
 * B2a slice 3 RED (contract: b2a-slice3-lock-proof-pure.md v1 + addendum v2, v2 wins; canon
 * b2a-final-design.md L524-527): the PURE lock-ownership proof, `parseFdinfoLockLines` and
 * `decideLockProof`, future additions to `vault-lock.ts`. No I/O, no process, no timer.
 *
 * Provenance is labelled per group:
 * - CAPTURED: text copied from the SRE run b2a-linux-node20-evidence/stdout-v2.txt (Node 20.20.2,
 *   LinuxKit 6.12.54 arm64, overlay and tmpfs). The only observed shapes are 0 lock lines (an
 *   independent FD, recorded as `lockLines: []`) and exactly 1 line (owner/dup, FLOCK WRITE or READ).
 * - DERIVED: a captured text with one field substituted or one line removed (flags:0400000, the
 *   lock line removed: OVERLAY_HEADER and the no-lock-line cases are derived, not captured).
 * - FORMAT CONTRACT: invented positive cases (pid values, spacing, uint64 edges, dev vectors) that
 *   pin the accepted grammar. They are NOT Linux captures and claim nothing about a real kernel.
 * - SYNTHETIC: invented to assert NON-authorization only. Nothing here claims a real POSIX/OFDLCK/waiter format.
 *
 * "Exactly one FLOCK WRITE line" is a conservative fail-closed policy scoped to what was observed;
 * it is NOT a claim that a kernel can never print two lines, and it says nothing about production
 * filesystems (the Fly /data volume was never probed).
 *
 * The exports are loaded lazily and asserted, so while they were absent the RED was an assertion
 * about a missing function and not a compile error. Types come from the canonical `vault-lock.ts`.
 */
type Parse = (text: string) => LockEntry[];
type Decide = (facts: LockFacts) => Proof;
type Decode = (dev: bigint) => { major: number; minor: number } | null;

function load(): { parse: Parse; decide: Decide; decode: Decode } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const loaded: Record<string, unknown> = require("./vault-lock");
  expect(typeof loaded.parseFdinfoLockLines).toBe("function");
  expect(typeof loaded.decideLockProof).toBe("function");
  return {
    parse: loaded.parseFdinfoLockLines as Parse,
    decide: loaded.decideLockProof as Decide,
    decode: loaded.decodeLinuxDev as Decode,
  };
}

// Type checks first and bigint rendered as text: a bigint inside a failed matcher cannot be
// serialized by the jest worker and would turn an assertion failure into a suite error.
type Brief =
  | { kind: "FLOCK"; mode: Mode; major: number; minor: number; ino: string }
  | { kind: "OTHER" };
function brief(entries: LockEntry[]): Brief[] {
  expect(Array.isArray(entries)).toBe(true);
  return entries.map((entry) => {
    if (entry.kind === "OTHER") {
      expect(Object.keys(entry)).toEqual(["kind"]);
      return { kind: "OTHER" };
    }
    expect(Object.keys(entry).sort()).toEqual([
      "ino",
      "kind",
      "major",
      "minor",
      "mode",
    ]);
    expect(typeof entry.ino).toBe("bigint");
    expect(typeof entry.major).toBe("number");
    expect(typeof entry.minor).toBe("number");
    return { ...entry, ino: entry.ino.toString() };
  });
}
const flock = (
  mode: Mode,
  major: number,
  minor: number,
  ino: string,
): Brief => ({ kind: "FLOCK", mode, major, minor, ino });
const OTHER: Brief = { kind: "OTHER" };

const OK: Proof = { ok: true };
const not = (reason: Reason): Proof => ({ ok: false, reason });

// DERIVED from stdout-v2 overlay A2/A3 (its lock line removed): fd dev 62n = 00:3e, ino 3686654.
const OVERLAY_HEADER =
  "pos:\t0\nflags:\t02400000\nmnt_id:\t136\nino:\t3686654\n";
// CAPTURED lock line of the same run.
const OVERLAY_LOCK = "lock:\t1: FLOCK  ADVISORY  WRITE 0 00:3e:3686654 0 EOF\n";
const OVERLAY = OVERLAY_HEADER + OVERLAY_LOCK;
// CAPTURED (stdout-v2 tmpfs A2/A3): dev 76n = 00:4c, ino 6.
const TMPFS =
  "pos:\t0\nflags:\t02400000\nmnt_id:\t145\nino:\t6\nlock:\t1: FLOCK  ADVISORY  WRITE 0 00:4c:6 0 EOF\n";

function facts(over: Partial<LockFacts> = {}): LockFacts {
  return {
    lockFd: 9,
    platform: "linux",
    fd: { kind: "file", dev: 62n, ino: 3686654n },
    path: { kind: "file", dev: 62n, ino: 3686654n },
    fdinfo: OVERLAY,
    ...over,
  };
}
function frozen(input: LockFacts): LockFacts {
  Object.freeze(input.fd);
  Object.freeze(input.path);
  return Object.freeze(input);
}
/** Same decision for a text, everything else being the captured overlay owner. */
const decideText = (fdinfo: string | null, over: Partial<LockFacts> = {}) =>
  load().decide(facts({ fdinfo, ...over }));

describe("scope controls (they pass today and prove nothing about the parser)", () => {
  it("decodeLinuxDev is the untouched LK1 decoder for the two captured st_dev values", () => {
    const { decode } = load2Decode();
    expect(decode(62n)).toEqual({ major: 0, minor: 62 });
    expect(decode(76n)).toEqual({ major: 0, minor: 76 });
  });
});
// The decoder control must not depend on the not-yet-existing exports.
function load2Decode(): { decode: Decode } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const loaded: Record<string, unknown> = require("./vault-lock");
  expect(typeof loaded.decodeLinuxDev).toBe("function");
  return { decode: loaded.decodeLinuxDev as Decode };
}

describe("parseFdinfoLockLines: the canonical line (D1/D2)", () => {
  it("CAPTURED overlay owner parses to one FLOCK WRITE entry; pid/ordinal are not exposed", () => {
    expect(brief(load().parse(OVERLAY))).toEqual([
      flock("WRITE", 0, 62, "3686654"),
    ]);
  });

  it("CAPTURED tmpfs owner parses to one FLOCK WRITE entry (minor 76)", () => {
    expect(brief(load().parse(TMPFS))).toEqual([flock("WRITE", 0, 76, "6")]);
  });

  it("CAPTURED READ parses as READ, never as WRITE (overlay 00:3e:3686682, tmpfs 00:4c:35)", () => {
    const { parse } = load();
    expect(
      brief(parse("lock:\t1: FLOCK  ADVISORY  READ 0 00:3e:3686682 0 EOF\n")),
    ).toEqual([flock("READ", 0, 62, "3686682")]);
    expect(
      brief(parse("lock:\t1: FLOCK  ADVISORY  READ 0 00:4c:35 0 EOF\n")),
    ).toEqual([flock("READ", 0, 76, "35")]);
  });

  it("DERIVED text with no lock line (independent FD) parses to no entry", () => {
    expect(brief(load().parse(OVERLAY_HEADER))).toEqual([]);
    expect(brief(load().parse(""))).toEqual([]);
  });

  it("FORMAT CONTRACT: one or more ASCII spaces separate the canonical tokens; the count is not authority (3 and 5 and 2, decided ok)", () => {
    const line =
      "lock:\t1:  FLOCK   ADVISORY     WRITE  0  00:3e:3686654  0  EOF\n";
    expect(brief(load().parse(line))).toEqual([
      flock("WRITE", 0, 62, "3686654"),
    ]);
    expect(decideText(OVERLAY_HEADER + line)).toEqual(OK);
  });

  it("FORMAT CONTRACT: single spaces between the words are accepted (spacing is not authority)", () => {
    expect(
      brief(
        load().parse("lock:\t1: FLOCK ADVISORY WRITE 0 00:3e:3686654 0 EOF\n"),
      ),
    ).toEqual([flock("WRITE", 0, 62, "3686654")]);
  });

  it.each([
    [
      "start 1, end 2",
      "lock:\t1: FLOCK  ADVISORY  WRITE 0 00:3e:3686654 1 2\n",
    ],
    ["end 5", "lock:\t1: FLOCK  ADVISORY  WRITE 0 00:3e:3686654 0 5\n"],
    ["start 00", "lock:\t1: FLOCK  ADVISORY  WRITE 0 00:3e:3686654 00 EOF\n"],
    [
      "end lowercase eof",
      "lock:\t1: FLOCK  ADVISORY  WRITE 0 00:3e:3686654 0 eof\n",
    ],
    [
      "trailing token",
      "lock:\t1: FLOCK  ADVISORY  WRITE 0 00:3e:3686654 0 EOF extra\n",
    ],
    ["missing end", "lock:\t1: FLOCK  ADVISORY  WRITE 0 00:3e:3686654 0\n"],
  ])(
    "SYNTHETIC: %s is not the canonical line (one OTHER entry)",
    (_n, line) => {
      expect(brief(load().parse(line))).toEqual([OTHER]);
      expect(decideText(line)).toEqual(not("LOCK_NOT_OWNED"));
    },
  );

  it.each([
    [
      "TAB between the tokens",
      "lock:\t1: FLOCK\tADVISORY\tWRITE 0 00:3e:3686654 0 EOF\n",
    ],
    [
      "lowercase flock",
      "lock:\t1: flock  ADVISORY  WRITE 0 00:3e:3686654 0 EOF\n",
    ],
    [
      "MANDATORY instead of ADVISORY",
      "lock:\t1: FLOCK  MANDATORY  WRITE 0 00:3e:3686654 0 EOF\n",
    ],
    [
      "unknown mode RW",
      "lock:\t1: FLOCK  ADVISORY  RW 0 00:3e:3686654 0 EOF\n",
    ],
    [
      "0x prefix on the major",
      "lock:\t1: FLOCK  ADVISORY  WRITE 0 0x3e:3e:3686654 0 EOF\n",
    ],
    [
      "uppercase hex",
      "lock:\t1: FLOCK  ADVISORY  WRITE 0 00:3E:3686654 0 EOF\n",
    ],
    [
      "9-digit major",
      "lock:\t1: FLOCK  ADVISORY  WRITE 0 1ffffffff:3e:3686654 0 EOF\n",
    ],
    [
      "9-digit minor",
      "lock:\t1: FLOCK  ADVISORY  WRITE 0 00:1ffffffff:3686654 0 EOF\n",
    ],
    ["empty major", "lock:\t1: FLOCK  ADVISORY  WRITE 0 :3e:3686654 0 EOF\n"],
    [
      "ino with a leading zero",
      "lock:\t1: FLOCK  ADVISORY  WRITE 0 00:3e:03686654 0 EOF\n",
    ],
    [
      "ino with a suffix",
      "lock:\t1: FLOCK  ADVISORY  WRITE 0 00:3e:3686654x 0 EOF\n",
    ],
    [
      "ino of 2^64 (20 digits)",
      "lock:\t1: FLOCK  ADVISORY  WRITE 0 00:3e:18446744073709551616 0 EOF\n",
    ],
    [
      "ino of 20 nines",
      "lock:\t1: FLOCK  ADVISORY  WRITE 0 00:3e:99999999999999999999 0 EOF\n",
    ],
    [
      "ino of 21 digits",
      "lock:\t1: FLOCK  ADVISORY  WRITE 0 00:3e:100000000000000000000 0 EOF\n",
    ],
    [
      "non-numeric pid",
      "lock:\t1: FLOCK  ADVISORY  WRITE x 00:3e:3686654 0 EOF\n",
    ],
    [
      "plus-signed pid",
      "lock:\t1: FLOCK  ADVISORY  WRITE +1 00:3e:3686654 0 EOF\n",
    ],
    [
      "non-numeric ordinal",
      "lock:\tx: FLOCK  ADVISORY  WRITE 0 00:3e:3686654 0 EOF\n",
    ],
    [
      "no TAB after lock:",
      "lock: 1: FLOCK  ADVISORY  WRITE 0 00:3e:3686654 0 EOF\n",
    ],
    [
      "truncated after the inode",
      "lock:\t1: FLOCK  ADVISORY  WRITE 0 00:3e:3686654\n",
    ],
    ["garbage", "lock:\tgarbage\n"],
    ["POSIX", "lock:\t1: POSIX  ADVISORY  WRITE 31 00:3e:3686654 0 EOF\n"],
    ["OFDLCK", "lock:\t1: OFDLCK ADVISORY  WRITE -1 00:3e:3686654 0 EOF\n"],
    [
      "waiter arrow",
      "lock:\t1: -> FLOCK  ADVISORY  WRITE 0 00:3e:3686654 0 EOF\n",
    ],
  ])("SYNTHETIC: %s is one OTHER entry and never authorizes", (_n, line) => {
    expect(brief(load().parse(line))).toEqual([OTHER]);
    expect(decideText(line)).toEqual(not("LOCK_NOT_OWNED"));
  });

  it("FORMAT CONTRACT: numeric edges are exact (major ffffffff, ino 2^64-1 and 2^53+1 as bigint)", () => {
    const { parse } = load();
    expect(
      brief(parse("lock:\t1: FLOCK  ADVISORY  WRITE 0 ffffffff:3e:1 0 EOF\n")),
    ).toEqual([flock("WRITE", 4294967295, 62, "1")]);
    expect(
      brief(parse("lock:\t1: FLOCK  ADVISORY  WRITE 0 00:ffffffff:1 0 EOF\n")),
    ).toEqual([flock("WRITE", 0, 4294967295, "1")]);
    expect(
      brief(
        parse(
          "lock:\t1: FLOCK  ADVISORY  WRITE 0 00:3e:18446744073709551615 0 EOF\n",
        ),
      ),
    ).toEqual([flock("WRITE", 0, 62, "18446744073709551615")]);
    expect(
      brief(
        parse(
          "lock:\t1: FLOCK  ADVISORY  WRITE 0 00:3e:9007199254740993 0 EOF\n",
        ),
      ),
    ).toEqual([flock("WRITE", 0, 62, "9007199254740993")]);
  });

  it("FORMAT CONTRACT: pid and ordinal never change the parse (0, -1, 31, 2147483647 / 1, 9999)", () => {
    const { parse } = load();
    const expected = [flock("WRITE", 0, 62, "3686654")];
    for (const line of [
      "lock:\t1: FLOCK  ADVISORY  WRITE 0 00:3e:3686654 0 EOF\n",
      "lock:\t1: FLOCK  ADVISORY  WRITE 31 00:3e:3686654 0 EOF\n",
      "lock:\t1: FLOCK  ADVISORY  WRITE -1 00:3e:3686654 0 EOF\n",
      "lock:\t1: FLOCK  ADVISORY  WRITE 2147483647 00:3e:3686654 0 EOF\n",
      "lock:\t9999: FLOCK  ADVISORY  WRITE 0 00:3e:3686654 0 EOF\n",
    ])
      expect(brief(parse(line))).toEqual(expected);
  });
});

describe("parseFdinfoLockLines: which lines count (D3)", () => {
  it("metadata lines are ignored: unknown keys and an uppercase Lock: never count", () => {
    const { parse } = load();
    const text =
      OVERLAY_HEADER + "foo:\tbar\nLock: x\nlockx:\t1\n" + OVERLAY_LOCK;
    expect(brief(parse(text))).toEqual([flock("WRITE", 0, 62, "3686654")]);
  });

  it("a lock keyword in the middle of another line is metadata", () => {
    const { parse } = load();
    expect(
      brief(parse("mnt_id:\t136 lock:\t1: FLOCK\n" + OVERLAY_LOCK)),
    ).toEqual([flock("WRITE", 0, 62, "3686654")]);
  });

  it("one entry per lock line, in file order", () => {
    const { parse } = load();
    const text =
      "lock:\t1: FLOCK  ADVISORY  READ 0 00:3e:3686654 0 EOF\n" +
      "lock:\t2: POSIX  ADVISORY  WRITE 31 00:3e:3686654 0 EOF\n" +
      OVERLAY_LOCK;
    expect(brief(parse(text))).toEqual([
      flock("READ", 0, 62, "3686654"),
      OTHER,
      flock("WRITE", 0, 62, "3686654"),
    ]);
  });

  it("a line with leading whitespace is still a lock line, and not a canonical one", () => {
    const { parse } = load();
    const text = " lock:\t1: FLOCK  ADVISORY  WRITE 0 00:3e:3686654 0 EOF\n";
    expect(brief(parse(text))).toEqual([OTHER]);
    expect(brief(parse(text + OVERLAY_LOCK))).toEqual([
      OTHER,
      flock("WRITE", 0, 62, "3686654"),
    ]);
  });

  it("only \\n separates lines: a CRLF text makes the lock line non-canonical", () => {
    const { parse } = load();
    expect(brief(parse(OVERLAY.replace(/\n/g, "\r\n")))).toEqual([OTHER]);
  });

  it("is total: hostile input never throws and stays linear-ish (the jest timeout is the only limit)", () => {
    const { parse, decide } = load();
    const many = "lock:\n".repeat(20000);
    expect(parse(many)).toHaveLength(20000);
    expect(decide(facts({ fdinfo: many }))).toEqual(not("LOCK_NOT_OWNED"));
    const wide = "lock:\t1: FLOCK" + " ".repeat(60000) + "x\n";
    expect(brief(parse(wide))).toEqual([OTHER]);
    expect(() => parse("\u0000\u0000lock:\t\uD800\n")).not.toThrow();
  });

  it("holds no state across calls (a stateful global regexp would fail the alternation)", () => {
    const { parse } = load();
    const a = brief(parse(OVERLAY));
    brief(parse(TMPFS));
    brief(parse(""));
    expect(brief(parse(OVERLAY))).toEqual(a);
    expect(brief(parse(OVERLAY))).toEqual(a);
    expect(a).toEqual([flock("WRITE", 0, 62, "3686654")]);
  });
});

describe("decideLockProof: ownership by exactly one canonical FLOCK WRITE line (D3 table)", () => {
  it("CAPTURED overlay and tmpfs owners are ok", () => {
    const { decide } = load();
    expect(decide(facts())).toEqual(OK);
    expect(
      decide(
        facts({
          fd: { kind: "file", dev: 76n, ino: 6n },
          path: { kind: "file", dev: 76n, ino: 6n },
          fdinfo: TMPFS,
        }),
      ),
    ).toEqual(OK);
  });

  it("FORMAT CONTRACT (LK1 vector): dev 0xffffffffffffffff with line ffffffff:ffffffff:1 and ino 1 is ok, so a positive major and high components are decoded, not just rejected", () => {
    const dev = 0xffffffffffffffffn;
    expect(
      decideText(
        "lock:\t1: FLOCK  ADVISORY  WRITE 0 ffffffff:ffffffff:1 0 EOF\n",
        {
          fd: { kind: "file", dev, ino: 1n },
          path: { kind: "file", dev, ino: 1n },
        },
      ),
    ).toEqual(OK);
  });

  it("the result is exactly {ok:true} or {ok:false, reason} and contains no bigint", () => {
    const { decide } = load();
    expect(Object.keys(decide(facts()))).toEqual(["ok"]);
    const out = decide(facts({ fdinfo: "" }));
    expect(Object.keys(out).sort()).toEqual(["ok", "reason"]);
    expect(JSON.stringify(out)).toBe('{"ok":false,"reason":"LOCK_NOT_OWNED"}');
  });

  it("CAPTURED READ of the observed inodes is not ownership (overlay 3686682 and tmpfs 35)", () => {
    expect(
      decideText("lock:\t1: FLOCK  ADVISORY  READ 0 00:3e:3686682 0 EOF\n", {
        fd: { kind: "file", dev: 62n, ino: 3686682n },
        path: { kind: "file", dev: 62n, ino: 3686682n },
      }),
    ).toEqual(not("LOCK_NOT_OWNED"));
    // SYNTHETIC: the same READ on the fd inode of the owner fixture (a READ never authorizes).
    expect(
      decideText(
        "pos:\t0\nlock:\t1: FLOCK  ADVISORY  READ 0 00:3e:3686654 0 EOF\n",
      ),
    ).toEqual(not("LOCK_NOT_OWNED"));
    expect(
      decideText("lock:\t1: FLOCK  ADVISORY  READ 0 00:4c:35 0 EOF\n", {
        fd: { kind: "file", dev: 76n, ino: 35n },
        path: { kind: "file", dev: 76n, ino: 35n },
      }),
    ).toEqual(not("LOCK_NOT_OWNED"));
  });

  it("DERIVED: an independent FD (the lock line removed) is not ownership, and the naive check would say yes", () => {
    const f = facts({ fdinfo: OVERLAY_HEADER });
    const naive =
      f.fd.kind === "file" && f.path.kind === "file" && f.fd.ino === f.path.ino;
    expect(naive).toBe(true);
    expect(load().decide(f)).toEqual(not("LOCK_NOT_OWNED"));
  });

  it("DERIVED: the flags line is irrelevant (02400000 captured, 0400000 without CLOEXEC)", () => {
    const { decide } = load();
    const noCloexec = OVERLAY.replace("flags:\t02400000", "flags:\t0400000");
    expect(noCloexec).not.toBe(OVERLAY);
    expect(decide(facts({ fdinfo: noCloexec }))).toEqual(OK);
    expect(decide(facts({ fdinfo: OVERLAY }))).toEqual(OK);
  });

  it("FORMAT CONTRACT: pid and ordinal are not authority: the same decision for 0, 31, -1, 2147483647 and ordinals 1, 9999", () => {
    for (const line of [
      "lock:\t1: FLOCK  ADVISORY  WRITE 0 00:3e:3686654 0 EOF\n",
      "lock:\t1: FLOCK  ADVISORY  WRITE 31 00:3e:3686654 0 EOF\n",
      "lock:\t1: FLOCK  ADVISORY  WRITE -1 00:3e:3686654 0 EOF\n",
      "lock:\t1: FLOCK  ADVISORY  WRITE 2147483647 00:3e:3686654 0 EOF\n",
      "lock:\t9999: FLOCK  ADVISORY  WRITE 0 00:3e:3686654 0 EOF\n",
    ])
      expect(decideText(OVERLAY_HEADER + line)).toEqual(OK);
  });

  describe("cardinality: anything but exactly one canonical FLOCK WRITE is not ownership", () => {
    it.each([
      ["0 entries", OVERLAY_HEADER],
      [
        "1 READ of the same inode",
        OVERLAY_HEADER +
          "lock:\t1: FLOCK  ADVISORY  READ 0 00:3e:3686654 0 EOF\n",
      ],
      [
        "1 OTHER (POSIX)",
        OVERLAY_HEADER +
          "lock:\t1: POSIX  ADVISORY  WRITE 31 00:3e:3686654 0 EOF\n",
      ],
      [
        "WRITE + READ of the same inode",
        OVERLAY + "lock:\t2: FLOCK  ADVISORY  READ 0 00:3e:3686654 0 EOF\n",
      ],
      [
        "WRITE + POSIX",
        OVERLAY + "lock:\t2: POSIX  ADVISORY  WRITE 31 00:3e:3686654 0 EOF\n",
      ],
      [
        "WRITE + waiter arrow",
        OVERLAY + "lock:\t1: -> FLOCK  ADVISORY  WRITE 0 00:3e:3686654 0 EOF\n",
      ],
      ["WRITE + garbage lock line", OVERLAY + "lock:\tgarbage\n"],
      ["WRITE + identical WRITE", OVERLAY + OVERLAY_LOCK],
      [
        "right WRITE + WRITE of another inode",
        OVERLAY + "lock:\t2: FLOCK  ADVISORY  WRITE 0 00:3e:3686655 0 EOF\n",
      ],
      [
        "WRITE of another inode + right WRITE",
        OVERLAY_HEADER +
          "lock:\t2: FLOCK  ADVISORY  WRITE 0 00:3e:3686655 0 EOF\n" +
          OVERLAY_LOCK,
      ],
      [
        "a garbage line before the right WRITE",
        OVERLAY_HEADER + "lock:\tgarbage\n" + OVERLAY_LOCK,
      ],
      [
        "WRITE of another inode + READ of the right one",
        OVERLAY_HEADER +
          "lock:\t1: FLOCK  ADVISORY  WRITE 0 00:3e:3686655 0 EOF\nlock:\t2: FLOCK  ADVISORY  READ 0 00:3e:3686654 0 EOF\n",
      ],
      [
        "a leading-space lock line before the right WRITE",
        OVERLAY_HEADER +
          " lock:\t1: FLOCK  ADVISORY  WRITE 0 00:3e:3686654 0 EOF\n" +
          OVERLAY_LOCK,
      ],
    ])("%s", (_n, text) => {
      expect(decideText(text)).toEqual(not("LOCK_NOT_OWNED"));
    });

    it("the whole captured text with CRLF is not ownership", () => {
      expect(decideText(OVERLAY.replace(/\n/g, "\r\n"))).toEqual(
        not("LOCK_NOT_OWNED"),
      );
    });

    it("metadata (unknown key, uppercase Lock:) around the one right line keeps ownership", () => {
      expect(
        decideText(OVERLAY_HEADER + "foo:\tbar\nLock: x\n" + OVERLAY_LOCK),
      ).toEqual(OK);
    });
  });

  describe("the line must match the FD's own identity (only ino, only dev and both are wrong)", () => {
    it("SYNTHETIC: the fd and the path move together (ino 3686655) while the line says 3686654", () => {
      expect(
        decideText(OVERLAY, {
          fd: { kind: "file", dev: 62n, ino: 3686655n },
          path: { kind: "file", dev: 62n, ino: 3686655n },
        }),
      ).toEqual(not("LOCK_NOT_OWNED"));
    });

    it("SYNTHETIC: the fd and the path move together to dev 63n (00:3f) with the same inode", () => {
      expect(
        decideText(OVERLAY, {
          fd: { kind: "file", dev: 63n, ino: 3686654n },
          path: { kind: "file", dev: 63n, ino: 3686654n },
        }),
      ).toEqual(not("LOCK_NOT_OWNED"));
    });

    it("SYNTHETIC: a device that is not a uint64 cannot be decoded, so nothing matches", () => {
      for (const dev of [-1n, 2n ** 64n]) {
        expect(
          decideText(OVERLAY, {
            fd: { kind: "file", dev, ino: 3686654n },
            path: { kind: "file", dev, ino: 3686654n },
          }),
        ).toEqual(not("LOCK_NOT_OWNED"));
      }
    });

    it("SYNTHETIC: a major that differs only in its high part does not match (00:3e vs 1:3e)", () => {
      expect(
        decideText(OVERLAY, {
          fd: { kind: "file", dev: 0x13en, ino: 3686654n },
          path: { kind: "file", dev: 0x13en, ino: 3686654n },
        }),
      ).toEqual(not("LOCK_NOT_OWNED"));
    });

    it("SYNTHETIC: ino is compared as a bigint: 2^53+1 does not match a line saying 2^53 (Number would)", () => {
      const line = (ino: string) =>
        `lock:\t1: FLOCK  ADVISORY  WRITE 0 00:3e:${ino} 0 EOF\n`;
      const at = (ino: bigint) => ({
        fd: { kind: "file", dev: 62n, ino } as const,
        path: { kind: "file", dev: 62n, ino } as const,
      });
      expect(
        decideText(line("9007199254740992"), at(9007199254740993n)),
      ).toEqual(not("LOCK_NOT_OWNED"));
      expect(
        decideText(line("9007199254740993"), at(9007199254740993n)),
      ).toEqual(OK);
      expect(
        decideText(line("18446744073709551615"), at(2n ** 64n - 1n)),
      ).toEqual(OK);
    });
  });

  describe("reasons and their order (first failure wins)", () => {
    const missing = { kind: "missing" } as const;
    it("lockFd null is NO_LOCK_FD even when everything else is invalid", () => {
      expect(
        load().decide(
          facts({
            lockFd: null,
            platform: "other",
            fd: { kind: "other" },
            path: missing,
            fdinfo: null,
          }),
        ),
      ).toEqual(not("NO_LOCK_FD"));
    });

    it("a non-linux platform is NO_FDINFO, whatever the FD, the path or the text", () => {
      const { decide } = load();
      for (const fdinfo of [null, OVERLAY, "garbage"])
        expect(
          decide(
            facts({
              platform: "other",
              fd: { kind: "other" },
              path: missing,
              fdinfo,
            }),
          ),
        ).toEqual(not("NO_FDINFO"));
    });

    it("CAPTURED: an FD that is not a regular file (eventpoll, dev 15n ino 32n as 'other') is FD_NOT_LOCKFILE before the path", () => {
      expect(
        load().decide(
          facts({ fd: { kind: "other" }, path: missing, fdinfo: null }),
        ),
      ).toEqual(not("FD_NOT_LOCKFILE"));
    });

    it.each(["missing", "symlink", "other"] as const)(
      "a %s path is BAD_ROOT before any comparison or text",
      (kind) => {
        expect(load().decide(facts({ path: { kind }, fdinfo: null }))).toEqual(
          not("BAD_ROOT"),
        );
      },
    );

    it("SYNTHETIC vector (inodes and dev 65025n echo harness metadata, not a proof of any real major != 0 nor of the Fly volume): fd and path on different inodes is FD_NOT_LOCKFILE before the text", () => {
      const { decide } = load();
      expect(
        decide(
          facts({
            fd: { kind: "file", dev: 65025n, ino: 3686644n },
            path: { kind: "file", dev: 65025n, ino: 3686654n },
            fdinfo: null,
          }),
        ),
      ).toEqual(not("FD_NOT_LOCKFILE"));
    });

    it("the same inode on a different device is FD_NOT_LOCKFILE too", () => {
      expect(
        load().decide(
          facts({
            fd: { kind: "file", dev: 62n, ino: 3686654n },
            path: { kind: "file", dev: 63n, ino: 3686654n },
            fdinfo: null,
          }),
        ),
      ).toEqual(not("FD_NOT_LOCKFILE"));
    });

    it("a missing text on Linux is NO_FDINFO, while an empty or garbage text is LOCK_NOT_OWNED", () => {
      const { decide } = load();
      expect(decide(facts({ fdinfo: null }))).toEqual(not("NO_FDINFO"));
      expect(decide(facts({ fdinfo: "" }))).toEqual(not("LOCK_NOT_OWNED"));
      expect(decide(facts({ fdinfo: "garbage\n" }))).toEqual(
        not("LOCK_NOT_OWNED"),
      );
    });
  });

  describe("lockFd guard (D2a): a safe integer of at least 3", () => {
    const CASES: Array<[string, number | null, string | undefined]> = [
      ["null", null, undefined],
      ["NaN", NaN, "NaN"],
      ["Infinity", Infinity, "Infinity"],
      ["-Infinity", -Infinity, "-Infinity"],
      ["-1", -1, "-1"],
      ["0", 0, "0"],
      ["1", 1, "1"],
      ["2", 2, "2"],
      ["2.5", 2.5, "2.5"],
      ["2^53", 2 ** 53, "9007199254740992"],
      ["Number.MAX_VALUE", Number.MAX_VALUE, "1.7976931348623157e+308"],
    ];
    const ENV = {
      IMPORT_VAULT_ENABLED: "true",
      VAULT_DIR: "/srv/import-vault",
      IMPORT_VAULT_IDLE_TIMEOUT_MS: "30000",
      IMPORT_VAULT_HEADROOM_BYTES: "268435456",
    };

    it.each(CASES)(
      "%s is NO_LOCK_FD here and NO_LOCK_FD in parseVaultConfig",
      (_n, value, text) => {
        expect(load().decide(facts({ lockFd: value }))).toEqual(
          not("NO_LOCK_FD"),
        );
        const env: NodeJS.ProcessEnv = { ...ENV };
        if (text !== undefined) env.IMPORT_VAULT_LOCK_FD = text;
        expect(parseVaultConfig(env)).toEqual({
          configured: false,
          reason: "NO_LOCK_FD",
        });
      },
    );

    it.each([
      [3, "3"],
      [9, "9"],
    ])(
      "%s passes the guard here and configures in parseVaultConfig",
      (value, text) => {
        expect(load().decide(facts({ lockFd: value }))).toEqual(OK);
        expect(
          parseVaultConfig({ ...ENV, IMPORT_VAULT_LOCK_FD: text }),
        ).toEqual({
          configured: true,
          rootDir: "/srv/import-vault",
          lockFd: value,
          idleTimeoutMs: 30000,
          headroomBytes: 268435456,
        });
      },
    );
  });

  describe("purity", () => {
    it("deep-frozen facts are accepted, never mutated, and the decision is repeatable", () => {
      const { decide } = load();
      const input = frozen(facts());
      expect(decide(input)).toEqual(OK);
      expect(decide(input)).toEqual(OK);
      expect(input.fd).toEqual({ kind: "file", dev: 62n, ino: 3686654n });
      const bad = frozen(facts({ fdinfo: "" }));
      expect(decide(bad)).toEqual(not("LOCK_NOT_OWNED"));
      expect(decide(bad)).toEqual(not("LOCK_NOT_OWNED"));
    });

    it("alternating owner and non-owner facts never leaks state between calls", () => {
      const { decide } = load();
      const owner = facts();
      const other = facts({ fdinfo: OVERLAY_HEADER });
      expect([
        decide(owner),
        decide(other),
        decide(owner),
        decide(other),
      ]).toEqual([OK, not("LOCK_NOT_OWNED"), OK, not("LOCK_NOT_OWNED")]);
    });
  });
});

/**
 * Static guard for the future implementation (R10). It reads the TypeScript AST, so a forbidden
 * word inside a comment or a string does not trip it, while a real use does. It passes today
 * (vault-lock.ts has only the decoder) and exists to keep the proof pure.
 */
function impurities(source: string): string[] {
  const file = ts.createSourceFile(
    "x.ts",
    source,
    ts.ScriptTarget.ES2022,
    true,
  );
  const found: string[] = [];
  const FORBIDDEN = new Set([
    "Date",
    "process",
    "setTimeout",
    "setInterval",
    "setImmediate",
    "queueMicrotask",
    "require",
    "fs",
    "performance",
  ]);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node))
      found.push("import");
    if (ts.isExportDeclaration(node) && node.moduleSpecifier)
      found.push("re-export");
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    )
      found.push("dynamic import");
    if (ts.isIdentifier(node) && FORBIDDEN.has(node.text))
      found.push(node.text);
    if (
      ts.isPropertyAccessExpression(node) &&
      node.expression.getText(file) === "Math" &&
      node.name.text === "random"
    )
      found.push("Math.random");
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe("static purity of vault-lock.ts (R10)", () => {
  it("the scanner sees real impurities and ignores comments and strings", () => {
    expect(
      impurities(
        "// Date process fs setTimeout\nconst a = 'Date.now() require(\"fs\")';",
      ),
    ).toEqual([]);
    expect(impurities("/* process.env */ export const a = 1;")).toEqual([]);
    expect(impurities("const t = Date.now();")).toEqual(["Date"]);
    expect(impurities("import { x } from 'node:fs';")).toContain("import");
    expect(impurities("import type { X } from './y';")).toContain("import");
    expect(impurities("const r = Math.random();")).toContain("Math.random");
    expect(impurities("setTimeout(() => 1, 1);")).toContain("setTimeout");
    expect(impurities("const p = process.env;")).toContain("process");
    expect(impurities("const m = require('x');")).toContain("require");
    expect(impurities("const m = import('x');")).toContain("dynamic import");
  });

  it("vault-lock.ts imports nothing and touches no clock, process, timer, randomness or fs", () => {
    const source = readFileSync(join(__dirname, "vault-lock.ts"), "utf8");
    expect(impurities(source)).toEqual([]);
  });
});
