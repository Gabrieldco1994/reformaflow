import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertCarInfoDto } from './dto/car-info.dto';

@Injectable()
export class CarInfoService {
  constructor(private readonly prisma: PrismaService) {}

  async get(tenantId: string, projectId: string) {
    return this.prisma.carInfo.findUnique({
      where: { projectId },
    });
  }

  async upsert(tenantId: string, projectId: string, dto: UpsertCarInfoDto) {
    return this.prisma.carInfo.upsert({
      where: { projectId },
      create: {
        tenantId,
        projectId,
        ...dto,
      },
      update: dto,
    });
  }
}
