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
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
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
    const nameById = new Map(users.map((u) => [u.id, u.name]));
    return users.map((u) => ({
      ...toPublic(u),
      tenantName: u.tenant?.name ?? null,
      createdByName: u.createdByUserId
        ? (nameById.get(u.createdByUserId) ?? null)
        : null,
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
