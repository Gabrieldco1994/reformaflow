import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTenantDto } from './dto/create-tenant.dto';

@Injectable()
export class TenantService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateTenantDto) {
    return this.prisma.tenant.create({
      data: {
        name: dto.name,
        users: {
          create: {
            username: dto.ownerUsername,
            name: dto.ownerName,
            role: 'OWNER',
          },
        },
      },
      include: { users: true },
    });
  }

  async findById(id: string) {
    return this.prisma.tenant.findUnique({ where: { id } });
  }

  /**
   * Exclusão de tenant restrita a limpeza de contas de teste/orfãs:
   * bloqueia o próprio tenant do requisitante (evita self-lockout).
   * Projetos, usuários e o tenant são soft-deletados em cascata.
   */
  async remove(id: string, requesterTenantId: string) {
    if (id === requesterTenantId) {
      throw new BadRequestException(
        'Não é possível excluir o seu próprio tenant',
      );
    }
    const tenant = await this.prisma.tenant.findUnique({ where: { id } });
    if (!tenant) throw new NotFoundException('Tenant não encontrado');

    await this.prisma.project.deleteMany({ where: { tenantId: id } });
    await this.prisma.user.deleteMany({ where: { tenantId: id } });
    await this.prisma.tenant.delete({ where: { id } });
    return { ok: true };
  }
}
