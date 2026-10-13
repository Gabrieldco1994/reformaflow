// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../scripts/test-db-env.cjs");

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import {
  userCanAccessProject,
  userCanAccessProjectModule,
} from "../common/access-rules";
import { FloorPlanService } from "./floor-plan.service";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { DashboardService } from "../dashboard/dashboard.service";
import { ExpenseService } from "../expense/expense.service";
import type { RateioRequester } from "../expense/rateio.types";
import { PendenciaService } from "../pendencia/pendencia.service";
import { PrismaService } from "../prisma/prisma.service";
import { SimulationService } from "../simulation/simulation.service";

const setupPrisma = new PrismaClient();
const prisma = new PrismaService();

const TENANT = "room-parent-tenant";
const ACTIVE_PROJECT = "room-parent-active-project";
const SAME_TENANT_PROJECT = "room-parent-same-tenant-project";
const TOMBSTONE_PROJECT = "room-parent-tombstone-project";
const ACTIVE_ROOM = "room-parent-active-room";
const TOMBSTONE_ROOM = "room-parent-tombstone-room";
const ACTIVE_IMAGE = "room-parent-active-image";
const TOMBSTONE_IMAGE = "room-parent-tombstone-image";
const FOREIGN_TENANT = "room-parent-foreign-tenant";
const FOREIGN_PROJECT = "room-parent-foreign-project";
const FOREIGN_ROOM = "room-parent-foreign-room";
const FOREIGN_IMAGE = "room-parent-foreign-image";
const FOREIGN_EXPENSE = "room-parent-foreign-expense";
const SAME_TENANT_EXPENSE = "room-parent-same-tenant-expense";
const LEGACY_EXPENSE = "room-parent-legacy-expense";
const TOMBSTONE_EXPENSE = "room-parent-tombstone-expense";
const FLOOR_PLAN = "room-parent-floor-plan";
const FOREIGN_FLOOR_PLAN_ROOM = "room-parent-foreign-floor-plan-room";
const FOREIGN_FLOOR_PLAN_MARKER = "room-parent-foreign-floor-plan-marker";
const OWNER: RateioRequester = {
  id: "room-parent-owner",
  role: "OWNER",
  allowedProjects: [],
  allowedProjectTypes: [],
  allowedModules: [],
};
const ADMIN: RateioRequester = {
  ...OWNER,
  id: "room-parent-admin",
  role: "ADMIN",
};
const RESTRICTED: RateioRequester = {
  ...OWNER,
  id: "room-parent-restricted",
  role: "MEMBER",
  allowedProjects: [ACTIVE_PROJECT],
  allowedModules: ["floorPlans"],
};

async function cleanup(): Promise<void> {
  await setupPrisma.cashFlowEntry.deleteMany({
    where: { expenseId: { in: [LEGACY_EXPENSE, TOMBSTONE_EXPENSE] } },
  });
  await setupPrisma.pendencia.deleteMany({
    where: { tenantId: { in: [TENANT, FOREIGN_TENANT] } },
  });
  await setupPrisma.floorPlanRoom.deleteMany({
    where: { id: FOREIGN_FLOOR_PLAN_ROOM },
  });
  await setupPrisma.floorPlanMarker.deleteMany({
    where: { floorPlanId: FLOOR_PLAN },
  });
  await setupPrisma.floorPlan.deleteMany({ where: { id: FLOOR_PLAN } });
  await setupPrisma.expense.deleteMany({
    where: {
      id: {
        in: [
          FOREIGN_EXPENSE,
          SAME_TENANT_EXPENSE,
          LEGACY_EXPENSE,
          TOMBSTONE_EXPENSE,
        ],
      },
    },
  });
  await setupPrisma.roomImage.deleteMany({
    where: { roomId: { in: [ACTIVE_ROOM, TOMBSTONE_ROOM, FOREIGN_ROOM] } },
  });
  await setupPrisma.room.deleteMany({
    where: { id: { in: [ACTIVE_ROOM, TOMBSTONE_ROOM, FOREIGN_ROOM] } },
  });
  await setupPrisma.project.deleteMany({
    where: { tenantId: { in: [TENANT, FOREIGN_TENANT] } },
  });
  await setupPrisma.tenant.deleteMany({
    where: { id: { in: [TENANT, FOREIGN_TENANT] } },
  });
}

