// The database guard must run before PrismaClient is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../../../scripts/test-db-env.cjs");

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  cleanupImportWorld,
  createBody,
  FIXED_NOW,
  seedImportWorld,
  seedSession,
  type ImportWorld,
} from "../../../test-utils/import-session-harness";
import {
  seedApplied,
  sessionRow,
} from "../../../test-utils/import-session-recovery-harness";
import {
  bootVaultApp,
  connectVaultTestDatabase,
  vaultTestDatabaseIsSafe,
  canonicalDir,
  fileSeed,
  finishVaultFixture,
  fullDigest,
  getContent,
  pdfBytes,
  readStoredBlob,
  seamHonored,
  sha256Hex,
  putContent,
  RECOVERY_ORIGIN,
  refsOf,
  reservePath,
  reserve,
  seedArtifact,
  seedRef,
  UI_HEADERS,
  CANONICAL_VAULT,
  wire,
  type RecoveryApp,
  type WorldUser,
} from "../../../test-utils/import-session-vault-harness";
import { IMPORT_SESSION_GRANT_VERIFIER } from "../import-session.capability";
import { ImportUiGrantIssuer } from "../import-session-ui-grant";
import type { UiImportPersistenceGrantVerifier } from "../import-session.contract";
import {
  CARD_PURCHASE_BATCH_PORT,
  type CardPurchaseBatchPort,
} from "../card-purchase-batch.port";

/**
 * B2a RED (slice 1: guards + authority). Real PrismaService, JwtStrategy, the four global
 * guards in production order and the real controller graph. The three attachment routes do
 * not exist yet: every red below is a missing route/behaviour (Nest's own 404 body is not an
 * `ImportSessionErrorV1`), never a missing import.
 *
 * C1: the participant/anchor read gate runs right after ownership, BEFORE replay and BEFORE
 * any state/limit error of that session.  C4: the UI guard runs before the grant issuer; the
 * grant is minted from validated request/path values, never from the raw body.
 */
const PREFIX = "imp-b2a-auth";
const setup = new PrismaClient();
let world: ImportWorld;
let api: RecoveryApp;
let tokens: {
  owner: string;
  restricted: string;
  peer: string;
  foreign: string;
};
let storageRoot: string;
jest.setTimeout(180_000);

const notFound = wire("NOT_FOUND");
const invalid = wire("INVALID_INPUT");
const uiRequired = wire("UI_ACTION_REQUIRED");
const disabled = wire("CAPABILITY_DISABLED");

const mkFiles = () => [fileSeed()];
/** DRAFT session of `owner` at revision 1 with one claimable RESERVED ref. */
async function sessionWithRef(owner: WorldUser) {
  const session = await seedSession(setup, world, { ownerUserId: owner.id });
  const refId = await seedRef(setup, session, owner);
  return { session, refId };
}
const octetHeaders = (headers: Record<string, string>) => ({
  ...headers,
  "content-type": "application/octet-stream",
  "content-length": "1000",
});

