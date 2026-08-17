import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { deriveObjectiveAccess, ProjectType, reconcileUserModules } from '@reformaflow/domain';
import { Prisma } from '@prisma/client';
import { JwtPayload } from './jwt.strategy';
import { parseGrantJson } from './grant-json';
import { isFullAccessRole } from '../common/access-rules';

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

  async validateUser(input: string, password: string) {
    const normalizedInput = this.normalizeUsername(input);
    const isEmail = input.includes('@');
    
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { username: normalizedInput },
          ...(isEmail ? [{ email: input.toLowerCase() }] : []),
        ],
        deletedAt: null,
      },
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
    tenantName?: string;
    ownerName: string;
    email: string;
    username?: string;
    password: string;
    projectTypes?: ProjectType[];
  }) {
    if (process.env['AUTH_ENABLE_REGISTER'] !== '1') {
      throw new NotFoundException();
    }
    
    const projectTypes = input.projectTypes && input.projectTypes.length > 0
      ? input.projectTypes
      : [ProjectType.PESSOAL];
    const access = deriveObjectiveAccess(projectTypes);
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    
    // Derive username from email if not provided
    const baseUsername = input.username || input.email.split('@')[0];
    const normalizedBase = this.normalizeUsername(baseUsername);
    
    // Derive tenantName from ownerName if not provided
    const tenantName = input.tenantName || `Vida de ${input.ownerName.split(' ')[0]}`;

    try {
      return await this.prisma.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({
          data: { name: tenantName.trim() },
        });
        
        // Check email uniqueness first
        const emailExists = await tx.user.findFirst({
          where: { email: input.email.toLowerCase(), deletedAt: null },
          select: { id: true },
        });
        if (emailExists) {
          throw new BadRequestException('Este e-mail já está cadastrado');
        }
        
        // Resolve username collisions by suffixing -2, -3, etc.
        // Must run inside transaction to serialize concurrent signups via SQLite write lock.
        // Limit to 50 attempts to avoid holding transaction open indefinitely.
        let resolvedUsername = normalizedBase;
        let suffix = 2;
        const MAX_COLLISION_ATTEMPTS = 50;
        while (suffix <= MAX_COLLISION_ATTEMPTS) {
          const duplicate = await tx.user.findFirst({
            where: { username: resolvedUsername, deletedAt: null },
            select: { id: true },
          });
          if (!duplicate) break;
          resolvedUsername = `${normalizedBase}-${suffix}`;
          suffix++;
        }
        if (suffix > MAX_COLLISION_ATTEMPTS) {
          throw new BadRequestException('Não foi possível gerar um usuário único. Tente novamente.');
        }

        const user = await tx.user.create({
          data: {
            tenantId: tenant.id,
            username: resolvedUsername,
            name: input.ownerName.trim(),
            email: input.email.toLowerCase(),
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
      if (error instanceof BadRequestException) {
        throw error;
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new BadRequestException('Este e-mail já está cadastrado');
      }
      throw error;
    }
  }

  async getSelfObjectives(userId: string) {
    const user = await this.findActiveUser(userId);
    return this.buildObjectiveResponse(user);
  }

  async updateSelfObjectives(userId: string, projectTypes: ProjectType[]) {
    if (!projectTypes || projectTypes.length === 0) {
      throw new BadRequestException(
        'Selecione ao menos um objetivo — isso zeraria o acesso da conta',
      );
    }
    const access = deriveObjectiveAccess(projectTypes);
    const user = await this.findActiveUser(userId);

    // Authorization read happens here, right before the write, on the SAME
    // row `findActiveUser` already loaded — no re-check after the update
    // (TOCTOU-safe: nothing observes/mutates the grant between read and write).
    //
    // Ordem importa: convidado é sempre 403 (mesmo com role ADMIN — ver
    // `registerGuest`, que cria o convidado com role ADMIN). Só depois disso
    // checamos full-access (ADMIN/OWNER de verdade), e só então o grant.
    if (user.isGuest) {
      throw new ForbiddenException(
        'Conta convidada não gerencia objetivos próprios',
      );
    }
    if (!isFullAccessRole(user.role)) {
      // `allowedProjects` é o grant que decide "gerenciado" — usa o MESMO
      // parser fail-closed que buildPublicUser/JwtStrategy (ver grant-json.ts).
      // JSON corrompido não pode degradar para wildcard (isso liberaria a
      // troca de objetivos pra quem na verdade está gerenciado por outra conta).
      const grant = parseGrantJson(user.allowedProjects);
      if (!grant.valid) {
        throw new UnauthorizedException('Sessão inválida');
      }
      if (grant.values.length > 0) {
        throw new ForbiddenException(
          'Conta gerenciada não pode alterar os próprios objetivos',
        );
      }
    }

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
    // Formatting-only: reuses the SAME module/type reconciliation as
    // `buildPublicUser` (see `reconcileModulesAndTypes`) but never routes
    // through `buildPublicUser` itself. `buildPublicUser` fails closed on a
    // corrupted `allowedProjects` grant (see grant-json.ts) — a security check
    // that has NOTHING to do with formatting an objectives response, and
    // running it here would risk throwing 401 AFTER `updateSelfObjectives`
    // already committed the write (no authorizing check after write).
    const { allowedModules, allowedProjectTypes } = this.reconcileModulesAndTypes(
      user.allowedModules,
      user.allowedProjectTypes,
    );
    return {
      projectTypes: allowedProjectTypes,
      allowedProjectTypes,
      allowedModules,
    };
  }

  /** Shared JSON→array reconciliation for `allowedModules`/`allowedProjectTypes` (lenient — see AGENTS.md). */
  private reconcileModulesAndTypes(
    allowedModulesJson: string,
    allowedProjectTypesJson: string,
  ): { allowedModules: string[]; allowedProjectTypes: string[] } {
    let allowedModules: string[] = [];
    try {
      const parsed = JSON.parse(allowedModulesJson || '[]');
      if (Array.isArray(parsed)) allowedModules = parsed;
    } catch {
      allowedModules = [];
    }
    let allowedProjectTypes: string[] = [];
    try {
      const parsed = JSON.parse(allowedProjectTypesJson || '[]');
      if (Array.isArray(parsed)) allowedProjectTypes = parsed;
    } catch {
      allowedProjectTypes = [];
    }
    return {
      allowedModules: reconcileUserModules(allowedModules, allowedProjectTypes),
      allowedProjectTypes,
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
    // `allowedProjects` is the security-sensitive grant — same fail-closed
    // parser as JwtStrategy.validate (see grant-json.ts). Corrupted JSON must
    // NOT degrade to "[]" (read downstream as "no restriction"/full access);
    // it fails the whole login/session build instead.
    const projectsGrant = parseGrantJson(user.allowedProjects);
    if (!projectsGrant.valid) {
      throw new UnauthorizedException('Sessão inválida');
    }
    const allowedProjects = projectsGrant.values;

    // Reconciliação em tempo de leitura — ver `reconcileUserModules` no domínio
    // para o porquê. Resumo: `allowedModules` é uma FOTO do signup, e módulo
    // novo em `TYPE_MODULES` não alcançava quem já tinha conta.
    //
    // Este é UM dos dois pontos de leitura do snapshot. O outro é
    // `JwtStrategy.validate`, que monta o `request.user` do `ModulesGuard`.
    // Os dois precisam reconciliar: só aqui faria o menu aparecer no web e a
    // API responder 403 — pior que o bug original.
    const { allowedModules, allowedProjectTypes } = this.reconcileModulesAndTypes(
      user.allowedModules,
      user.allowedProjectTypes ?? '[]',
    );

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
