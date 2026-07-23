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

// ponytail: offset fixo -3; Brasil não tem horário de verão desde 2019.
// Se voltar o DST, trocar por Intl/timezone-aware.
function saoPauloTodayWindow(now = new Date()): { start: Date; end: Date } {
  const OFFSET_MS = 3 * 60 * 60 * 1000;
  const sp = new Date(now.getTime() - OFFSET_MS);
  const start = new Date(
    Date.UTC(sp.getUTCFullYear(), sp.getUTCMonth(), sp.getUTCDate()) + OFFSET_MS,
  );
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

interface TypeUserRow {
  type: string;
  userId: string | null;
  count: number;
}

// Agrega linhas (type,userId,count) em [{type,count,users:[{userId,name,count}]}].
function summarizeByType(
  rows: TypeUserRow[],
  label: (userId: string | null) => string,
) {
  const byType = new Map<
    string,
    { count: number; users: Map<string, { userId: string | null; name: string; count: number }> }
  >();
  for (const r of rows) {
    const entry = byType.get(r.type) ?? { count: 0, users: new Map() };
    entry.count += r.count;
    const key = r.userId ?? '__none__';
    const u = entry.users.get(key) ?? { userId: r.userId, name: label(r.userId), count: 0 };
    u.count += r.count;
    entry.users.set(key, u);
    byType.set(r.type, entry);
  }
  return [...byType]
    .map(([type, e]) => ({
      type,
      count: e.count,
      users: [...e.users.values()].sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.count - a.count);
}

function toPublic(u: {
  id: string;
  username: string;
  email: string | null;
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
    email: u.email,
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

  async getActivity(userId: string) {
    const [summary, recent] = await Promise.all([
      this.prisma.userActivityLog.groupBy({
        by: ['action'],
        where: { userId },
        _count: { _all: true },
      }),
      this.prisma.userActivityLog.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
    ]);
    return {
      summary: summary.map((s) => ({ action: s.action, count: s._count._all })).sort((a, b) => b.count - a.count),
      recent,
    };
  }

  // Estatísticas cross-tenant para o admin (dono). Somente projetos não apagados.
  async getProjectStats(now = new Date()) {
    const { start, end } = saoPauloTodayWindow(now);

    const byTypeRaw = await this.prisma.project.groupBy({
      by: ['type', 'createdByUserId'],
      where: { deletedAt: null },
      _count: { _all: true },
    });

    // Projetos que criaram conteúdo hoje (janela SP). VehicleDocument fica de
    // fora: liga em carro, não em projeto.
    const w = { createdAt: { gte: start, lt: end } };
    const contentGroups = await Promise.all([
      this.prisma.expense.groupBy({ by: ['projectId'], where: w }),
      this.prisma.receipt.groupBy({ by: ['projectId'], where: w }),
      this.prisma.recurringBill.groupBy({ by: ['projectId'], where: w }),
      this.prisma.creditCard.groupBy({ by: ['projectId'], where: w }),
      this.prisma.bankAccount.groupBy({ by: ['projectId'], where: w }),
      this.prisma.carInfo.groupBy({ by: ['projectId'], where: w }),
      this.prisma.plant.groupBy({ by: ['projectId'], where: w }),
      this.prisma.floorPlan.groupBy({ by: ['projectId'], where: w }),
      this.prisma.financing.groupBy({ by: ['projectId'], where: w }),
      this.prisma.reminder.groupBy({ by: ['projectId'], where: w }),
      this.prisma.maintenanceLog.groupBy({ by: ['projectId'], where: w }),
      this.prisma.scheduleTask.groupBy({ by: ['projectId'], where: w }),
      this.prisma.pendencia.groupBy({ by: ['projectId'], where: w }),
      this.prisma.priceMonitorItem.groupBy({ by: ['projectId'], where: w }),
      this.prisma.categoryBudget.groupBy({ by: ['projectId'], where: w }),
      this.prisma.cashFlowEntry.groupBy({ by: ['projectId'], where: w }),
    ]);
    const activeProjectIds = new Set<string>();
    for (const rows of contentGroups) {
      for (const r of rows) {
        if (r.projectId) activeProjectIds.add(r.projectId);
      }
    }

    const touchedProjects = activeProjectIds.size
      ? await this.prisma.project.findMany({
          where: { id: { in: [...activeProjectIds] }, deletedAt: null },
          select: { type: true, createdByUserId: true },
        })
      : [];

    // Total de despesas (todas, sem janela de tempo) por tipo de projeto —
    // cross-tenant. Expense não tem `type` próprio; agregamos por projectId e
    // resolvemos tipo/dono via project (só projetos ativos: deletedAt null).
    const expenseCounts = await this.prisma.expense.groupBy({
      by: ['projectId'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    const expenseProjectIds = expenseCounts
      .map((e) => e.projectId)
      .filter((id): id is string => !!id);
    const expenseProjects = expenseProjectIds.length
      ? await this.prisma.project.findMany({
          where: { id: { in: expenseProjectIds }, deletedAt: null },
          select: { id: true, type: true, createdByUserId: true },
        })
      : [];
    const expenseProjMeta = new Map(expenseProjects.map((p) => [p.id, p]));

    // Resolve nomes de todos os donos envolvidos (projetos, conteúdo de hoje e
    // despesas).
    const ownerIds = new Set<string>();
    for (const r of byTypeRaw) if (r.createdByUserId) ownerIds.add(r.createdByUserId);
    for (const p of touchedProjects) if (p.createdByUserId) ownerIds.add(p.createdByUserId);
    for (const p of expenseProjects) if (p.createdByUserId) ownerIds.add(p.createdByUserId);
    const owners = ownerIds.size
      ? await this.prisma.user.findMany({
          where: { id: { in: [...ownerIds] } },
          select: { id: true, name: true },
        })
      : [];
    const nameById = new Map(owners.map((o) => [o.id, o.name]));
    const ownerLabel = (userId: string | null) =>
      userId ? (nameById.get(userId) ?? 'Usuário removido') : 'Sem dono';

    const byType = summarizeByType(
      byTypeRaw.map((r) => ({
        type: r.type,
        userId: r.createdByUserId,
        count: r._count._all,
      })),
      ownerLabel,
    );
    const contentTodayByType = summarizeByType(
      touchedProjects.map((p) => ({ type: p.type, userId: p.createdByUserId, count: 1 })),
      ownerLabel,
    );
    const expensesByType = summarizeByType(
      expenseCounts
        .map((e) => {
          const p = e.projectId ? expenseProjMeta.get(e.projectId) : undefined;
          return p
            ? { type: p.type, userId: p.createdByUserId, count: e._count?._all ?? 0 }
            : null;
        })
        .filter((r): r is TypeUserRow => r !== null),
      ownerLabel,
    );
    const expensesTotal = expensesByType.reduce((sum, t) => sum + t.count, 0);

    return {
      byType,
      contentTodayByType,
      contentTodayTotal: touchedProjects.length,
      expensesByType,
      expensesTotal,
      windowStart: start.toISOString(),
      windowEnd: end.toISOString(),
    };
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
        email: dto.email || null,
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
