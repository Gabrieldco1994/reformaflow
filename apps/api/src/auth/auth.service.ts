import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from './jwt.strategy';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  async validateUser(username: string, password: string) {
    const user = await this.prisma.user.findFirst({
      where: { username: username.toLowerCase().trim() },
    });
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Credenciais inválidas');
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Credenciais inválidas');
    return user;
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
    };
  }
}
