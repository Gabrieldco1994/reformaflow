import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MODULE_KEY, ModuleSlug } from '../decorators/require-module.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { projectTypeHasModule } from '../access-rules';

@Injectable()
export class ModulesGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<ModuleSlug>(MODULE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const request = context.switchToHttp().getRequest();
    const { user } = request;
    if (!user) throw new ForbiddenException('Não autenticado');

    const isAdmin = user.role === 'ADMIN';

    if (!isAdmin) {
      const allowed: string[] = Array.isArray(user.allowedModules)
        ? user.allowedModules
        : [];
      if (!allowed.includes(required)) {
        throw new ForbiddenException(
          `Sem permissão para o módulo "${required}"`,
        );
      }
    }

    const projectId: string | undefined = request.params?.projectId;
    if (projectId) {
      const project = await this.prisma.project.findFirst({
        where: { id: projectId, tenantId: user.tenantId },
        select: { type: true },
      });
      if (!project) throw new NotFoundException('Projeto não encontrado');
      if (!projectTypeHasModule(project.type, required)) {
        throw new ForbiddenException(
          `Módulo "${required}" não disponível em projetos do tipo "${project.type}"`,
        );
      }
    }

    return true;
  }
}
