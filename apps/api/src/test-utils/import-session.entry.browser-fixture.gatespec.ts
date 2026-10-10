require("../../../../scripts/test-db-env.cjs");

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import { AppModule } from "../app.module";
import { PrismaService } from "../prisma/prisma.service";
import { IMPORT_SESSION_CLOCK } from "../imports/import-session/import-session.capability";
import { registerImportUploadFraming } from "../imports/import-session/vault/vault-framing";
import {
  EMPTY_DRAFT_JSON,
  FIXED_NOW,
  MutableClock,
  SEVEN_DAYS_MS,
} from "./import-session-harness";
import { receiptV1 } from "./import-session-recovery-harness";
import {
  connectVaultTestDatabase,
  createVaultTestDatabase,
  finishVaultFixture,
} from "./import-session-vault-harness";

// Standalone private IPC adapter; excluded by existing Nest/Jest globs. Never an HTTP seed route.
export async function bootPublicEntryBrowserFixture() {
  if (process.env.AUTH_ENABLE_REGISTER !== "1")
    throw new Error(
      "This fixture requires explicit local real-signup authorization",
    );
  const database = await createVaultTestDatabase();
  let initializing: INestApplication | undefined;
  try {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IMPORT_SESSION_CLOCK)
      .useValue(new MutableClock(FIXED_NOW))
      .compile();
    const app = module.createNestApplication();
    initializing = app;
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.enableCors({ origin: "http://127.0.0.1:43142", credentials: true });
    registerImportUploadFraming(app);
    await app.init();
    const prisma = app.get(PrismaService);
    const evidence = await connectVaultTestDatabase(prisma);
    await app.listen(43141, "127.0.0.1");

    return {
      evidence,
      async prepareRecovery(userId: string, projectId: string) {
        const user = await prisma.user.findFirstOrThrow({
          where: { id: userId },
        });
        const project = await prisma.project.findFirstOrThrow({
          where: { id: projectId, tenantId: user.tenantId, type: "PESSOAL" },
        });
        if (user.role !== "USER" || user.isGuest)
          throw new Error(
            "Recovery fixtures require the real self-service signup user",
          );
        const card = await prisma.creditCard.create({
          data: {
            tenantId: user.tenantId,
            projectId: project.id,
            institution: "ITAU",
            nickname: "PublicEntry QA",
            last4: "9911",
          },
        });
        const common = {
          tenantId: user.tenantId,
          ownerUserId: user.id,
          ownerProjectId: project.id,
          cardId: card.id,
          kind: "CREATE_CARD_PURCHASES",
          revision: 1,
          createPayloadHash: "a".repeat(64),
          consentPolicyVersion: 1,
          consentedAt: FIXED_NOW,
          lastUserEditAt: FIXED_NOW,
          expiresAt: new Date(FIXED_NOW.getTime() + SEVEN_DAYS_MS),
          draftJson: EMPTY_DRAFT_JSON,
        };
        const draft = await prisma.importSession.create({
          data: { ...common, state: "DRAFT", createRequestId: randomUUID() },
        });
        const id = randomUUID();
        const applied = await prisma.importSession.create({
          data: {
            ...common,
            id,
            state: "APPLIED",
            createRequestId: randomUUID(),
            financialRequestId: randomUUID(),
            confirmedRevision: 1,
            confirmedSessionVersion: 0,
            confirmedAt: FIXED_NOW,
            proposalHash: "b".repeat(64),
            closedAt: FIXED_NOW,
            receiptJson: JSON.stringify(
              receiptV1(id, project.id, [
                {
                  sourceProjectId: project.id,
                  totalCents: 2_147_483_647,
                },
              ]),
            ),
          },
        });
        return { draftId: draft.id, appliedId: applied.id, cardId: card.id };
      },
      async close() {
        await finishVaultFixture(
          () => app.close(),
          () => database.close(),
        );
        copyFileSync(
          database.file,
          join(database.directory, "browser-closed.db"),
        );
        const capture = spawnSync(
          "lsof",
          ["-nP", "-a", "-p", String(process.pid), "-F0pftn"],
          { encoding: "utf8" },
        );
        writeFileSync(
          join(database.directory, "browser-closure-lsof.json"),
          JSON.stringify({
            pid: process.pid,
            status: capture.status,
            stdout: capture.stdout,
            stderr: capture.stderr,
          }),
          { flag: "wx", mode: 0o600 },
        );
        if (
          capture.status !== 0 ||
          capture.error ||
          capture.stderr ||
          /\.(?:db|sqlite|sqlite3)(?:-(?:journal|wal|shm))?\0/.test(
            capture.stdout,
          )
        )
          throw new Error(
            "Browser fixture failed to prove closed database handles",
          );
      },
    };
  } catch (error) {
    try {
      await finishVaultFixture(
        () => initializing?.close(),
        () => database.close(),
      );
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "PublicEntry fixture boot/cleanup failed",
      );
    }
    throw error;
  }
}

if (require.main === module) {
  if (!process.send)
    throw new Error(
      "Private IPC required; no standalone public control listener",
    );
  void bootPublicEntryBrowserFixture()
    .then((fixture) => {
      process.send?.({
        kind: "READY",
        pid: process.pid,
        evidence: fixture.evidence,
      });
      let busy = false;
      process.on("message", (message: unknown) => {
        if (busy || !message || typeof message !== "object") {
          process.send?.({
            kind: "ERROR",
            message: "Invalid or concurrent fixture request",
          });
          return;
        }
        const input = message as Record<string, unknown>;
        busy = true;
        const work = async () => {
          if (input.kind === "CLOSE") {
            await fixture.close();
            process.send?.({ kind: "CLOSED" });
            process.disconnect();
          } else if (
            input.kind === "RECOVERY" &&
            typeof input.userId === "string" &&
            typeof input.projectId === "string"
          ) {
            process.send?.({
              kind: "RECOVERY",
              ...(await fixture.prepareRecovery(input.userId, input.projectId)),
            });
          } else throw new Error("Unknown private fixture request");
        };
        void work()
          .catch((error: unknown) => {
            console.error(error);
            process.send?.({
              kind: "ERROR",
              message: error instanceof Error ? error.message : String(error),
            });
            process.exitCode = 1;
          })
          .finally(() => {
            busy = false;
          });
      });
    })
    .catch((error: unknown) => {
      console.error(error);
      process.send?.({
        kind: "ERROR",
        message: error instanceof Error ? error.message : String(error),
      });
      process.exitCode = 1;
    });
}
