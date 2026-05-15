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

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        cookieExtractor,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: process.env['JWT_SECRET'] ?? 'dev-secret-change-me',
    });
  }

  async validate(payload: JwtPayload) {
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.deletedAt) {
      throw new UnauthorizedException('Sessão inválida');
    }

    let allowedModules: string[] = [];
    try {
      const parsed = JSON.parse(user.allowedModules || '[]');
      if (Array.isArray(parsed)) allowedModules = parsed;
    } catch {
      allowedModules = [];
    }

    return {
      id: user.id,
      tenantId: user.tenantId,
      username: user.username,
      name: user.name,
      role: user.role,
      allowedModules,
    };
  }
}