describe("Room consumers require an active parent project (#722)", () => {
  let floorPlans: FloorPlanService;
  let conciliacao: ConciliacaoService;
  let dashboard: DashboardService;
  let expenses: ExpenseService;
  let pendencias: PendenciaService;
  let simulations: SimulationService;

  beforeAll(async () => {
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    await cleanup();
    await setupPrisma.tenant.createMany({
      data: [
        { id: TENANT, name: "Synthetic active-room tenant" },
        { id: FOREIGN_TENANT, name: "Synthetic foreign-room tenant" },
      ],
    });
    await setupPrisma.project.createMany({
      data: [
        {
          id: ACTIVE_PROJECT,
          tenantId: TENANT,
          name: "Active project",
          type: "REFORMA",
        },
        {
          id: TOMBSTONE_PROJECT,
          tenantId: TENANT,
          name: "__legacy_fk_recovery_tombstone__",
          description: "Technical tombstone created by #722",
          type: "REFORMA",
          deletedAt: new Date("2026-10-12T00:00:00.000Z"),
        },
        {
          id: SAME_TENANT_PROJECT,
          tenantId: TENANT,
          name: "Same-tenant other project",
          type: "REFORMA",
        },
        {
          id: FOREIGN_PROJECT,
          tenantId: FOREIGN_TENANT,
          name: "Foreign project",
          type: "REFORMA",
        },
      ],
    });
    await setupPrisma.room.createMany({
      data: [
        { id: ACTIVE_ROOM, projectId: ACTIVE_PROJECT, name: "Active room" },
        {
          id: TOMBSTONE_ROOM,
          projectId: TOMBSTONE_PROJECT,
          name: "Recovered orphan room",
        },
        {
          id: FOREIGN_ROOM,
          projectId: FOREIGN_PROJECT,
          name: "Foreign confidential room",
        },
      ],
    });
    await setupPrisma.roomImage.createMany({
      data: [
        {
          id: ACTIVE_IMAGE,
          roomId: ACTIVE_ROOM,
          imageUrl: "/fixture/active.jpg",
        },
        {
          id: TOMBSTONE_IMAGE,
          roomId: TOMBSTONE_ROOM,
          imageUrl: "/fixture/tombstone.jpg",
        },
        {
          id: FOREIGN_IMAGE,
          roomId: FOREIGN_ROOM,
          imageUrl: "/fixture/foreign-confidential.jpg",
        },
      ],
    });
    await setupPrisma.expense.createMany({
      data: [
        {
          id: FOREIGN_EXPENSE,
          projectId: FOREIGN_PROJECT,
          tenantId: FOREIGN_TENANT,
          tipoDespesa: "OUTROS",
          roomId: FOREIGN_ROOM,
          valor: 300,
          quantidade: 1,
          valorTotal: 300,
          titulo: "Foreign confidential expense",
          formaPagamento: "A_VISTA",
        },
        {
          id: SAME_TENANT_EXPENSE,
          projectId: SAME_TENANT_PROJECT,
          tenantId: TENANT,
          tipoDespesa: "OUTROS",
          valor: 400,
          quantidade: 1,
          valorTotal: 400,
          titulo: "Same-tenant confidential expense",
          formaPagamento: "A_VISTA",
        },
        {
          id: LEGACY_EXPENSE,
          projectId: ACTIVE_PROJECT,
          tenantId: TENANT,
          tipoDespesa: "OUTROS",
          roomId: FOREIGN_ROOM,
          valor: 100,
          quantidade: 1,
          valorTotal: 100,
          titulo: "Legacy cross-tenant room expense",
          formaPagamento: "A_VISTA",
          dataPagamento: new Date("2026-10-12T12:00:00.000Z"),
        },
        {
          id: TOMBSTONE_EXPENSE,
          projectId: ACTIVE_PROJECT,
          tenantId: TENANT,
          tipoDespesa: "OUTROS",
          roomId: TOMBSTONE_ROOM,
          valor: 200,
          quantidade: 1,
          valorTotal: 200,
          titulo: "Legacy tombstone room expense",
          formaPagamento: "A_VISTA",
          dataPagamento: new Date("2026-10-13T12:00:00.000Z"),
        },
      ],
    });
    await setupPrisma.floorPlan.create({
      data: {
        id: FLOOR_PLAN,
        projectId: ACTIVE_PROJECT,
        tenantId: TENANT,
        name: "Scoped floor plan",
        imageUrl: "/fixture/floor-plan.jpg",
      },
    });
    await setupPrisma.floorPlanRoom.create({
      data: {
        id: FOREIGN_FLOOR_PLAN_ROOM,
        floorPlanId: FLOOR_PLAN,
        roomId: FOREIGN_ROOM,
        label: "Must not serialize",
        bounds: "{}",
      },
    });
    await setupPrisma.floorPlanMarker.create({
      data: {
        id: FOREIGN_FLOOR_PLAN_MARKER,
        floorPlanId: FLOOR_PLAN,
        expenseId: FOREIGN_EXPENSE,
        bounds: "{}",
      },
    });

    floorPlans = new FloorPlanService(prisma, {} as never);
    conciliacao = new ConciliacaoService(prisma);
    dashboard = new DashboardService(prisma);
    expenses = new ExpenseService(prisma, conciliacao);
    pendencias = new PendenciaService(
      prisma,
      {} as never,
      {} as never,
      {} as never,
    );
    simulations = new SimulationService(prisma);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
    await setupPrisma.$disconnect();
  });

  it("keeps active room image reads available and tombstone-parent reads unreachable", async () => {
    await expect(
      floorPlans.getRoomImages(ACTIVE_PROJECT, ACTIVE_ROOM, TENANT),
    ).resolves.toEqual([
      expect.objectContaining({ id: ACTIVE_IMAGE, roomId: ACTIVE_ROOM }),
    ]);

    await expect(
      floorPlans.getRoomImages(TOMBSTONE_PROJECT, TOMBSTONE_ROOM, TENANT),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("does not delete an image through a room whose parent is a tombstone", async () => {
    await expect(
      floorPlans.deleteRoomImage(TOMBSTONE_PROJECT, TOMBSTONE_IMAGE, TENANT),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      setupPrisma.roomImage.findUnique({ where: { id: TOMBSTONE_IMAGE } }),
    ).resolves.not.toBeNull();
  });

  it("keeps active-room pendência creation available and rejects a tombstone-parent room", async () => {
    await expect(
      pendencias.create(TENANT, ACTIVE_PROJECT, {
        title: "Active room task",
        roomId: ACTIVE_ROOM,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        projectId: ACTIVE_PROJECT,
        roomId: ACTIVE_ROOM,
      }),
    );

    await expect(
      pendencias.create(TENANT, TOMBSTONE_PROJECT, {
        title: "Must stay unreachable",
        roomId: TOMBSTONE_ROOM,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      setupPrisma.pendencia.findFirst({
        where: { tenantId: TENANT, title: "Must stay unreachable" },
      }),
    ).resolves.toBeNull();
  });

  it("lists a legacy invalid optional room as redacted instead of hiding its owner row", async () => {
    const legacy = await setupPrisma.pendencia.create({
      data: {
        tenantId: TENANT,
        projectId: ACTIVE_PROJECT,
        title: "Synthetic legacy cross-project room",
        roomId: TOMBSTONE_ROOM,
      },
    });

    const rows = await pendencias.findAll(TENANT, ACTIVE_PROJECT);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: legacy.id,
          roomId: null,
          roomName: null,
        }),
      ]),
    );
    expect(JSON.stringify(rows)).not.toContain(TOMBSTONE_ROOM);
    expect(JSON.stringify(rows)).not.toContain("Recovered orphan room");
  });

  it("authorizes legacy invalid-room repair by owner tenant/project and keeps room data opaque", async () => {
    const [clearable, movable, removable] =
      await setupPrisma.pendencia.createManyAndReturn({
        data: [
          {
            tenantId: TENANT,
            projectId: ACTIVE_PROJECT,
            title: "Clear invalid room",
            roomId: FOREIGN_ROOM,
          },
          {
            tenantId: TENANT,
            projectId: ACTIVE_PROJECT,
            title: "Move invalid room",
            roomId: FOREIGN_ROOM,
          },
          {
            tenantId: TENANT,
            projectId: ACTIVE_PROJECT,
            title: "Delete invalid room",
            roomId: FOREIGN_ROOM,
          },
        ],
      });

    await expect(
      pendencias.update(TENANT, ACTIVE_PROJECT, clearable.id, {
        roomId: null,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: clearable.id,
        roomId: null,
        roomName: null,
      }),
    );
    await expect(
      pendencias.move(TENANT, ACTIVE_PROJECT, movable.id, {
        status: "ANDAMENTO",
        order: 7,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: movable.id,
        status: "ANDAMENTO",
        roomId: null,
        roomName: null,
      }),
    );
    await expect(
      pendencias.remove(TENANT, ACTIVE_PROJECT, removable.id),
    ).resolves.toEqual({ deleted: true });

    await expect(
      setupPrisma.pendencia.findUnique({
        where: { id: clearable.id },
        select: { roomId: true },
      }),
    ).resolves.toEqual({ roomId: null });
    await expect(
      setupPrisma.pendencia.findUnique({
        where: { id: movable.id },
        select: { roomId: true },
      }),
    ).resolves.toEqual({ roomId: FOREIGN_ROOM });
    await expect(
      setupPrisma.pendencia.findUnique({
        where: { id: removable.id },
        select: { deletedAt: true },
      }),
    ).resolves.toEqual({ deletedAt: expect.any(Date) });
  });

  it("rejects new optional room refs outside the active route project", async () => {
    for (const roomId of [FOREIGN_ROOM, TOMBSTONE_ROOM]) {
      await expect(
        pendencias.create(TENANT, ACTIVE_PROJECT, {
          title: "Must reject invalid room ref",
          roomId,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it("keeps active simulation rooms and rejects the tombstone parent before returning room data", async () => {
    await expect(simulations.getData(TENANT, ACTIVE_PROJECT)).resolves.toEqual(
      expect.objectContaining({
        ambientes: expect.arrayContaining([
          expect.objectContaining({ key: ACTIVE_ROOM, label: "Active room" }),
        ]),
      }),
    );

    await expect(
      simulations.getData(TENANT, TOMBSTONE_PROJECT),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("omits a floor-plan backlink to a foreign tenant before nested room data can serialize", async () => {
    for (const payload of [
      await floorPlans.findAll(ACTIVE_PROJECT, TENANT),
      await floorPlans.findOne(FLOOR_PLAN, ACTIVE_PROJECT, TENANT),
    ]) {
      expect(JSON.stringify(payload)).not.toContain(FOREIGN_FLOOR_PLAN_ROOM);
      expect(JSON.stringify(payload)).not.toContain(FOREIGN_FLOOR_PLAN_MARKER);
      expect(JSON.stringify(payload)).not.toContain(FOREIGN_ROOM);
      expect(JSON.stringify(payload)).not.toContain("Foreign confidential");
      expect(JSON.stringify(payload)).not.toContain(FOREIGN_IMAGE);
      expect(JSON.stringify(payload)).not.toContain(FOREIGN_EXPENSE);
    }
  });

  it.each([OWNER, ADMIN, RESTRICTED])(
    "rejects foreign marker expenses opaquely with zero writes for $role",
    async (requester) => {
      // All three callers pass the route-level project ACL and therefore reach
      // the service with tenantId sourced from their authenticated context.
      expect(
        userCanAccessProject(
          requester.role,
          requester.allowedProjects,
          ACTIVE_PROJECT,
        ),
      ).toBe(true);
      expect(
        userCanAccessProjectModule(
          requester.role,
          requester.allowedProjectTypes,
          requester.allowedModules ?? [],
          "REFORMA",
          "floorPlans",
        ),
      ).toBe(true);
      for (const expenseId of [FOREIGN_EXPENSE, SAME_TENANT_EXPENSE]) {
        const before = await setupPrisma.floorPlanMarker.count({
          where: { floorPlanId: FLOOR_PLAN },
        });
        await expect(
          floorPlans.createMarker(FLOOR_PLAN, ACTIVE_PROJECT, TENANT, {
            expenseId,
            bounds: "{}",
          }),
        ).rejects.toMatchObject({
          status: 404,
          message: "Expense not found",
        });
        await expect(
          setupPrisma.floorPlanMarker.count({
            where: { floorPlanId: FLOOR_PLAN },
          }),
        ).resolves.toBe(before);
      }
    },
  );

  it("creates a marker only for an active scoped expense and omits nested expense data", async () => {
    const marker = await floorPlans.createMarker(
      FLOOR_PLAN,
      ACTIVE_PROJECT,
      TENANT,
      {
        expenseId: LEGACY_EXPENSE,
        bounds: "{}",
      },
    );

    expect(marker).toEqual(
      expect.objectContaining({
        floorPlanId: FLOOR_PLAN,
        expenseId: LEGACY_EXPENSE,
      }),
    );
    expect(marker).not.toHaveProperty("expense");
  });

  it.each([OWNER, ADMIN])(
    "redacts tombstone and cross-tenant room relations from expense list/detail for $role",
    async (requester) => {
      const list = await expenses.findAll(
        TENANT,
        ACTIVE_PROJECT,
        {},
        requester,
      );
      const listed = list.items.filter((row) =>
        [LEGACY_EXPENSE, TOMBSTONE_EXPENSE].includes(row.id),
      );
      expect(listed).toHaveLength(2);
      expect(listed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: LEGACY_EXPENSE,
            roomId: null,
            room: null,
          }),
          expect.objectContaining({
            id: TOMBSTONE_EXPENSE,
            roomId: null,
            room: null,
          }),
        ]),
      );

      for (const id of [LEGACY_EXPENSE, TOMBSTONE_EXPENSE]) {
        await expect(
          expenses.findById(TENANT, ACTIVE_PROJECT, id, requester),
        ).resolves.toEqual(
          expect.objectContaining({ id, roomId: null, room: null }),
        );
      }
    },
  );

  it("does not expose a legacy room through dashboard, simulation, or conciliação and does not mutate the FK", async () => {
    const dashboardPayload = await dashboard.getDashboard(
      TENANT,
      ACTIVE_PROJECT,
    );
    const simulationPayload = await simulations.getData(TENANT, ACTIVE_PROJECT);
    expect(JSON.stringify(dashboardPayload)).not.toContain(
      "Foreign confidential room",
    );
    expect(JSON.stringify(simulationPayload)).not.toContain(FOREIGN_ROOM);
    expect(JSON.stringify(simulationPayload)).not.toContain(
      "Foreign confidential room",
    );

    await prisma.$transaction((tx) =>
      conciliacao.regenerateTargetCashflow(tx, LEGACY_EXPENSE),
    );
    await expect(
      setupPrisma.cashFlowEntry.findMany({
        where: { expenseId: LEGACY_EXPENSE, deletedAt: null },
        select: { ambiente: true },
      }),
    ).resolves.toEqual([expect.objectContaining({ ambiente: null })]);
    await expect(
      setupPrisma.expense.findUnique({
        where: { id: LEGACY_EXPENSE },
        select: { roomId: true },
      }),
    ).resolves.toEqual({ roomId: FOREIGN_ROOM });
  });
});
