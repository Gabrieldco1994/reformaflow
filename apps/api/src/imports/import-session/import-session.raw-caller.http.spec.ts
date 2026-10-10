require("../../../../../scripts/test-db-env.cjs");
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  rawWorld,
  nativePeers,
  rawSha,
} from "../../test-utils/import-session-raw-harness";
import { UI_HEADERS } from "../../test-utils/import-session-vault-harness";
import { parseStoredImportObservationEvidence } from "./import-session.observation";
import { VaultStorage } from "./vault/vault-storage";

describe("RAW caller through real HTTP, PrismaService and native runner; synthetic subprocess boundary", () => {
  let context: Awaited<ReturnType<typeof rawWorld>>;
  let peers: ReturnType<typeof nativePeers>;
  beforeEach(async () => {
    context = await rawWorld();
    peers = nativePeers();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    try {
      await peers?.close();
    } finally {
      await context?.close();
    }
  });

  it("raw_bytes_profile_and_original_sha_reach_the_native_runner", async () => {
    const f = await context.upload();
    expect(f.artifact.state).toBe("RAW_READY");
    expect(peers.spawn).not.toHaveBeenCalled();
    const response = await context.analyze(f);
    expect(response.status).toBe(200);
    expect(peers.spawn).toHaveBeenCalledTimes(1);
    expect(peers.events).toContainEqual({
      kind: "eof",
      sha: rawSha(f.bytes),
      bytes: f.bytes.length,
      profile: 1,
    });
  });

  it("native_success_and_clean_settlement_publish_x3_atomically", async () => {
    const f = await context.upload();
    const response = await context.analyze(f);
    expect(response.status).toBe(200);
    const artifact = await context.db.importArtifact.findUniqueOrThrow({
      where: { id: f.artifact.id },
    });
    expect(artifact).toMatchObject({
      state: "EXTRACTED",
      parserVersion: "card-local-pdf-v1",
      leaseSessionId: null,
    });
    const observations = await context.db.importObservation.findMany({
      where: { artifactId: artifact.id },
      orderBy: { reference: "asc" },
    });
    expect(
      observations.map(
        (o) =>
          parseStoredImportObservationEvidence(o.evidenceJson).identity.ordinal,
      ),
    ).toEqual([0, 1, null]);
    expect(response.json.attachments[0]).toMatchObject({
      materializedInSession: true,
      canAnalyze: false,
    });
    expect(
      await context.db.expense.count({
        where: { tenantId: context.world.tenantId },
      }),
    ).toBe(0);
    expect(
      await context.db.cashFlowEntry.count({
        where: { tenantId: context.world.tenantId },
      }),
    ).toBe(0);
    expect(
      await context.db.receipt.count({
        where: { tenantId: context.world.tenantId },
      }),
    ).toBe(0);
    const replay = await context.analyze(f);
    expect(replay.status).toBe(200);
    expect(peers.spawn).toHaveBeenCalledTimes(1);
  });

  it("read_or_hash_failure_never_spawns_or_materializes", async () => {
    const f = await context.upload();
    const runtime = context.gate.boot.runtime();
    if (!runtime || !f.artifact.storageKey)
      throw new Error("Missing real vault capture");
    await fs.writeFile(
      join(runtime.config.rootDir, f.artifact.storageKey),
      Buffer.alloc(f.bytes.length, 65),
    );
    expect((await context.analyze(f)).status).toBe(400);
    expect(peers.spawn).not.toHaveBeenCalled();
    expect(
      await context.db.importObservation.count({
        where: { artifactId: f.artifact.id },
      }),
    ).toBe(0);
    expect(
      await context.db.importArtifact.findUniqueOrThrow({
        where: { id: f.artifact.id },
      }),
    ).toMatchObject({ state: "RAW_READY", leaseSessionId: null });
  });

  it("raw_claim_requires_current_authority_before_read_or_spawn", async () => {
    const f = await context.upload();
    const read = jest.spyOn(VaultStorage.prototype, "withArtifactReader");
    const reply = await context.analyze({ ...f, revision: f.revision + 1 });
    expect(reply.status).toBe(409);
    expect(read).not.toHaveBeenCalled();
    expect(peers.spawn).not.toHaveBeenCalled();
  });

  it("abort_after_document_eof_still_reaches_native_execution", async () => {
    const f = await context.upload();
    peers.setBehavior("hold");
    const eof = peers.eof();
    const analyzing = context.analyze(f);
    await eof;
    const cancelled = await context.api.call(
      "POST",
      `/import-sessions/${f.session.id}/cancel`,
      {
        token: context.token,
        headers: UI_HEADERS,
        body: { expectedRevision: f.revision },
      },
    );
    expect(cancelled.status).toBe(200);
    expect((await analyzing).status).not.toBe(200);
    expect(peers.events).toContainEqual({ kind: "cancel" });
    expect(
      await context.db.importObservation.count({
        where: { artifactId: f.artifact.id },
      }),
    ).toBe(0);
  });
});
