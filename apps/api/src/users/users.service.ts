import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

const BCRYPT_ROUNDS = 10;

function toPublic(u: {
  id: string;
  username: string;
  name: string;
  role: string;
  tenantId: string;
  allowedModules: string;
  allowedProjects: string;
  allowedProjectTypes: string;
  createdByUserId: string | null;
  lastLoginAt: Date | null;
  lastActivityAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  let allowedModules: string[] = [];
  try {
    const parsed = JSON.parse(u.allowedModules || '[]');
    if (Array.isArray(parsed)) allowedModules = parsed;
  } catch {
    allowedModules = [];
  }
  let allowedProjects: string[] = [];
  try {
    const parsed = JSON.parse(u.allowedProjects || '[]');
    if (Array.isArray(parsed)) allowedProjects = parsed;
  } catch {
    allowedProjects = [];
  }
  let allowedProjectTypes: string[] = [];
  try {
    const parsed = JSON.parse(u.allowedProjectTypes || '[]');
    if (Array.isArray(parsed)) allowedProjectTypes = parsed;
  } catch {
    allowedProjectTypes = [];
  }
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    role: u.role,
    tenantId: u.tenantId,
    allowedModules,
    allowedProjects,
    allowedProjectTypes,
    createdByUserId: u.createdByUserId,
    lastLoginAt: u.lastLoginAt,
    lastActivityAt: u.lastActivityAt,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

function mapCounts(rows: Array<{ createdByUserId: string | null; _count: { _all: number } }>) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.createdByUserId) continue;
    counts.set(row.createdByUserId, row._count._all);
  }
  return counts;
}

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async list(tenantId: string, includeAllTenants = false) {
    const users = await this.prisma.user.findMany({
      ...(includeAllTenants ? {} : { where: { tenantId } }),
      include: { tenant: { select: { name: true } } },
      orderBy: [{ tenantId: 'asc' }, { createdAt: 'asc' }],
    });
    if (users.length === 0) return [];

    const nameById = new Map(users.map((u) => [u.id, u.name]));
    const userIds = users.map((u) => u.id);
    const tenantIds = [...new Set(users.map((u) => u.tenantId))];
    const [projectCounts, expenseCounts] = await Promise.all([
      this.prisma.project.groupBy({
        by: ['createdByUserId'],
        where: {
          createdByUserId: { in: userIds },
          deletedAt: null,
        },
        _count: { _all: true },
      }),
      this.prisma.expense.groupBy({
        by: ['tenantId', 'createdByUserId'],
        where: {
          tenantId: { in: tenantIds },
          deletedAt: null,
          settledByExpenseId: null,
        },
        _count: { _all: true },
      }),
    ]);
    const projectsByUserId = mapCounts(projectCounts);
    const expensesByUserId = mapCounts(expenseCounts);
    const usersByTenantId = new Map<string, typeof users>();
    for (const user of users) {
      const tenantUsers = usersByTenantId.get(user.tenantId) ?? [];
      tenantUsers.push(user);
      usersByTenantId.set(user.tenantId, tenantUsers);
    }
    for (const row of expenseCounts) {
      if (row.createdByUserId) continue;
      const tenantUsers = usersByTenantId.get(row.tenantId);
      if (tenantUsers?.length === 1) {
        const userId = tenantUsers[0].id;
        expensesByUserId.set(userId, (expensesByUserId.get(userId) ?? 0) + row._count._all);
      }
    }

    return users.map((u) => ({
      ...toPublic(u),
      tenantName: u.tenant?.name ?? null,
      createdByName: u.createdByUserId
        ? (nameById.get(u.createdByUserId) ?? null)
        : null,
      projectsCreatedCount: projectsByUserId.get(u.id) ?? 0,
      expensesCreatedCount: expensesByUserId.get(u.id) ?? 0,
    }));
  }

  async create(tenantId: string, dto: CreateUserDto, createdByUserId?: string) {
    const username = dto.username.toLowerCase().trim();
    const existing = await this.prisma.user.findFirst({
      where: { username, deletedAt: null },
    });
    if (existing) throw new BadRequestException('Usuário já cadastrado');

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const user = await this.prisma.user.create({
      data: {
        tenantId,
        email: dto.email ?? `${username}@local`,
        username,
        name: dto.name.trim(),
        role: dto.role ?? 'USER',
        passwordHash,
        allowedModules: JSON.stringify(dto.allowedModules ?? []),
        allowedProjects: JSON.stringify(dto.allowedProjects ?? []),
        allowedProjectTypes: JSON.stringify(dto.allowedProjectTypes ?? []),
        createdByUserId: createdByUserId ?? null,
      },
    });
    return toPublic(user);
  }

  async update(tenantId: string, id: string, dto: UpdateUserDto) {
    const user = await this.prisma.user.findFirst({ where: { id, tenantId } });
    if (!user) throw new NotFoundException('Usuário não encontrado');

    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data['name'] = dto.name.trim();
    if (dto.username !== undefined) {
      const username = dto.username.toLowerCase().trim();
      if (username !== user.username) {
        const dupe = await this.prisma.user.findFirst({
          where: { username, deletedAt: null, NOT: { id } },
        });
        if (dupe) throw new BadRequestException('Usuário já cadastrado');
      }
      data['username'] = username;
    }
    if (dto.role !== undefined) data['role'] = dto.role;
    if (dto.allowedModules !== undefined) {
      data['allowedModules'] = JSON.stringify(dto.allowedModules);
    }
    if (dto.allowedProjects !== undefined) {
      data['allowedProjects'] = JSON.stringify(dto.allowedProjects);
    }
    if (dto.allowedProjectTypes !== undefined) {
      data['allowedProjectTypes'] = JSON.stringify(dto.allowedProjectTypes);
    }
    if (dto.password) {
      data['passwordHash'] = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    }

    const updated = await this.prisma.user.update({ where: { id }, data });
    return toPublic(updated);
  }

  async forceLogout(tenantId: string, id: string, requesterId: string) {
    if (id === requesterId) {
      throw new BadRequestException('Você não pode encerrar sua própria sessão');
    }
    const user = await this.prisma.user.findFirst({ where: { id, tenantId } });
    if (!user) throw new NotFoundException('Usuário não encontrado');
    await this.prisma.user.update({
      where: { id },
      data: { sessionVersion: { increment: 1 } },
    });
    return { ok: true };
  }

  async remove(tenantId: string, id: string, requesterId: string) {
    if (id === requesterId) {
      throw new BadRequestException('Você não pode excluir a si mesmo');
    }
    const user = await this.prisma.user.findFirst({ where: { id, tenantId } });
    if (!user) throw new NotFoundException('Usuário não encontrado');

    if (user.role === 'ADMIN') {
      const adminCount = await this.prisma.user.count({
        where: { tenantId, role: 'ADMIN' },
      });
      if (adminCount <= 1) {
        throw new BadRequestException('Não é possível excluir o último admin');
      }
    }

    await this.prisma.user.delete({ where: { id } });
    return { ok: true };
  }
}
