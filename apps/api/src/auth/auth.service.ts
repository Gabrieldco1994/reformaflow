import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from './jwt.strategy';

const BCRYPT_ROUNDS = 10;

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  getPublicConfig() {
    return {
      registerEnabled: process.env['AUTH_ENABLE_REGISTER'] === '1',
      guestEnabled: process.env['AUTH_ENABLE_GUEST'] === '1',
    };
  }

  async getOnboarding(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { tenant: true },
    });
    if (!user || user.deletedAt || !user.tenant || user.tenant.deletedAt) {
      throw new UnauthorizedException('Sessão inválida');
    }

    const projects = await this.prisma.project.findMany({
      where: {
        tenantId: user.tenantId,
        deletedAt: null,
        type: { in: ['PESSOAL', 'REFORMA'] },
      },
      select: { type: true },
    });
    const hasPersonalProject = projects.some((p) => p.type === 'PESSOAL');
    const hasReformaProject = projects.some((p) => p.type === 'REFORMA');
    const demoMode = process.env['APP_MODE'] === 'demo';

    return {
      isGuest: user.isGuest,
      demoMode,
      hasPersonalProject,
      hasReformaProject,
      shouldSeed:
        demoMode &&
        user.isGuest &&
        (!hasPersonalProject || !hasReformaProject),
      tourStorageKey: `rf_demo_tour_seen:${user.tenantId}`,
    };
  }

  async validateUser(username: string, password: string) {
    const normalizedUsername = this.normalizeUsername(username);
    const user = await this.prisma.user.findFirst({
      where: { username: normalizedUsername, deletedAt: null },
      include: { tenant: true },
    });
    if (
      !user ||
      user.tenant.deletedAt ||
      user.isGuest ||
      !user.passwordHash
    ) {
      throw new UnauthorizedException('Credenciais inválidas');
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Credenciais inválidas');
    return user;
  }

  async registerOwner(input: {
    tenantName: string;
    ownerName: string;
    username: string;
    password: string;
  }) {
    if (process.env['AUTH_ENABLE_REGISTER'] !== '1') {
      throw new NotFoundException();
    }
    const username = this.normalizeUsername(input.username);
    await this.assertUsernameAvailable(username);
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

    return this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: { name: input.tenantName.trim() },
      });
      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          username,
          name: input.ownerName.trim(),
          role: 'ADMIN',
          passwordHash,
          isGuest: false,
        },
      });
      return { tenant, user };
    });
  }

  async registerGuest(input: { tenantName: string }) {
    if (process.env['AUTH_ENABLE_GUEST'] !== '1') {
      throw new NotFoundException();
    }

    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    return this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name: input.tenantName.trim(),
          expiresAt,
        },
      });

      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          username: `guest_${tenant.id.slice(0, 8)}`,
          name: 'Convidado',
          role: 'ADMIN',
          passwordHash: null,
          isGuest: true,
        },
      });
      return { tenant, user };
    });
  }

  async claimGuest(
    currentUserId: string,
    input: { username: string; name: string; password: string },
  ) {
    const currentUser = await this.prisma.user.findUnique({
      where: { id: currentUserId },
      include: { tenant: true },
    });
    if (!currentUser || currentUser.deletedAt || currentUser.tenant.deletedAt) {
      throw new UnauthorizedException('Sessão inválida');
    }
    if (!currentUser.isGuest) {
      throw new BadRequestException('Conta atual não é de convidado');
    }
    if (
      !currentUser.tenant.expiresAt ||
      currentUser.tenant.expiresAt.getTime() <= Date.now()
    ) {
      throw new UnauthorizedException('Conta convidada expirada');
    }

    const username = this.normalizeUsername(input.username);
    const duplicate = await this.prisma.user.findFirst({
      where: { username, deletedAt: null, NOT: { id: currentUserId } },
      select: { id: true },
    });
    if (duplicate) {
      throw new BadRequestException('Usuário já cadastrado');
    }

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const [tenant, user] = await this.prisma.$transaction([
      this.prisma.tenant.update({
        where: { id: currentUser.tenantId },
        data: { expiresAt: null },
      }),
      this.prisma.user.update({
        where: { id: currentUserId },
        data: {
          username,
          name: input.name.trim(),
          passwordHash,
          isGuest: false,
        },
      }),
    ]);

    return { tenant, user };
  }

  issueToken(user: { id: string; tenantId: string; username: string; role: string }) {
    const payload: JwtPayload = {
      sub: user.id,
      tenantId: user.tenantId,
      username: user.username,
      role: user.role as 'ADMIN' | 'USER',
    };
    return this.jwt.sign(payload, { expiresIn: '7d' });
  }

  buildPublicUser(user: {
    id: string;
    username: string;
    name: string;
    role: string;
    tenantId: string;
    allowedModules: string;
    allowedProjects?: string;
    allowedProjectTypes?: string;
    isGuest?: boolean;
  }) {
    let allowedModules: string[] = [];
    try {
      const parsed = JSON.parse(user.allowedModules || '[]');
      if (Array.isArray(parsed)) allowedModules = parsed;
    } catch {
      allowedModules = [];
    }
    let allowedProjects: string[] = [];
    try {
      const parsed = JSON.parse(user.allowedProjects || '[]');
      if (Array.isArray(parsed)) allowedProjects = parsed;
    } catch {
      allowedProjects = [];
    }
    let allowedProjectTypes: string[] = [];
    try {
      const parsed = JSON.parse(user.allowedProjectTypes || '[]');
      if (Array.isArray(parsed)) allowedProjectTypes = parsed;
    } catch {
      allowedProjectTypes = [];
    }
    return {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      tenantId: user.tenantId,
      allowedModules,
      allowedProjects,
      allowedProjectTypes,
      isGuest: user.isGuest ?? false,
    };
  }

  private normalizeUsername(username: string): string {
    return username.toLowerCase().trim();
  }

  private async assertUsernameAvailable(username: string): Promise<void> {
    const existing = await this.prisma.user.findFirst({
      where: { username, deletedAt: null },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException('Usuário já cadastrado');
    }
  }
}
