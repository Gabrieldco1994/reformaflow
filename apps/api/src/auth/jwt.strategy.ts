import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { reconcileUserModules } from '@reformaflow/domain';
import { parseGrantJson } from './grant-json';

export interface JwtPayload {
  sub: string;
  tenantId: string;
  username: string;
  role: 'ADMIN' | 'USER';
  sv?: number; // sessionVersion — ausente em tokens antigos (tratados como versão 0)
}

const cookieExtractor = (req: Request): string | null => {
  if (req?.cookies && typeof req.cookies['rf_token'] === 'string') {
    return req.cookies['rf_token'];
  }
  return null;
};

function resolveJwtSecret(): string {
  const secret = process.env['JWT_SECRET'];
  if (secret) return secret;
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('JWT_SECRET não definido em produção');
  }
  return 'dev-secret-change-me';
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        cookieExtractor,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: resolveJwtSecret(),
    });
  }

  async validate(payload: JwtPayload) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { tenant: true },
    });
    if (!user || user.deletedAt || !user.tenant || user.tenant.deletedAt) {
      throw new UnauthorizedException('Sessão inválida');
    }
    if ((payload.sv ?? 0) !== user.sessionVersion) {
      throw new UnauthorizedException('Sessão encerrada');
    }
    if (
      user.isGuest &&
      user.tenant.expiresAt &&
      user.tenant.expiresAt.getTime() <= Date.now()
    ) {
      throw new UnauthorizedException('Sessão inválida');
    }

    // ponytail: fire-and-forget, at most 1 write per user per 5min
    const stale =
      !user.lastActivityAt ||
      Date.now() - user.lastActivityAt.getTime() > 5 * 60 * 1000;
    if (stale) {
      this.prisma.user
        .update({ where: { id: user.id }, data: { lastActivityAt: new Date() } })
        .catch(() => {});
    }
    // All three grant JSON columns share the SAME fail-closed parser (see
    // grant-json.ts) — a corrupted `allowedModules`/`allowedProjectTypes` is
    // no less dangerous than a corrupted `allowedProjects`: reconciliation
    // and scope resolution downstream both trust these to be real arrays.
    const modulesGrant = parseGrantJson(user.allowedModules);
    if (!modulesGrant.valid) {
      throw new UnauthorizedException('Sessão inválida');
    }
    const projectsGrant = parseGrantJson(user.allowedProjects);
    if (!projectsGrant.valid) {
      throw new UnauthorizedException('Sessão inválida');
    }
    const typesGrant = parseGrantJson(user.allowedProjectTypes);
    if (!typesGrant.valid) {
      throw new UnauthorizedException('Sessão inválida');
    }
    const allowedProjects = projectsGrant.values;
    const allowedProjectTypes = typesGrant.values;

    return {
      id: user.id,
      tenantId: user.tenantId,
      username: user.username,
      name: user.name,
      role: user.role,
      // Reconciliação em tempo de leitura — este `request.user` é o que o
      // `ModulesGuard` consulta. Sem isto, um usuário antigo recebe o módulo
      // na resposta de login (o web mostra o menu) mas leva 403 ao clicar.
      // Ver `reconcileUserModules` no domínio.
      allowedModules: reconcileUserModules(modulesGrant.values, allowedProjectTypes),
      allowedProjects,
      allowedProjectTypes,
      isGuest: user.isGuest,
    };
  }
}