describe("B2a slice 1 — authority of the attachment routes", () => {
  beforeAll(async () => {
    await connectVaultTestDatabase(setup);
    world = await seedImportWorld(setup, PREFIX);
    storageRoot = canonicalDir(await mkdtemp(join(tmpdir(), "rf-b2a-auth-")));
    api = await bootVaultApp(setup, {
      writes: true,
      vault: CANONICAL_VAULT,
      vaultDir: storageRoot,
    });
    tokens = {
      owner: await api.tokenFor(world.users.owner),
      restricted: await api.tokenFor(world.users.restricted),
      peer: await api.tokenFor(world.users.peer),
      foreign: await api.tokenFor(world.users.foreign),
    };
  });
  afterAll(async () => {
    await api?.close();
    if (vaultTestDatabaseIsSafe(setup)) await cleanupImportWorld(setup, PREFIX);
    await setup.$disconnect();
    await rm(storageRoot, { recursive: true, force: true });
  });

  describe("B1 characterisation (must stay green)", () => {
    it("recovery reads and cancel still work with writes OFF and the vault OFF", async () => {
      const off = await bootVaultApp(setup, {
        writes: false,
        vault: { offReason: "FLAG_OFF" },
      });
      try {
        const token = await off.tokenFor(world.users.restricted);
        const session = await seedSession(setup, world, {
          ownerUserId: world.users.restricted.id,
        });
        const list = await off.call("GET", "/import-sessions", { token });
        expect(list.status).toBe(200);
        const one = await off.call("GET", `/import-sessions/${session.id}`, {
          token,
        });
        expect(one.status).toBe(200);
        expect(one.json.attachments).toEqual([]);
        const cancelled = await off.call(
          "POST",
          `/import-sessions/${session.id}/cancel`,
          { token, headers: UI_HEADERS, body: { expectedRevision: 1 } },
        );
        expect(cancelled.status).toBe(200);
      } finally {
        await off.close();
      }
    });
  });

  describe("identity precedes everything (no existence oracle before auth)", () => {
    it.each([
      [
        "POST reserve",
        () =>
          api.call("POST", reservePath(randomUUID()), {
            headers: UI_HEADERS,
            body: { expectedRevision: 1, files: mkFiles() },
          }),
      ],
      ["PUT content", () => putContent(api, randomUUID(), randomUUID())],
      [
        "GET content",
        () => getContent(api, undefined, randomUUID(), randomUUID()),
      ],
    ])(
      "%s without a JWT is 401 for a session that does not exist",
      async (_name, call) => {
        const reply = await call();
        expect(reply.status).toBe(401);
      },
    );

    it("a malformed bearer is 401 on every route", async () => {
      const bad = "not-a-jwt";
      const replies = await Promise.all([
        reserve(api, bad, randomUUID(), mkFiles()),
        putContent(api, randomUUID(), randomUUID(), { token: bad }),
        getContent(api, bad, randomUUID(), randomUUID()),
      ]);
      expect(replies.map((reply) => reply.status)).toEqual([401, 401, 401]);
    });

    it("a stale sessionVersion (revoked login) is 401, never 404, on every route", async () => {
      const { session, refId } = await sessionWithRef(world.users.restricted);
      await setup.user.update({
        where: { id: world.users.restricted.id },
        data: { sessionVersion: { increment: 1 } },
      });
      try {
        const replies = await Promise.all([
          reserve(api, tokens.restricted, session.id, mkFiles()),
          putContent(api, session.id, refId, { token: tokens.restricted }),
          getContent(api, tokens.restricted, session.id, refId),
        ]);
        expect(replies.map((reply) => reply.status)).toEqual([401, 401, 401]);
      } finally {
        await setup.user.update({
          where: { id: world.users.restricted.id },
          data: { sessionVersion: world.users.restricted.sessionVersion },
        });
      }
    });
  });

  describe("UI guard before the grant issuer (C4)", () => {
    const badHeaders: Array<[string, Record<string, string>]> = [
      ["no Origin", { "x-rf-import-ui": "1" }],
      ["no marker", { origin: RECOVERY_ORIGIN }],
      ["marker 0", { origin: RECOVERY_ORIGIN, "x-rf-import-ui": "0" }],
      [
        "foreign Origin",
        { origin: "http://evil.example", "x-rf-import-ui": "1" },
      ],
      ["null Origin", { origin: "null", "x-rf-import-ui": "1" }],
    ];

    it.each(badHeaders)(
      "%s: POST and PUT are 403 UI_ACTION_REQUIRED, identically for own and unknown sessions, with no grant issued or verified",
      async (_name, headers) => {
        const issuer = api.app.get(ImportUiGrantIssuer, { strict: false });
        const verifier = api.app.get<UiImportPersistenceGrantVerifier>(
          IMPORT_SESSION_GRANT_VERIFIER,
          {
            strict: false,
          },
        );
        const spies: jest.SpyInstance[] = [];
        const received: IncomingMessage["headers"][] = [];
        const observeHeaders = (request: IncomingMessage) => {
          if (request.method === "PUT") received.push({ ...request.headers });
        };
        const server = api.app.getHttpServer();
        try {
          server.on("request", observeHeaders);
          const issue = jest.spyOn(issuer, "issue");
          spies.push(issue);
          const verify = jest.spyOn(verifier, "verify");
          spies.push(verify);
          const { session, refId } = await sessionWithRef(
            world.users.restricted,
          );
          const before = await fullDigest(setup, session.id);
          const replies = [
            await reserve(api, tokens.restricted, session.id, mkFiles(), {
              headers,
            }),
            await reserve(api, tokens.restricted, randomUUID(), mkFiles(), {
              headers,
            }),
            await putContent(api, session.id, refId, {
              token: tokens.restricted,
              bareHeaders: octetHeaders(headers),
            }),
            await putContent(api, randomUUID(), randomUUID(), {
              token: tokens.restricted,
              bareHeaders: octetHeaders(headers),
            }),
          ];
          for (const reply of replies) {
            expect([reply.status, reply.json]).toEqual([403, uiRequired]);
          }
          expect(issue).not.toHaveBeenCalled();
          expect(verify).not.toHaveBeenCalled();
          expect(
            received.map((header) => ({
              origin: header.origin,
              marker: header["x-rf-import-ui"],
            })),
          ).toEqual(
            Array.from({ length: 2 }, () => ({
              origin: headers.origin,
              marker: headers["x-rf-import-ui"],
            })),
          );
          expect(await fullDigest(setup, session.id)).toEqual(before);
        } finally {
          await finishVaultFixture(
            () => server.removeListener("request", observeHeaders),
            ...spies.reverse().map((spy) => () => spy.mockRestore()),
          );
        }
      },
    );

    it("GET content needs no UI header: an unknown ref is the opaque 404, not 403", async () => {
      const reply = await getContent(
        api,
        tokens.restricted,
        randomUUID(),
        randomUUID(),
      );
      expect([reply.status, reply.json]).toEqual([404, notFound]);
    });

    it("the reserve grant is minted from the VALIDATED body and the path, exactly once", async () => {
      const issuer = api.app.get(ImportUiGrantIssuer, { strict: false });
      const issue = jest.spyOn(issuer, "issue");
      try {
        const session = await seedSession(setup, world, {
          ownerUserId: world.users.restricted.id,
        });
        const reply = await reserve(
          api,
          tokens.restricted,
          session.id,
          mkFiles(),
        );
        expect(reply.status).toBe(200);
        expect(issue).toHaveBeenCalledTimes(1);
        expect(issue.mock.calls[0]![2]).toEqual({
          operation: "RESERVE_ATTACHMENTS",
          sessionId: session.id,
          expectedRevision: 1,
        });
        issue.mockClear();
        const rejected = await reserve(
          api,
          tokens.restricted,
          session.id,
          mkFiles(),
          {
            body: {
              expectedRevision: 1,
              files: mkFiles(),
              grant: "x",
              scope: { operation: "CANCEL_SESSION" },
            },
          },
        );
        expect([rejected.status, rejected.json]).toEqual([400, invalid]);
        expect(issue).not.toHaveBeenCalled();
      } finally {
        issue.mockRestore();
      }
    });
  });

  describe("opaque 404 for everything the actor may not see (P1 isolation)", () => {
    async function foreignSession() {
      const row = await setup.importSession.create({
        data: sessionRow(world, world.users.foreign.id, 0, {
          tenantId: world.otherTenantId,
          ownerProjectId: world.projects.foreign,
          cardId: world.cards.foreign,
        }) as any,
      });
      return row;
    }

    it("session gates are opaque on all three routes; unknown or cross-session refs on an owned session are opaque on PUT/GET", async () => {
      const mine = await sessionWithRef(world.users.restricted);
      const peers = await sessionWithRef(world.users.peer);
      const owners = await sessionWithRef(world.users.owner);
      const alien = await foreignSession();
      const alienRef = await seedRef(setup, alien, world.users.foreign);
      const artifact = await seedArtifact(setup, peers.session);
      const peerAttached = await seedRef(
        setup,
        peers.session,
        world.users.peer,
        {
          state: "ATTACHED",
          position: 1,
          artifactId: artifact,
          verifiedAt: FIXED_NOW,
        },
      );
      const targets: Array<[string, string, string, string]> = [
        ["peer session", peers.session.id, peers.refId, tokens.restricted],
        ["peer attached", peers.session.id, peerAttached, tokens.restricted],
        ["owner session", owners.session.id, owners.refId, tokens.restricted],
        [
          "OWNER role over restricted",
          mine.session.id,
          mine.refId,
          tokens.owner,
        ],
        ["other tenant session", alien.id, alienRef, tokens.restricted],
        ["other tenant actor", mine.session.id, mine.refId, tokens.foreign],
        ["unknown ids", randomUUID(), randomUUID(), tokens.restricted],
        [
          "my ref on peer path",
          peers.session.id,
          mine.refId,
          tokens.restricted,
        ],
      ];
      const digestsBefore = await Promise.all(
        [mine, peers, owners].map((entry) =>
          fullDigest(setup, entry.session.id),
        ),
      );
      for (const [label, sessionId, refId, token] of targets) {
        const replies = {
          reserve: await reserve(api, token, sessionId, mkFiles()),
          put: await putContent(api, sessionId, refId, { token }),
          get: await getContent(api, token, sessionId, refId),
        };
        for (const [route, reply] of Object.entries(replies)) {
          expect([label, route, reply.status, reply.json]).toEqual([
            label,
            route,
            404,
            notFound,
          ]);
        }
      }
      for (const refId of [randomUUID(), peers.refId, peerAttached]) {
        const replies = [
          await putContent(api, mine.session.id, refId, {
            token: tokens.restricted,
          }),
          await getContent(api, tokens.restricted, mine.session.id, refId),
        ];
        for (const reply of replies)
          expect([reply.status, reply.json]).toEqual([404, notFound]);
      }
      const digestsAfter = await Promise.all(
        [mine, peers, owners].map((entry) =>
          fullDigest(setup, entry.session.id),
        ),
      );
      expect(digestsAfter).toEqual(digestsBefore);
      expect(await refsOf(setup, alien.id)).toHaveLength(1);
    });

    it("authorized own-session reservation adds exactly one new ref; no ref selector belongs to POST", async () => {
      const { session, refId } = await sessionWithRef(world.users.restricted);
      const before = await fullDigest(setup, session.id);
      const file = fileSeed();
      const reply = await reserve(api, tokens.restricted, session.id, [file]);
      expect(reply.status).toBe(200);
      const after = await fullDigest(setup, session.id);
      expect(after.session.revision).toBe(before.session.revision + 1);
      expect(reply.json.revision).toBe(before.session.revision + 1);
      expect(after.session.state).toBe(before.session.state);
      expect(after.session.draftJson).toBe(before.session.draftJson);
      expect(after.refs).toHaveLength(before.refs.length + 1);
      expect(after.refs.find((ref) => ref.id === refId)).toEqual(
        before.refs[0],
      );
      expect(after.refs.find((ref) => ref.id === file.id)).toMatchObject({
        sessionId: session.id,
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        state: "RESERVED",
        declaredBytes: 1000,
        reservedBytes: 1000,
        temporaryStorageKey: `t/${file.id}`,
        artifactId: null,
      });
      expect(
        after.refs.reduce((n, ref) => n + ref.reservedBytes, 0) -
          before.refs.reduce((n, ref) => n + ref.reservedBytes, 0),
      ).toBe(1000);
    });

    it("tenant/owner/project supplied by header, query or body is never an authority selector", async () => {
      const mine = await sessionWithRef(world.users.restricted);
      const alien = await foreignSession();
      const spoof = { ...UI_HEADERS, "x-tenant-id": world.otherTenantId };
      const own = await reserve(
        api,
        tokens.restricted,
        mine.session.id,
        mkFiles(),
        { headers: spoof },
      );
      expect(own.status).toBe(200);
      const other = await reserve(api, tokens.restricted, alien.id, mkFiles(), {
        headers: spoof,
      });
      expect([other.status, other.json]).toEqual([404, notFound]);
      const session = await seedSession(setup, world, {
        ownerUserId: world.users.restricted.id,
      });
      const before = await fullDigest(setup, session.id);
      for (const extra of [
        { tenantId: world.otherTenantId },
        { ownerProjectId: world.projects.casa },
        { projectId: world.projects.casa },
        { sessionId: randomUUID() },
      ]) {
        const topLevel = await reserve(
          api,
          tokens.restricted,
          session.id,
          mkFiles(),
          { body: { expectedRevision: 1, files: mkFiles(), ...extra } },
        );
        expect([topLevel.status, topLevel.json]).toEqual([400, invalid]);
        const perFile = await reserve(api, tokens.restricted, session.id, [
          { ...fileSeed(), ...extra },
        ]);
        expect([perFile.status, perFile.json]).toEqual([400, invalid]);
      }
      expect(await fullDigest(setup, session.id)).toEqual(before);
    });

    it("an extra query key is one uniform 400 on all three routes, with no 403/404 oracle for own, foreign or unknown ids", async () => {
      const mine = await sessionWithRef(world.users.restricted);
      const peers = await sessionWithRef(world.users.peer);
      for (const query of [
        `?projectId=${world.projects.casa}`,
        `?tenantId=${world.otherTenantId}`,
        "?x=1",
      ]) {
        for (const [sessionId, refId] of [
          [mine.session.id, mine.refId],
          [peers.session.id, peers.refId],
          [randomUUID(), randomUUID()],
        ] as const) {
          const replies = [
            await reserve(api, tokens.restricted, sessionId, mkFiles(), {
              query,
            }),
            await putContent(api, sessionId, refId, {
              token: tokens.restricted,
              query,
            }),
            await getContent(api, tokens.restricted, sessionId, refId, query),
          ];
          for (const reply of replies) {
            expect([reply.status, reply.json]).toEqual([400, invalid]);
          }
        }
      }
    });
  });

  describe("authority revoked after the reservation is the same opaque 404", () => {
    it("anchor project revoked from the grant, and the anchor card soft-deleted", async () => {
      const { session, refId } = await sessionWithRef(world.users.restricted);
      const artifact = await seedArtifact(setup, session);
      const attached = await seedRef(setup, session, world.users.restricted, {
        state: "ATTACHED",
        position: 1,
        artifactId: artifact,
        verifiedAt: FIXED_NOW,
      });
      const probe = async () => [
        await reserve(api, tokens.restricted, session.id, mkFiles()),
        await putContent(api, session.id, refId, { token: tokens.restricted }),
        await getContent(api, tokens.restricted, session.id, attached),
      ];
      const grants = world.users.restricted;
      await setup.user.update({
        where: { id: grants.id },
        data: { allowedProjects: JSON.stringify([world.projects.casa]) },
      });
      try {
        for (const reply of await probe()) {
          expect([reply.status, reply.json]).toEqual([404, notFound]);
        }
      } finally {
        await setup.user.update({
          where: { id: grants.id },
          data: { allowedProjects: JSON.stringify([world.projects.pessoal]) },
        });
      }
      await setup.creditCard.update({
        where: { id: world.cards.pessoal },
        data: { deletedAt: new Date(FIXED_NOW.getTime() - 1000) },
      });
      try {
        for (const reply of await probe()) {
          expect([reply.status, reply.json]).toEqual([404, notFound]);
        }
      } finally {
        await setup.creditCard.update({
          where: { id: world.cards.pessoal },
          data: { deletedAt: null },
        });
      }
    });
  });

  describe("kill switches: writes AND vault, before any parse, lookup or write (V38)", () => {
    const REASONS = [
      "FLAG_OFF",
      "NO_LOCK_FD",
      "FD_NOT_LOCKFILE",
      "LOCK_NOT_OWNED",
      "NO_FDINFO",
      "BAD_ROOT",
      "LOCK_REPLACED",
      "FSYNC_CHECK_FAILED",
      "HEADROOM_UNSET",
      "IDLE_TIMEOUT_UNSET",
    ] as const;

    it("the vault seam is really registered by production: an ignored override would make every OFF case below pass vacuously", () => {
      expect(seamHonored(api)).toBe(true);
    });

    it("no vault configuration at all (the shipped default, no override) is OFF: 503 CAPABILITY_DISABLED on the three routes, B1 reads intact", async () => {
      const shipped = await bootVaultApp(setup, {
        writes: true,
        vault: "real",
      });
      try {
        const token = await shipped.tokenFor(world.users.restricted);
        const session = await seedSession(setup, world, {
          ownerUserId: world.users.restricted.id,
        });
        const before = await fullDigest(setup, session.id);
        for (const reply of [
          await reserve(shipped, token, session.id, mkFiles()),
          await putContent(shipped, session.id, randomUUID(), { token }),
          await getContent(shipped, token, session.id, randomUUID()),
        ]) {
          expect([reply.status, reply.json]).toEqual([503, disabled]);
        }
        expect(await fullDigest(setup, session.id)).toEqual(before);
        expect(
          (
            await shipped.call("GET", `/import-sessions/${session.id}`, {
              token,
            })
          ).status,
        ).toBe(200);
      } finally {
        await shipped.close();
      }
    });

    it("vault ON never opens the B1 writes: with writes OFF, create/reserve stay 503 and the session list still reads", async () => {
      const off = await bootVaultApp(setup, {
        writes: false,
        vault: CANONICAL_VAULT,
      });
      try {
        const token = await off.tokenFor(world.users.restricted);
        const created = await off.call("POST", "/import-sessions", {
          token,
          headers: UI_HEADERS,
          body: createBody(world.cards.pessoal),
        });
        expect([created.status, created.json]).toEqual([503, disabled]);
        const session = await seedSession(setup, world, {
          ownerUserId: world.users.restricted.id,
        });
        const reserved = await reserve(off, token, session.id, mkFiles());
        expect([reserved.status, reserved.json]).toEqual([503, disabled]);
        expect(
          (await off.call("GET", "/import-sessions", { token })).status,
        ).toBe(200);
      } finally {
        await off.close();
      }
    });

    it("B1 writes OFF with vault ON: POST/PUT are 503; GET RESERVED and peer are 404, authorized ATTACHED is 200 without a UI grant or financial effect", async () => {
      const off = await bootVaultApp(setup, {
        writes: false,
        vault: CANONICAL_VAULT,
        vaultDir: storageRoot,
      });
      const spies: jest.SpyInstance[] = [];
      try {
        const token = await off.tokenFor(world.users.restricted);
        const session = await seedSession(setup, world, {
          ownerUserId: world.users.restricted.id,
        });
        const refId = await seedRef(setup, session, world.users.restricted);
        const blob = pdfBytes(1000, "writes-off-readable");
        const artifactId = await seedArtifact(setup, session);
        const attached = await seedRef(setup, session, world.users.restricted, {
          state: "ATTACHED",
          artifactId,
          position: 1,
          verifiedAt: FIXED_NOW,
        });
        const artifact = await setup.importArtifact.findUniqueOrThrow({
          where: { id: artifactId },
        });
        const blobPath = join(storageRoot, artifact.storageKey!);
        await mkdir(dirname(blobPath), { recursive: true, mode: 0o700 });
        await writeFile(blobPath, blob, { mode: 0o600 });
        await setup.importArtifact.update({
          where: { id: artifactId },
          data: { documentSha256: sha256Hex(blob) },
        });
        const before = await fullDigest(setup, session.id);
        const financialBefore = await setup.expense.findMany({
          where: { tenantId: world.tenantId },
          orderBy: { id: "asc" },
        });
        const issuer = jest.spyOn(
          off.app.get(ImportUiGrantIssuer, { strict: false }),
          "issue",
        );
        spies.push(issuer);
        const verify = jest.spyOn(
          off.app.get<UiImportPersistenceGrantVerifier>(
            IMPORT_SESSION_GRANT_VERIFIER,
            { strict: false },
          ),
          "verify",
        );
        spies.push(verify);
        const apply = jest.spyOn(
          off.app.get<CardPurchaseBatchPort>(CARD_PURCHASE_BATCH_PORT, {
            strict: false,
          }),
          "applyInTx",
        );
        spies.push(apply);
        const replies = [
          await reserve(off, token, randomUUID(), null, {
            body: { expectedRevision: "garbage", files: 7 },
          }),
          await reserve(off, token, session.id, mkFiles()),
          await putContent(off, session.id, refId, { token }),
          await putContent(off, randomUUID(), randomUUID(), { token }),
        ];
        for (const reply of replies) {
          expect([reply.status, reply.json]).toEqual([503, disabled]);
        }
        const reserved = await getContent(off, token, session.id, refId);
        const peer = await getContent(
          off,
          await off.tokenFor(world.users.peer),
          session.id,
          attached,
        );
        for (const reply of [reserved, peer])
          expect([reply.status, reply.json]).toEqual([404, notFound]);
        const content = await getContent(off, token, session.id, attached);
        expect([content.status, content.text]).toEqual([
          200,
          blob.toString("latin1"),
        ]);
        expect(content.headers["content-length"]).toBe("1000");
        expect(issuer).not.toHaveBeenCalled();
        expect(verify).not.toHaveBeenCalled();
        expect(apply).not.toHaveBeenCalled();
        expect(
          await setup.expense.findMany({
            where: { tenantId: world.tenantId },
            orderBy: { id: "asc" },
          }),
        ).toEqual(financialBefore);
        expect(await fullDigest(setup, session.id)).toEqual(before);
      } finally {
        await finishVaultFixture(
          ...spies.reverse().map((spy) => () => spy.mockRestore()),
          () => off.close(),
        );
      }
    });

    it.each(REASONS)(
      "writes ON + vault OFF (%s): reserve, upload and content are 503, no ref, no revision, B1 read intact",
      async (reason) => {
        const off = await bootVaultApp(setup, {
          writes: true,
          vault: { offReason: reason },
        });
        try {
          const token = await off.tokenFor(world.users.restricted);
          const session = await seedSession(setup, world, {
            ownerUserId: world.users.restricted.id,
          });
          const before = await fullDigest(setup, session.id);
          const replies = [
            await reserve(off, token, session.id, mkFiles()),
            await putContent(off, session.id, randomUUID(), { token }),
            await getContent(off, token, session.id, randomUUID()),
          ];
          for (const reply of replies) {
            expect([reply.status, reply.json]).toEqual([503, disabled]);
          }
          expect(await fullDigest(setup, session.id)).toEqual(before);
          const read = await off.call("GET", `/import-sessions/${session.id}`, {
            token,
          });
          expect(read.status).toBe(200);
        } finally {
          await off.close();
        }
      },
    );
  });

  describe("C1 — one read gate, right after ownership and before replay or any state error", () => {
    async function appliedWithAttachment(hiddenParticipant: boolean) {
      const owner = world.users.restricted;
      const applied = await seedApplied(setup, world, {
        owner,
        participants: [
          {
            sourceProjectId: world.projects.pessoal,
            targets: hiddenParticipant
              ? [{ projectId: world.projects.casa, amountCents: 10_000 }]
              : [],
          },
        ],
      });
      const session = {
        id: applied.id,
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
      };
      const artifact = await seedArtifact(setup, session);
      const file = fileSeed({ fileName: "fatura.pdf", declaredBytes: 1000 });
      await seedRef(setup, session, owner, {
        id: file.id,
        state: "ATTACHED",
        artifactId: artifact,
        verifiedAt: FIXED_NOW,
      });
      return { session, file };
    }

    it("APPLIED with a participant outside the ACL: POST replay/new/mixed/different tuple, PUT on a RESERVED/ATTACHED/RELEASED/FAILED ref and GET content are the SAME 404 as an unknown session, with no grant spent", async () => {
      const { session, file } = await appliedWithAttachment(true);
      const others = [
        await seedRef(setup, session, world.users.restricted, { position: 1 }),
        await seedRef(setup, session, world.users.restricted, {
          position: 2,
          state: "RELEASED",
          generation: 2,
          releasedAt: FIXED_NOW,
          temporaryStorageKey: null,
        }),
        await seedRef(setup, session, world.users.restricted, {
          position: 3,
          state: "FAILED",
          generation: 3,
          temporaryStorageKey: null,
          leaseExpiresAt: null,
        }),
      ];
      const verifier = api.app.get(IMPORT_SESSION_GRANT_VERIFIER, {
        strict: false,
      });
      const verify = jest.spyOn(verifier as never, "verify");
      try {
        const before = await fullDigest(setup, session.id);
        const unknown = await reserve(api, tokens.restricted, randomUUID(), [
          file,
        ]);
        expect([unknown.status, unknown.json]).toEqual([404, notFound]);
        const replies = [
          await reserve(api, tokens.restricted, session.id, [file]),
          await reserve(api, tokens.restricted, session.id, [fileSeed()]),
          await reserve(api, tokens.restricted, session.id, [file, fileSeed()]),
          await reserve(api, tokens.restricted, session.id, [
            { ...file, declaredBytes: 999 },
          ]),
          ...(await Promise.all(
            [file.id, ...others].map((id) =>
              putContent(api, session.id, id, { token: tokens.restricted }),
            ),
          )),
          await getContent(api, tokens.restricted, session.id, file.id),
        ];
        for (const reply of replies) {
          expect([reply.status, reply.json, reply.text]).toEqual([
            404,
            notFound,
            unknown.text,
          ]);
        }
        expect(verify).not.toHaveBeenCalled();
        expect(await fullDigest(setup, session.id)).toEqual(before);
      } finally {
        verify.mockRestore();
      }
    });

    it("control: the same APPLIED session with a visible participant reads (200) but never mutates, and its errors are the state errors", async () => {
      const { session, file } = await appliedWithAttachment(false);
      const before = await fullDigest(setup, session.id);
      const replay = await reserve(api, tokens.restricted, session.id, [file], {
        expectedRevision: 77,
      });
      expect(replay.status).toBe(200);
      expect(replay.json).toMatchObject({ id: session.id, state: "APPLIED" });
      const fresh = await reserve(api, tokens.restricted, session.id, [
        fileSeed(),
      ]);
      expect([fresh.status, fresh.json.code]).toEqual([409, "LEASE_CONFLICT"]);
      const mixed = await reserve(api, tokens.restricted, session.id, [
        file,
        fileSeed(),
      ]);
      expect([mixed.status, mixed.json.code]).toEqual([
        409,
        "IDEMPOTENCY_CONFLICT",
      ]);
      const changed = await reserve(api, tokens.restricted, session.id, [
        { ...file, declaredBytes: 999 },
      ]);
      expect([changed.status, changed.json.code]).toEqual([
        409,
        "IDEMPOTENCY_CONFLICT",
      ]);
      const put = await putContent(api, session.id, file.id, {
        token: tokens.restricted,
      });
      expect([put.status, put.json.code]).toEqual([409, "LEASE_CONFLICT"]);
      expect(await fullDigest(setup, session.id)).toEqual(before);
    });

    describe("GET content: what a visible participant of a retained artifact is served (design 2.3)", () => {
      async function servedFile(
        bytes: Buffer,
        artifactPatch: Record<string, unknown> = {},
      ) {
        const { session, file } = await appliedWithAttachment(false);
        const [ref] = await refsOf(setup, session.id);
        const artifact = await setup.importArtifact.findUniqueOrThrow({
          where: { id: ref!.artifactId! },
        });
        const path = join(storageRoot, artifact.storageKey!);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes);
        await setup.importArtifact.update({
          where: { id: artifact.id },
          data: { verifiedBytes: bytes.length, ...artifactPatch },
        });
        return { session, file };
      }

      it("200 with the stored bytes and the closed header set: octet-stream, attachment with the sanitized name, nosniff, private no-store, Content-Length = verified_bytes", async () => {
        const pdf = pdfBytes(1000, "stored");
        const { session, file } = await servedFile(pdf);
        const reply = await getContent(
          api,
          tokens.restricted,
          session.id,
          file.id,
        );
        expect(reply.status).toBe(200);
        expect(reply.text).toBe(pdf.toString("latin1"));
        expect(reply.headers["content-type"]).toBe("application/octet-stream");
        expect(reply.headers["x-content-type-options"]).toBe("nosniff");
        expect(reply.headers["cache-control"]).toBe("private, no-store");
        expect(reply.headers["content-length"]).toBe("1000");
        const disposition = String(reply.headers["content-disposition"]);
        expect(disposition).toMatch(/^attachment;/);
        expect(disposition).toContain("filename*=UTF-8''fatura.pdf");
        expect(disposition).not.toMatch(/[\r\n]/);
      });

      it.each(["RAW_READY", "ANALYZING", "EXTRACTED", "FAILED"])(
        "an artifact in %s with a valid storage key is served (200)",
        async (state) => {
          const { session, file } = await servedFile(pdfBytes(1000, state), {
            state,
          });
          const reply = await getContent(
            api,
            tokens.restricted,
            session.id,
            file.id,
          );
          expect(reply.status).toBe(200);
        },
      );

      it("Content-Length equals the verified bytes AND the file's size on disk, and the body hash is the stored one", async () => {
        const pdf = pdfBytes(1000, "stat");
        const { session, file } = await servedFile(pdf);
        const [ref] = await refsOf(setup, session.id);
        const artifact = await setup.importArtifact.findUniqueOrThrow({
          where: { id: ref!.artifactId! },
        });
        const reply = await getContent(
          api,
          tokens.restricted,
          session.id,
          file.id,
        );
        expect(Number(reply.headers["content-length"])).toBe(
          artifact.verifiedBytes,
        );
        expect(
          (await readStoredBlob(storageRoot, artifact.storageKey!)).length,
        ).toBe(artifact.verifiedBytes);
        expect(sha256Hex(Buffer.from(reply.text, "latin1"))).toBe(
          sha256Hex(pdf),
        );
      });

      it.each([
        ["a path escape", "../../etc/passwd"],
        ["an absolute path", "/etc/passwd"],
        ["a non-uuid ref segment", "t/not-a-uuid/g2/blob"],
        [
          "a wrong leaf name",
          `t/${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}/g2/other`,
        ],
      ])(
        "a storage key outside the canonical grammar (%s) is the opaque 404",
        async (_name, storageKey) => {
          const { session, file } = await servedFile(
            pdfBytes(1000, "grammar"),
            { storageKey },
          );
          const reply = await getContent(
            api,
            tokens.restricted,
            session.id,
            file.id,
          );
          expect([reply.status, reply.json]).toEqual([404, notFound]);
          expect(reply.headers["content-disposition"]).toBeUndefined();
        },
      );

      it("a refused artifact is byte-for-byte the answer for a ref that does not exist", async () => {
        const { session, file } = await servedFile(pdfBytes(1000, "same"), {
          state: "PURGING",
        });
        const refused = await getContent(
          api,
          tokens.restricted,
          session.id,
          file.id,
        );
        const missing = await getContent(
          api,
          tokens.restricted,
          session.id,
          randomUUID(),
        );
        expect([refused.status, refused.text]).toEqual([
          missing.status,
          missing.text,
        ]);
        expect(refused.headers["content-length"]).toBe(
          missing.headers["content-length"],
        );
      });

      it.each([
        [
          "PURGING (the key is immutable but the blob is going away)",
          { state: "PURGING" },
        ],
        ["PURGED (no key)", { state: "PURGED", storageKey: null }],
        [
          "a servable state whose storage key is NULL",
          { state: "RAW_READY", storageKey: null },
        ],
      ])(
        "%s is the opaque 404, never a partial or empty body",
        async (_name, patch) => {
          const { session, file } = await servedFile(
            pdfBytes(1000, "gone"),
            patch,
          );
          const reply = await getContent(
            api,
            tokens.restricted,
            session.id,
            file.id,
          );
          expect([reply.status, reply.json]).toEqual([404, notFound]);
          expect(reply.headers["content-disposition"]).toBeUndefined();
        },
      );
    });

    it("ownership is decided before the participant gate: a peer never learns whether that gate would have failed", async () => {
      const { session, file } = await appliedWithAttachment(true);
      const reply = await reserve(api, tokens.peer, session.id, [file]);
      expect([reply.status, reply.json]).toEqual([404, notFound]);
    });
  });
});
