/**
 * Test-only fixtures + HTTP boot for the B1b recovery specs (list + immutable receipt).
 * Real PrismaService / JwtStrategy / global guards; no mocks of the persistence layer.
 * Seeding goes through a RAW PrismaClient so every temporal value is bound by Prisma
 * exactly as production writes it (INTEGER epoch milliseconds, probed in the SQL smoke spec).
 */
import { randomUUID } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Module, ValidationPipe, type INestApplication } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { Prisma, PrismaClient } from "@prisma/client";
import cookieParser from "cookie-parser";
import { AuthModule } from "../auth/auth.module";
import { AuthService } from "../auth/auth.service";
import { ActivityLogInterceptor } from "../common/interceptors/activity-log.interceptor";
import { FinancialScheduleResponseInterceptor } from "../common/interceptors/financial-schedule-response.interceptor";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import { ModulesGuard } from "../common/guards/modules.guard";
import { ProjectAccessGuard } from "../common/guards/project-access.guard";
import { RolesGuard } from "../common/guards/roles.guard";
import { PrismaModule } from "../prisma/prisma.module";
import {
  IMPORT_SESSION_CAPABILITY,
  IMPORT_SESSION_CLOCK,
  type ImportSessionCapability,
} from "../imports/import-session/import-session.capability";
import { IMPORT_SESSION_UI_ORIGINS } from "../imports/import-session/import-session-ui.guard";
import { ImportSessionModule } from "../imports/import-session/import-session.module";
import {
  EMPTY_DRAFT_JSON,
  FIXED_NOW,
  MutableClock,
  SEVEN_DAYS_MS,
  type ImportWorld,
  type WorldUser,
} from "./import-session-harness";

export const RECOVERY_ORIGIN = "http://localhost:3000";
export const UI_HEADERS = { origin: RECOVERY_ORIGIN, "x-rf-import-ui": "1" };
const SHA = "b".repeat(64);

@Module({
  imports: [PrismaModule, AuthModule, ImportSessionModule],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: FinancialScheduleResponseInterceptor,
    },
    { provide: APP_INTERCEPTOR, useClass: ActivityLogInterceptor },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: ModulesGuard },
    { provide: APP_GUARD, useClass: ProjectAccessGuard },
  ],
})
class RecoveryHttpModule {}

export interface Reply {
  status: number;
  text: string;
  json: any;
}

export interface RecoveryApp {
  app: INestApplication;
  clock: MutableClock;
  call(
    method: string,
    path: string,
    options?: {
      token?: string;
      headers?: Record<string, string>;
      body?: unknown;
    },
  ): Promise<Reply>;
  tokenFor(user: WorldUser | string): Promise<string>;
  close(): Promise<void>;
}

export interface RecoveryBootOptions {
  /** Test override of the compile-time writes switch. Default false (the shipped value). */
  writesEnabled?: boolean;
  /** Extra provider overrides by token (a token no module registers yet is ignored by Nest). */
  overrides?: ReadonlyArray<{ token: string | symbol; value: unknown }>;
  /** Runs after cookieParser/ValidationPipe (as main.ts does) and before the server listens. */
  beforeListen?: (app: INestApplication) => void | Promise<void>;
}

/** Boots the real module graph with the kill switch OFF (default) and a controllable clock. */
export async function bootRecoveryApp(
  setup: PrismaClient,
  options: RecoveryBootOptions = {},
): Promise<RecoveryApp> {
  const clock = new MutableClock(FIXED_NOW);
  let builder = Test.createTestingModule({
    imports: [RecoveryHttpModule],
  })
    .overrideProvider(IMPORT_SESSION_CLOCK)
    .useValue(clock)
    .overrideProvider(IMPORT_SESSION_CAPABILITY)
    .useValue({
      writesEnabled: () => options.writesEnabled ?? false,
      newImportFormats: () =>
        options.writesEnabled ? (["CSV"] as const) : ([] as const),
    } satisfies ImportSessionCapability)
    .overrideProvider(IMPORT_SESSION_UI_ORIGINS)
    .useValue({ allowed: () => [RECOVERY_ORIGIN] });
  for (const override of options.overrides ?? []) {
    builder = builder.overrideProvider(override.token).useValue(override.value);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await options.beforeListen?.(app);
  await app.listen(0, "127.0.0.1");
  const port = (app.getHttpServer().address() as AddressInfo).port;
  const auth = app.get(AuthService);
  return {
    app,
    clock,
    tokenFor: async (user) =>
      auth.issueToken(
        await setup.user.findUniqueOrThrow({
          where: { id: typeof user === "string" ? user : user.id },
        }),
      ),
    call: (method, path, options = {}) =>
      new Promise<Reply>((resolve, reject) => {
        const payload =
          options.body === undefined ? undefined : JSON.stringify(options.body);
        const headers: Record<string, string> = { ...(options.headers ?? {}) };
        if (payload !== undefined) {
          headers["content-type"] = "application/json";
          headers["content-length"] = String(Buffer.byteLength(payload));
        }
        if (options.token) headers["authorization"] = `Bearer ${options.token}`;
        const req = http.request(
          { host: "127.0.0.1", port, method, path, headers },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
              const text = Buffer.concat(chunks).toString("utf8");
              let json: unknown = null;
              try {
                json = JSON.parse(text);
              } catch {
                /* not json */
              }
              resolve({ status: res.statusCode ?? 0, text, json });
            });
          },
        );
        req.on("error", reject);
        if (payload !== undefined) req.write(payload);
        req.end();
      }),
    close: () => app.close(),
  };
}

