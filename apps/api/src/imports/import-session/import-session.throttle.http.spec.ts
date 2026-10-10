// The database guard must run before Prisma is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../../scripts/test-db-env.cjs");

import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { PrismaService } from "../../prisma/prisma.service";
import {
  cleanupImportWorld,
  createBody,
  FIXED_NOW,
  seedImportWorld,
  type ImportWorld,
} from "../../test-utils/import-session-harness";
import {
  bootVaultApp,
  CANONICAL_VAULT,
  connectVaultTestDatabase,
  fileSeed,
  putContent,
  reserve,
  UI_HEADERS,
  vaultTestDatabaseIsSafe,
  type RecoveryApp,
  type Reply,
} from "../../test-utils/import-session-vault-harness";
import {
  IMPORT_SESSION_CAPABILITY,
  type ImportSessionCapability,
} from "./import-session.capability";
import { ImportSessionExtractionService } from "./import-session.extraction.service";
import { ImportSessionService } from "./import-session.service";
import { ImportContentService } from "./vault/import-content.service";
import { ImportUploadService } from "./vault/import-upload.service";

type Operation = "CREATE" | "RESERVE" | "UPLOAD" | "ANALYZE" | "DOWNLOAD";
const capability: ImportSessionCapability = {
  writesEnabled: () => true,
  newImportFormats: () => ["CSV"],
};
const view = {
  id: "throttle-view",
  state: "DRAFT",
  revision: 1,
  lines: [],
  selectedLineIds: [],
  questions: [],
  actions: [],
};

describe("import operation HTTP throttle", () => {
  const prisma = new PrismaService();
  let world: ImportWorld;
  let api: RecoveryApp;
  let ownerToken: string;
  let peerToken: string;
  let foreignToken: string;
  let testClock = 0;

  beforeAll(async () => {
    await connectVaultTestDatabase(prisma);
    world = await seedImportWorld(prisma, "maria-throttle");
    api = await bootVaultApp(prisma, {
      vault: CANONICAL_VAULT,
      framing: true,
      overrides: [{ token: IMPORT_SESSION_CAPABILITY, value: capability }],
    });
    ownerToken = await api.tokenFor(world.users.owner);
    peerToken = await api.tokenFor(world.users.peer);
    foreignToken = await api.tokenFor(world.users.foreign);
  });

  beforeEach(() => {
    testClock += 120_000;
    api.clock.current = new Date(FIXED_NOW.getTime() + testClock);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await api?.close();
    if (vaultTestDatabaseIsSafe(prisma))
      await cleanupImportWorld(prisma, "maria-throttle");
    await prisma.$disconnect();
  });

  function stub(operation: Operation): jest.SpyInstance {
    if (operation === "CREATE")
      return jest
        .spyOn(api.app.get(ImportSessionService), "create")
        .mockResolvedValue({ view: view as never, created: true });
    if (operation === "RESERVE")
      return jest
        .spyOn(api.app.get(ImportUploadService), "reserve")
        .mockResolvedValue(view as never);
    if (operation === "UPLOAD") {
      jest
        .spyOn(api.app.get(ImportUploadService), "assertAvailable")
        .mockReturnValue(undefined);
      return jest
        .spyOn(api.app.get(ImportUploadService), "upload")
        .mockResolvedValue(view as never);
    }
    if (operation === "ANALYZE") {
      jest
        .spyOn(api.app.get(ImportSessionExtractionService), "assertAvailable")
        .mockReturnValue({} as never);
      return jest
        .spyOn(api.app.get(ImportSessionExtractionService), "analyzeAttached")
        .mockResolvedValue(view as never);
    }
    return jest
      .spyOn(api.app.get(ImportContentService), "download")
      .mockImplementation(async (_auth, _session, _attachment, consume) =>
        consume(Readable.from(Buffer.from("x")), {
          fileName: "fatura.csv",
          verifiedBytes: 1,
        }),
      );
  }

  function call(
    operation: Operation,
    token = ownerToken,
    cardId = world.cards.pessoal,
  ): Promise<Reply> {
    const sessionId = randomUUID();
    const attachmentId = randomUUID();
    switch (operation) {
      case "CREATE":
        return api.call("POST", "/import-sessions", {
          token,
          headers: UI_HEADERS,
          body: createBody(cardId),
        });
      case "RESERVE":
        return reserve(api, token, sessionId, [
          fileSeed({
            fileName: "fatura.csv",
            mime: "text/csv",
            declaredBytes: 1,
          }),
        ]);
      case "UPLOAD":
        return putContent(api, sessionId, attachmentId, {
          token,
          body: Buffer.from("x"),
        });
      case "ANALYZE":
        return api.call(
          "POST",
          `/import-sessions/${sessionId}/attachments/${attachmentId}/analyze`,
          {
            token,
            headers: UI_HEADERS,
            body: { expectedRevision: 1 },
          },
        );
      case "DOWNLOAD":
        return api.call(
          "GET",
          `/import-sessions/${sessionId}/attachments/${attachmentId}/content`,
          { token },
        );
    }
  }

  async function admitThirty(operation: Operation, token = ownerToken) {
    const downstream = stub(operation);
    for (let request = 1; request <= 30; request += 1) {
      const response = await call(operation, token);
      expect(response.status).toBe(operation === "CREATE" ? 201 : 200);
    }
    return downstream;
  }

  it.each<Operation>(["CREATE", "RESERVE", "UPLOAD", "ANALYZE", "DOWNLOAD"])(
    "admits_30_and_rejects_the_31st_request_per_operation: %s",
    async (op) => {
      const downstream = await admitThirty(op);
      const rejected = await call(op);
      expect(rejected.status).toBe(429);
      expect(downstream).toHaveBeenCalledTimes(30);
    },
  );

  it("separates_user_tenant_and_operation_buckets", async () => {
    const create = await admitThirty("CREATE");
    expect((await call("CREATE")).status).toBe(429);

    const reserveDownstream = stub("RESERVE");
    expect((await call("RESERVE")).status).toBe(200);
    expect(reserveDownstream).toHaveBeenCalledTimes(1);

    expect((await call("CREATE", peerToken)).status).toBe(201);
    expect(
      (await call("CREATE", foreignToken, world.cards.foreign)).status,
    ).toBe(201);
    expect(create).toHaveBeenCalledTimes(32);
  });

  it("reopens_the_bucket_at_the_60_second_boundary", async () => {
    const start = api.clock.current.getTime();
    const downstream = await admitThirty("CREATE");

    api.clock.current = new Date(start + 59_999);
    expect((await call("CREATE")).status).toBe(429);
    expect(downstream).toHaveBeenCalledTimes(30);

    api.clock.current = new Date(start + 60_000);
    expect((await call("CREATE")).status).toBe(201);
    expect(downstream).toHaveBeenCalledTimes(31);
  });

  it("rejects_upload_before_reading_bytes_and_download_before_opening_storage", async () => {
    const upload = await admitThirty("UPLOAD");
    const download = await admitThirty("DOWNLOAD");

    expect((await call("UPLOAD")).status).toBe(429);
    expect(upload).toHaveBeenCalledTimes(30);
    expect((await call("DOWNLOAD")).status).toBe(429);
    expect(download).toHaveBeenCalledTimes(30);
  });
});
