import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';

export interface JwtPayload {
  sub: string;
  tenantId: string;
  username: string;
  role: 'ADMIN' | 'USER';
}

const cookieExtractor = (req: Request): string | null => {
  if (req?.cookies && typeof req.cookies['rf_token'] === 'string') {
    return req.cookies['rf_token'];
  }
  return null;
};

// ponytail: cookie sessions duram 7 dias, então POST /auth/login raramente
// é chamado de novo — sem isto, lastLoginAt fica parado no 1º login mesmo
// com uso diário. Throttle evita escrita a cada request; fire-and-forget
// evita latência no caminho crítico de toda request autenticada.
const LAST_SEEN_THROTTLE_MS = 15 * 60 * 1000;

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
    if (
      user.isGuest &&
      user.tenant.expiresAt &&
      user.tenant.expiresAt.getTime() <= Date.now()
    ) {
      throw new UnauthorizedException('Sessão inválida');
    }

    if (
      !user.lastLoginAt ||
      Date.now() - user.lastLoginAt.getTime() > LAST_SEEN_THROTTLE_MS
    ) {
      this.prisma.user
        .update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
        .catch(() => undefined);
    }

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
      tenantId: user.tenantId,
      username: user.username,
      name: user.name,
      role: user.role,
      allowedModules,
      allowedProjects,
      allowedProjectTypes,
      isGuest: user.isGuest,
    };
  }
}
