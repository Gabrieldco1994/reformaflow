// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../scripts/test-db-env.cjs");

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { FloorPlanService } from "./floor-plan.service";
import { PendenciaService } from "../pendencia/pendencia.service";
import { PrismaService } from "../prisma/prisma.service";
import { SimulationService } from "../simulation/simulation.service";

const setupPrisma = new PrismaClient();
const prisma = new PrismaService();

const TENANT = "room-parent-tenant";
const ACTIVE_PROJECT = "room-parent-active-project";
const TOMBSTONE_PROJECT = "room-parent-tombstone-project";
const ACTIVE_ROOM = "room-parent-active-room";
const TOMBSTONE_ROOM = "room-parent-tombstone-room";
const ACTIVE_IMAGE = "room-parent-active-image";
const TOMBSTONE_IMAGE = "room-parent-tombstone-image";

async function cleanup(): Promise<void> {
  await setupPrisma.pendencia.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.roomImage.deleteMany({
    where: { roomId: { in: [ACTIVE_ROOM, TOMBSTONE_ROOM] } },
  });
  await setupPrisma.room.deleteMany({
    where: { id: { in: [ACTIVE_ROOM, TOMBSTONE_ROOM] } },
  });
  await setupPrisma.project.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.tenant.deleteMany({ where: { id: TENANT } });
}

describe("Room consumers require an active parent project (#722)", () => {
  let floorPlans: FloorPlanService;
  let pendencias: PendenciaService;
  let simulations: SimulationService;

  beforeAll(async () => {
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    await cleanup();
    await setupPrisma.tenant.create({
      data: { id: TENANT, name: "Synthetic active-room tenant" },
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
      ],
    });

    floorPlans = new FloorPlanService(prisma, {} as never);
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

  it("filters a legacy nested room relation whose parent is a tombstone", async () => {
    const legacy = await setupPrisma.pendencia.create({
      data: {
        tenantId: TENANT,
        projectId: ACTIVE_PROJECT,
        title: "Synthetic legacy cross-project room",
        roomId: TOMBSTONE_ROOM,
      },
    });

    await expect(
      pendencias.findAll(TENANT, ACTIVE_PROJECT),
    ).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: legacy.id })]),
    );
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
});
