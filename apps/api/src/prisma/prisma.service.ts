import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super();

    // Models that don't have deletedAt field
    const modelsWithoutSoftDelete = new Set(['SimulationValue', 'Simulation', 'FloorPlanRoom', 'RoomImage']);

    // Middleware de soft delete: intercepta queries para filtrar deletedAt = null
    this.$use(async (params, next) => {
      const skipSoftDelete = modelsWithoutSoftDelete.has(params.model ?? '');

      // Filtra soft-deleted records em findMany, findFirst, findUnique
      if (!skipSoftDelete && (params.action === 'findMany' || params.action === 'findFirst')) {
        if (!params.args) params.args = {};
        if (!params.args.where) params.args.where = {};
        if (params.args.where.deletedAt === undefined) {
          params.args.where.deletedAt = null;
        }
      }

      // Converte delete em soft delete (update deletedAt)
      if (!skipSoftDelete && params.action === 'delete') {
        params.action = 'update';
        params.args.data = { deletedAt: new Date() };
      }

      if (!skipSoftDelete && params.action === 'deleteMany') {
        params.action = 'updateMany';
        if (!params.args) params.args = {};
        params.args.data = { deletedAt: new Date() };
      }

      return next(params);
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
