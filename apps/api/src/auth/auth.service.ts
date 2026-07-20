import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { deriveObjectiveAccess, ProjectType } from '@reformaflow/domain';
import { Prisma } from '@prisma/client';
import { JwtPayload } from './jwt.strategy';

const BCRYPT_ROUNDS = 10;
const SELF_SERVICE_ROLE = 'USER';
const DUPLICATE_USERNAME_MESSAGE = 'Usuário já cadastrado';

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
        demoMode && user.isGuest && (!hasPersonalProject || !hasReformaProject),
      tourStorageKey: `rf_demo_tour_seen:${user.tenantId}`,
    };
  }

  async validateUser(username: string, password: string) {
    const normalizedUsername = this.normalizeUsername(username);
    const user = await this.prisma.user.findFirst({
      where: { username: normalizedUsername, deletedAt: null },
      include: { tenant: true },
    });
    if (!user || user.tenant.deletedAt || user.isGuest || !user.passwordHash) {
      throw new UnauthorizedException('Credenciais inválidas');
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Credenciais inválidas');
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    return user;
  }

  async registerOwner(input: {
    tenantName: string;
    ownerName: string;
    username: string;
    password: string;
    projectTypes?: ProjectType[];
  }) {
    if (process.env['AUTH_ENABLE_REGISTER'] !== '1') {
      throw new NotFoundException();
    }
    if (!input.projectTypes || input.projectTypes.length === 0) {
      throw new BadRequestException('Selecione ao menos um objetivo');
    }
    const username = this.normalizeUsername(input.username);
    const access = deriveObjectiveAccess(input.projectTypes);
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Creating the tenant first acquires SQLite's write lock. The duplicate
        // check then runs inside the same transaction, so concurrent signups
        // cannot both observe an available canonical username.
        const tenant = await tx.tenant.create({
          data: { name: input.tenantName.trim() },
        });
        const duplicate = await tx.user.findFirst({
          where: { username, deletedAt: null },
          select: { id: true },
        });
        if (duplicate)
          throw new BadRequestException(DUPLICATE_USERNAME_MESSAGE);

        const user = await tx.user.create({
          data: {
            tenantId: tenant.id,
            username,
            name: input.ownerName.trim(),
            role: SELF_SERVICE_ROLE,
            passwordHash,
            isGuest: false,
            allowedProjectTypes: JSON.stringify(access.allowedProjectTypes),
            allowedModules: JSON.stringify(access.allowedModules),
            lastLoginAt: new Date(),
          },
        });
        return { tenant, user };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new BadRequestException(DUPLICATE_USERNAME_MESSAGE);
      }
      throw error;
    }
  }

  async getSelfObjectives(userId: string) {
    const user = await this.findActiveUser(userId);
    return this.buildObjectiveResponse(user);
  }

  async updateSelfObjectives(userId: string, projectTypes: ProjectType[]) {
    const access = deriveObjectiveAccess(projectTypes);
    const user = await this.findActiveUser(userId);
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        allowedProjectTypes: JSON.stringify(access.allowedProjectTypes),
        allowedModules: JSON.stringify(access.allowedModules),
      },
    });
    return this.buildObjectiveResponse(updated);
  }

  private async findActiveUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { tenant: true },
    });
    if (!user || user.deletedAt || user.tenant.deletedAt) {
      throw new UnauthorizedException('Sessão inválida');
    }
    return user;
  }

  private buildObjectiveResponse(user: {
    allowedProjectTypes: string;
    allowedModules: string;
  }) {
    const publicUser = this.buildPublicUser({
      id: '',
      username: '',
      name: '',
      role: SELF_SERVICE_ROLE,
      tenantId: '',
      ...user,
    });
    return {
      projectTypes: publicUser.allowedProjectTypes,
      allowedProjectTypes: publicUser.allowedProjectTypes,
      allowedModules: publicUser.allowedModules,
    };
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
          email: null,
          username: `guest_${tenant.id.slice(0, 8)}`,
          name: 'Convidado',
          role: 'ADMIN',
          passwordHash: null,
          isGuest: true,
          lastLoginAt: new Date(),
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
      throw new BadRequestException(DUPLICATE_USERNAME_MESSAGE);
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
          lastLoginAt: new Date(),
        },
      }),
    ]);

    return { tenant, user };
  }

  issueToken(user: {
    id: string;
    tenantId: string;
    username: string;
    role: string;
    sessionVersion: number;
  }) {
    const payload: JwtPayload = {
      sub: user.id,
      tenantId: user.tenantId,
      username: user.username,
      role: user.role as 'ADMIN' | 'USER',
      sv: user.sessionVersion,
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
    email?: string | null;
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
      email: user.email ?? null,
      allowedModules,
      allowedProjects,
      allowedProjectTypes,
      isGuest: user.isGuest ?? false,
    };
  }

  private normalizeUsername(username: string): string {
    return username.toLowerCase().trim();
  }
}