// -- seeding -----------------------------------------------------------------------------

export interface HiddenAnchor {
  projectId: string;
  cardId: string;
}

/** A project + card that exist in the tenant but are soft-deleted (invisible anchor). */
export async function addSoftDeletedAnchor(
  setup: PrismaClient,
  world: ImportWorld,
  suffix: string,
): Promise<HiddenAnchor> {
  const projectId = `${world.prefix}-p-gone-${suffix}`;
  const cardId = `${world.prefix}-c-gone-${suffix}`;
  await setup.project.create({
    data: {
      id: projectId,
      tenantId: world.tenantId,
      type: "CASA",
      name: "gone",
      deletedAt: new Date(FIXED_NOW.getTime() - 1000),
    },
  });
  await setup.creditCard.create({
    data: {
      id: cardId,
      tenantId: world.tenantId,
      projectId,
      institution: "ITAU",
      nickname: cardId,
      last4: "4321",
    },
  });
  return { projectId, cardId };
}

/** An ACTIVE extra project (of the given type) with one card, e.g. a project a restricted user cannot see. */
export async function addProjectWithCard(
  setup: PrismaClient,
  world: ImportWorld,
  suffix: string,
  type = "CASA",
): Promise<HiddenAnchor> {
  const projectId = `${world.prefix}-p-${suffix}`;
  const cardId = `${world.prefix}-c-${suffix}`;
  await setup.project.create({
    data: { id: projectId, tenantId: world.tenantId, type, name: suffix },
  });
  await setup.creditCard.create({
    data: {
      id: cardId,
      tenantId: world.tenantId,
      projectId,
      institution: "ITAU",
      nickname: cardId,
      last4: "5555",
    },
  });
  return { projectId, cardId };
}

export function sessionRow(
  world: ImportWorld,
  ownerUserId: string,
  index: number,
  extra: Partial<Prisma.ImportSessionUncheckedCreateInput> = {},
): Prisma.ImportSessionCreateManyInput {
  return {
    id: randomUUID(),
    tenantId: world.tenantId,
    ownerUserId,
    ownerProjectId: world.projects.pessoal,
    cardId: world.cards.pessoal,
    kind: "CREATE_CARD_PURCHASES",
    state: "DRAFT",
    revision: 1,
    createRequestId: randomUUID(),
    createPayloadHash: "a".repeat(64),
    consentPolicyVersion: 1,
    consentedAt: FIXED_NOW,
    // Newer rows have a SMALLER index; one second apart unless a spec pins ties.
    createdAt: new Date(FIXED_NOW.getTime() - index * 1000),
    lastUserEditAt: FIXED_NOW,
    expiresAt: new Date(FIXED_NOW.getTime() + SEVEN_DAYS_MS),
    draftJson: EMPTY_DRAFT_JSON,
    ...extra,
  } as Prisma.ImportSessionCreateManyInput;
}

export async function insertMany(
  setup: PrismaClient,
  rows: Prisma.ImportSessionCreateManyInput[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += 400) {
    await setup.importSession.createMany({ data: rows.slice(i, i + 400) });
  }
}

// -- receipt v1 (snapshot mandatory) -----------------------------------------------------

