// The database guard must run before PrismaClient is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../../../scripts/test-db-env.cjs");

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  cleanupImportWorld,
  createBody,
  seedImportWorld,
  seedSession,
  type ImportWorld,
} from "../../../test-utils/import-session-harness";
import {
  bootVaultApp,
  connectVaultTestDatabase,
  vaultTestDatabaseIsSafe,
  canonicalDir,
  contentPath,
  fileSeed,
  fullDigest,
  MIB,
  pdfBytes,
  putContent,
  readStoredBlob,
  RECOVERY_ORIGIN,
  rawSocket,
  refsOf,
  reserve,
  seedRef,
  sha256Hex,
  spyVaultOpen,
  storedMode,
  UI_HEADERS,
  CANONICAL_VAULT,
  wire,
  type RecoveryApp,
} from "../../../test-utils/import-session-vault-harness";

/**
 * B2a RED (V58/V61/V62/V68): the framing middleware behaves, in an app mounted like main.ts
 * (cookieParser, pipes, enableCors, THEN the shared registerImportUploadFraming(app), all before
 * listen), differently from the controller alone in exactly the ways the design requires, and
 * gives the SAME verdict as the controller for every header-syntax case (one rule, no fork).
 * The harness loads the helper lazily and skips it while it does not exist; every assertion below
 * needs the middleware, so an absent helper is a red assertion, never a silent pass.
 *
 * Linux-only (declared gate, not faked here): socket teardown timing under Node 20 on Fly.
 */
const PREFIX = "imp-b2a-framing";
const setup = new PrismaClient();
let world: ImportWorld;
let framed: RecoveryApp; // main.ts order: CORS, then the shared helper
let bare: RecoveryApp; // controller only (no helper)
let storageRoot: string;
let token: string;
jest.setTimeout(120_000);

const unsupported = wire("UNSUPPORTED_DOCUMENT");
const invalid = wire("INVALID_INPUT");
const notFound = wire("NOT_FOUND");
const OTHER_ORIGIN = "https://evil.example";

function requestText(
  method: string,
  path: string,
  headers: Array<[string, string]>,
  body = "",
) {
  const lines = [`${method} ${path} HTTP/1.1`, "Host: 127.0.0.1"];
  for (const [name, value] of headers) lines.push(`${name}: ${value}`);
  return `${lines.join("\r\n")}\r\n\r\n${body}`;
}
const auth = (): Array<[string, string]> => [
  ["Authorization", `Bearer ${token}`],
  ["Origin", RECOVERY_ORIGIN],
  ["x-rf-import-ui", "1"],
];
const wireOf = (text: string) => {
  const raw = text.slice(text.indexOf("\r\n\r\n") + 4);
  // chunked bodies from Express carry size lines; take the JSON object.
  const match = /\{[\s\S]*\}/.exec(raw);
  return match ? JSON.parse(match[0]) : null;
};
const headerOf = (text: string, name: string) =>
  new RegExp(`^${name}: (.*)$`, "im")
    .exec(text.split("\r\n\r\n")[0]!)?.[1]
    ?.trim();

async function ownedRef(declaredBytes = 1000) {
  const session = await seedSession(setup, world, {
    ownerUserId: world.users.restricted.id,
  });
  const id = await seedRef(setup, session, world.users.restricted, {
    declaredBytes,
  });
  return { session, id, path: contentPath(session.id, id) };
}