export const SNAPSHOT_SCHEDULE = (totalCents: number, date = "2026-09-10") => ({
  version: 1,
  occurrences: [
    {
      index: 0,
      parcela: null,
      valor: totalCents,
      data: date,
      invoiceDueMonth: "2026-10",
    },
  ],
});

export interface SnapshotLineSeed {
  lineId?: string;
  outcome?: "CREATED" | "KEPT_EXISTING";
  sourceProjectId: string;
  targets?: Array<{ projectId: string; amountCents: number }>;
  totalCents?: number;
}

/** Receipt v1 as the contract freezes it: snapshot required, lines 1:1 with items, sorted union. */
export function receiptV1(
  sessionId: string,
  anchorProjectId: string,
  lines: SnapshotLineSeed[],
  mutate: (receipt: Record<string, any>) => void = () => undefined,
): Record<string, any> {
  const seeded = lines.map((line, index) => ({
    lineId: line.lineId ?? `line-${index + 1}`,
    outcome: line.outcome ?? "CREATED",
    ...line,
  }));
  const participants = [
    ...new Set([
      anchorProjectId,
      ...seeded.flatMap((line) => [
        line.sourceProjectId,
        ...(line.targets ?? []).map((target) => target.projectId),
      ]),
    ]),
  ].sort();
  const snapshotLines = seeded.map((line) => {
    const total = line.totalCents ?? 10_000;
    const keep = line.outcome === "KEPT_EXISTING";
    return {
      lineId: line.lineId,
      titulo: keep ? null : "Mercado",
      dataCompra: keep ? null : "2026-09-10",
      totalCents: total,
      schedule: SNAPSHOT_SCHEDULE(total),
      sourceProjectId: line.sourceProjectId,
      targets: line.targets ?? [],
    };
  });
  const receipt: Record<string, any> = {
    version: 1,
    sessionId,
    financialRequestId: randomUUID(),
    confirmedRevision: 1,
    proposalHash: SHA,
    appliedAt: FIXED_NOW.toISOString(),
    continuationSessionId: null,
    items: seeded.map((line) => ({
      lineId: line.lineId,
      outcome: line.outcome,
      sourceExpenseId: `exp-${line.lineId}`,
      targetExpenseIds: [],
      allocationIds: [],
      cashFlowEntryIds: [],
    })),
    auditItems: [],
    snapshot: {
      lines: snapshotLines,
      participantProjectIds: participants,
      createdEconomicTotalCents: snapshotLines
        .filter((_line, index) => seeded[index]!.outcome !== "KEPT_EXISTING")
        .reduce((sum, line) => sum + line.totalCents, 0),
      bankCashDeltaCents: 0,
      invoiceDeltas: [],
    },
  };
  receipt["snapshot"].invoiceDeltas = [
    {
      invoiceDueMonth: "2026-10",
      amountCents: receipt["snapshot"].createdEconomicTotalCents,
    },
  ];
  mutate(receipt);
  return receipt;
}

export interface AppliedSeed {
  owner: WorldUser;
  anchorProjectId?: string;
  cardId?: string;
  participants?: SnapshotLineSeed[];
  closedAt?: Date;
  mutate?: (receipt: Record<string, any>) => void;
  /** Receipt JSON override (already serialised): for legacy/corrupt shapes. */
  receiptJson?: string;
  index?: number;
}

/** Inserts an APPLIED session whose receipt is a valid v1 snapshot unless overridden. */
export async function seedApplied(
  setup: PrismaClient,
  world: ImportWorld,
  seed: AppliedSeed,
) {
  const id = randomUUID();
  const anchor = seed.anchorProjectId ?? world.projects.pessoal;
  const receipt =
    seed.receiptJson ??
    JSON.stringify(
      receiptV1(
        id,
        anchor,
        seed.participants ?? [{ sourceProjectId: anchor }],
        seed.mutate,
      ),
    );
  const row = sessionRow(world, seed.owner.id, seed.index ?? 0, {
    id,
    ownerProjectId: anchor,
    cardId: seed.cardId ?? world.cards.pessoal,
    state: "APPLIED",
    financialRequestId: randomUUID(),
    confirmedRevision: 1,
    confirmedSessionVersion: 0,
    confirmedAt: FIXED_NOW,
    proposalHash: SHA,
    receiptJson: receipt,
    closedAt:
      seed.closedAt ?? new Date(FIXED_NOW.getTime() - (seed.index ?? 0) * 1000),
  });
  await setup.importSession.create({
    data: row as Prisma.ImportSessionUncheckedCreateInput,
  });
  return { id, receipt };
}