describe("B2a slice 1 — upload framing in the bootstrap-mounted app (C2, V58/V61/V62/V68)", () => {
  beforeAll(async () => {
    await connectVaultTestDatabase(setup);
    world = await seedImportWorld(setup, PREFIX);
    storageRoot = canonicalDir(
      await mkdtemp(join(tmpdir(), "rf-b2a-framing-")),
    );
    framed = await bootVaultApp(setup, {
      writes: true,
      vault: CANONICAL_VAULT,
      framing: true,
      vaultDir: storageRoot,
    });
    bare = await bootVaultApp(setup, {
      writes: true,
      vault: CANONICAL_VAULT,
      vaultDir: storageRoot,
    });
    token = await framed.tokenFor(world.users.restricted);
  });
  afterAll(async () => {
    await framed?.close();
    await bare?.close();
    if (vaultTestDatabaseIsSafe(setup)) await cleanupImportWorld(setup, PREFIX);
    await setup.$disconnect();
    await rm(storageRoot, { recursive: true, force: true });
  });

  describe("the middleware refuses before Nest's body parser runs", () => {
    it("MALFORMED JSON on the content route is the application's 422, not the parser's 400 (the parser never ran)", async () => {
      const target = await ownedRef();
      const before = await fullDigest(setup, target.session.id);
      const reply = await rawSocket(
        framed,
        requestText(
          "PUT",
          target.path,
          [
            ...auth(),
            ["Content-Type", "application/json"],
            ["Content-Length", "3"],
          ],
          "{x}",
        ),
      );
      expect([reply.status, wireOf(reply.text)]).toEqual([422, unsupported]);
      expect(await fullDigest(setup, target.session.id)).toEqual(before);
    });

    it("a 200 KB valid JSON body is refused with 422 without being consumed, and the ref is untouched", async () => {
      const target = await ownedRef();
      const before = await fullDigest(setup, target.session.id);
      const big = JSON.stringify({ pad: "x".repeat(200 * 1024) });
      const reply = await rawSocket(
        framed,
        requestText(
          "PUT",
          target.path,
          [
            ...auth(),
            ["Content-Type", "application/json"],
            ["Content-Length", String(Buffer.byteLength(big))],
          ],
          big,
        ),
      );
      expect([reply.status, wireOf(reply.text)]).toEqual([422, unsupported]);
      expect(await fullDigest(setup, target.session.id)).toEqual(before);
    });

    it.each([
      ["a trailing slash", (p: string) => `${p}/`],
      [
        "upper-case path segments (Express is case-insensitive)",
        (p: string) => p.toUpperCase(),
      ],
      ["a query string", (p: string) => `${p}?x=1`],
    ])("the same refusal holds with %s", async (_name, vary) => {
      const target = await ownedRef();
      const reply = await rawSocket(
        framed,
        requestText(
          "PUT",
          vary(target.path),
          [
            ...auth(),
            ["Content-Type", "application/json"],
            ["Content-Length", "2"],
          ],
          "{}",
        ),
      );
      expect([reply.status, wireOf(reply.text)]).toEqual([422, unsupported]);
    });

    it("the neighbouring JSON routes keep their parser: reserve accepts its JSON, create keeps working", async () => {
      const jsonWorld = await seedImportWorld(setup, "b2a-framing-json");
      const jsonToken = await framed.tokenFor(jsonWorld.users.restricted);
      const session = await seedSession(setup, jsonWorld, {
        ownerUserId: jsonWorld.users.restricted.id,
      });
      const reserved = await reserve(framed, jsonToken, session.id, [
        fileSeed(),
      ]);
      expect(reserved.status).toBe(200);
      const activeWhere = {
        tenantId: jsonWorld.tenantId,
        state: { notIn: ["APPLIED", "CANCELLED", "EXPIRED"] },
        expiresAt: { gt: framed.clock.now() },
      };
      const ownerWhere = {
        ...activeWhere,
        ownerUserId: jsonWorld.users.restricted.id,
      };
      const before = {
        activeWhere,
        ownerWhere,
        activeTenant: await setup.importSession.count({ where: activeWhere }),
        activeOwner: await setup.importSession.count({ where: ownerWhere }),
        ownerRows: await setup.importSession.findMany({
          where: {
            tenantId: jsonWorld.tenantId,
            ownerUserId: jsonWorld.users.restricted.id,
          },
          select: {
            id: true,
            tenantId: true,
            ownerUserId: true,
            state: true,
            expiresAt: true,
            closedAt: true,
          },
          orderBy: { id: "asc" },
        }),
      };
      const created = await framed.call("POST", "/import-sessions", {
        token: jsonToken,
        headers: UI_HEADERS,
        body: createBody(jsonWorld.cards.pessoal),
      });
      const evidence = process.env.VAULT_ATTACHMENT_TEST_EVIDENCE_DIR;
      if (evidence)
        await writeFile(
          join(evidence, "framing-create.json"),
          JSON.stringify({ before, response: created }, null, 2),
          { mode: 0o600 },
        );
      expect([200, 201]).toContain(created.status);
      expect(before.activeOwner).toBe(1);
      expect(before.activeTenant).toBe(1);
      expect(await setup.importSession.count({ where: ownerWhere })).toBe(2);
    });
  });

  describe("the closed framing map: middleware and controller give ONE verdict (V61)", () => {
    const table: Array<[string, Array<[string, string]>, number, unknown]> = [
      ["no Content-Type", [["Content-Length", "1000"]], 422, unsupported],
      [
        "multipart",
        [
          ["Content-Type", "multipart/form-data; boundary=x"],
          ["Content-Length", "1000"],
        ],
        422,
        unsupported,
      ],
      [
        "octet-stream with parameters",
        [
          ["Content-Type", "application/octet-stream; charset=x"],
          ["Content-Length", "1000"],
        ],
        422,
        unsupported,
      ],
      [
        "Transfer-Encoding: chunked",
        [
          ["Content-Type", "application/octet-stream"],
          ["Transfer-Encoding", "chunked"],
        ],
        400,
        invalid,
      ],
      [
        "Content-Encoding: gzip",
        [
          ["Content-Type", "application/octet-stream"],
          ["Content-Encoding", "gzip"],
          ["Content-Length", "1000"],
        ],
        400,
        invalid,
      ],
      [
        "Content-Length: 0",
        [
          ["Content-Type", "application/octet-stream"],
          ["Content-Length", "0"],
        ],
        400,
        invalid,
      ],
      [
        "Content-Length over 10 MiB",
        [
          ["Content-Type", "application/octet-stream"],
          ["Content-Length", String(10 * MIB + 1)],
        ],
        400,
        invalid,
      ],
      [
        "Content-Length absent (no body framing at all)",
        [["Content-Type", "application/octet-stream"]],
        400,
        invalid,
      ],
    ];
    it.each(table)(
      "%s => the same status and wire error from both apps",
      async (_name, headers, status, expected) => {
        const target = await ownedRef();
        for (const app of [framed, bare]) {
          const reply = await rawSocket(
            app,
            requestText("PUT", target.path, [...auth(), ...headers]),
          );
          expect([reply.status, wireOf(reply.text)]).toEqual([
            status,
            expected,
          ]);
        }
        expect(await refsOf(setup, target.session.id)).toHaveLength(1);
      },
    );

    it("Content-Encoding: identity is NOT a framing error: the request goes on and reaches ownership (unknown session => the opaque 404)", async () => {
      const reply = await rawSocket(
        framed,
        requestText(
          "PUT",
          contentPath(randomUUID(), randomUUID()),
          [
            ...auth(),
            ["Content-Type", "application/octet-stream"],
            ["Content-Encoding", "identity"],
            ["Content-Length", "1000"],
          ],
          "x".repeat(1000),
        ),
      );
      expect([reply.status, wireOf(reply.text)]).toEqual([404, notFound]);
    });

    it("the exact 10 MiB limit is accepted: a 10485760-byte upload completes (200)", async () => {
      const target = await ownedRef(10 * MIB);
      const payload = pdfBytes(10 * MIB, "limit");
      const opened: string[] = [];
      const spy = spyVaultOpen(storageRoot, (refId) => opened.push(refId));
      let reply;
      try {
        reply = await putContent(framed, target.session.id, target.id, {
          token,
          body: payload,
        });
      } finally {
        spy.mockRestore();
      }
      expect(reply.status).toBe(200);
      // anti-vacuum: the writer really opened its temporary file under the vault root.
      expect(opened).toContain(target.id);
      // the durable proof: the artifact of THESE bytes, and the bytes really on disk.
      const [ref] = await refsOf(setup, target.session.id);
      expect(ref).toMatchObject({ state: "ATTACHED", reservedBytes: 0 });
      const artifact = await setup.importArtifact.findUniqueOrThrow({
        where: { id: ref!.artifactId! },
      });
      expect(artifact).toMatchObject({
        documentSha256: sha256Hex(payload),
        verifiedBytes: payload.length,
      });
      const onDisk = await readStoredBlob(storageRoot, artifact.storageKey!);
      expect(onDisk.length).toBe(payload.length);
      expect(sha256Hex(onDisk)).toBe(sha256Hex(payload));
      expect(sha256Hex(onDisk)).toBe(artifact.documentSha256);
      expect(await storedMode(storageRoot, artifact.storageKey!)).toBe(0o600);
    });

    it.each([
      ["a signed length", "+5"],
      ["exponent notation", "1e3"],
      ["hexadecimal", "0x10"],
    ])(
      "characterisation: %s is refused by Node's own parser (400) before any application code, so no application shape is asserted",
      async (_name, value) => {
        const target = await ownedRef();
        const reply = await rawSocket(
          framed,
          requestText("PUT", target.path, [
            ...auth(),
            ["Content-Type", "application/octet-stream"],
            ["Content-Length", value],
          ]),
        );
        expect(reply.status).toBe(400);
        expect(await refsOf(setup, target.session.id)).toHaveLength(1);
      },
    );

    it("characterisation: duplicated Content-Length is refused by Node's parser (400)", async () => {
      const target = await ownedRef();
      const reply = await rawSocket(
        framed,
        requestText(
          "PUT",
          target.path,
          [
            ...auth(),
            ["Content-Type", "application/octet-stream"],
            ["Content-Length", "5"],
            ["Content-Length", "5"],
          ],
          "12345",
        ),
      );
      expect(reply.status).toBe(400);
    });
  });

  describe("one rule, two call points (V71 identity)", () => {
    // The controller must call the SAME exported function as the unit spec tests. (The middleware
    // lives in the same module, where a spy cannot always see a local call: its equality is
    // proved by the parity table above, which runs the same headers through both apps.)
    function loadModule(): {
      validateImportUploadFraming: (...a: unknown[]) => unknown;
    } {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require("./vault-framing");
    }
    const hostile = (): Array<[string, string]> => [
      ...auth(),
      ["Content-Type", "application/json"],
      ["Content-Length", "2"],
    ];

    it("the controller of an app WITHOUT the middleware runs the real validator first, gets the refusal, and touches nothing", async () => {
      let spy: jest.SpyInstance | undefined;
      try {
        spy = jest.spyOn(loadModule(), "validateImportUploadFraming");
      } catch {
        spy = undefined; // module absent: RED below
      }
      expect(spy).toBeDefined();
      const target = await ownedRef();
      const before = await fullDigest(setup, target.session.id);
      try {
        const reply = await rawSocket(
          bare,
          requestText("PUT", target.path, hostile(), "{}"),
        );
        expect([reply.status, wireOf(reply.text)]).toEqual([422, unsupported]);
        expect(spy!).toHaveBeenCalledTimes(1);
        expect(spy!.mock.results[0]!.value).toEqual({
          ok: false,
          code: "UNSUPPORTED_DOCUMENT",
        });
        expect(await fullDigest(setup, target.session.id)).toEqual(before);
      } finally {
        spy?.mockRestore();
      }
    });
  });

  describe("a refusal carries the CORS headers exactly as main.ts orders them (V68)", () => {
    const bad = (origin: string): Array<[string, string]> => [
      ["Authorization", `Bearer ${token}`],
      ["Origin", origin],
      ["x-rf-import-ui", "1"],
      ["Content-Type", "application/json"],
      ["Content-Length", "2"],
    ];
    it("an allowed Origin reads the 422 (Access-Control-Allow-Origin + credentials)", async () => {
      const target = await ownedRef();
      const reply = await rawSocket(
        framed,
        requestText("PUT", target.path, bad(RECOVERY_ORIGIN), "{}"),
      );
      expect(reply.status).toBe(422);
      expect(headerOf(reply.text, "access-control-allow-origin")).toBe(
        RECOVERY_ORIGIN,
      );
      expect(headerOf(reply.text, "access-control-allow-credentials")).toBe(
        "true",
      );
    });

    it("a disallowed Origin gets the same refusal WITHOUT any CORS grant", async () => {
      const target = await ownedRef();
      const reply = await rawSocket(
        framed,
        requestText("PUT", target.path, bad(OTHER_ORIGIN), "{}"),
      );
      expect(reply.status).toBe(422);
      expect(
        headerOf(reply.text, "access-control-allow-origin"),
      ).toBeUndefined();
    });
  });

  describe("the socket is torn down after a 4xx while the client keeps sending (V62; a macOS run is a smoke check only: the Linux/Node 20 behaviour under Fly is a declared gate, not proven here)", () => {
    const chunk = () => Buffer.alloc(64 * 1024, 0x41);
    it("after the middleware's 422", async () => {
      const target = await ownedRef();
      const reply = await rawSocket(
        framed,
        requestText("PUT", target.path, [
          ...auth(),
          ["Content-Type", "application/json"],
          ["Content-Length", String(5 * MIB)],
        ]),
        { keepSending: chunk, closeWithinMs: 4000 },
      );
      expect(reply.status).toBe(422);
      expect(reply.closedByServer).toBe(true);
      expect(await refsOf(setup, target.session.id)).toHaveLength(1);
    });

    it("after the controller's own 4xx (declared size mismatch), never a 200 and no claim", async () => {
      const target = await ownedRef(1000);
      const before = await fullDigest(setup, target.session.id);
      const reply = await rawSocket(
        framed,
        requestText("PUT", target.path, [
          ...auth(),
          ["Content-Type", "application/octet-stream"],
          ["Content-Length", String(2 * MIB)],
        ]),
        { keepSending: chunk, closeWithinMs: 4000 },
      );
      expect([reply.status, wireOf(reply.text)]).toEqual([400, invalid]);
      expect(reply.closedByServer).toBe(true);
      expect(await fullDigest(setup, target.session.id)).toEqual(before);
    });
  });
});
