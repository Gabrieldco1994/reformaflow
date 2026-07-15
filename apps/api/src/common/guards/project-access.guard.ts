import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import {
  isFullAccessRole,
  userCanAccessProject,
  userCanAccessProjectType,
} from '../access-rules';
import { PrismaService } from '../../prisma/prisma.service';

/** Campos que carregam um ID de projeto em params/query/body. */
const PROJECT_ID_FIELDS = ['projectId', 'sourceProjectId', 'targetProjectId'];

function collectProjectIds(
  source: Record<string, unknown> | undefined,
): string[] {
  if (!source) return [];
  const ids: string[] = [];
  for (const field of PROJECT_ID_FIELDS) {
    const v = source[field];
    if (typeof v === 'string' && v) ids.push(v);
  }
  return ids;
}

/**
 * Enforcement de acesso por PROJETO. Bloqueia quando o usuário (restrito) tenta
 * acessar um projeto fora da sua lista. O ID do projeto é buscado em params,
 * query e body (projectId/sourceProjectId/targetProjectId) — assim cobre tanto
 * as rotas `projects/:projectId/*` quanto as que recebem o projeto por
 * query/body (ex.: agent/chat, budget-allocations).
 *
 * Roda como guard global (apos Jwt/Roles/Modules). Semantica opt-in:
 * allowedProjects vazio = sem restricao; nao-vazio = so os listados.
 * ADMIN/OWNER sempre passam. Rotas sem projeto e usuarios sem restricao passam direto.
 *
 * Observacao: rotas que referenciam um projeto apenas via ID de recurso-filho
 * (ex.: budget-allocations/:id, links cross-project por targetExpenseId) nao sao
 * cobertas aqui — exigem checagem no service.
 */
@Injectable()
export class ProjectAccessGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user) return true;
    if (isFullAccessRole(user.role)) return true;

    const ids = new Set<string>([
      ...collectProjectIds(request.params),
      ...collectProjectIds(request.query),
      ...collectProjectIds(request.body),
    ]);

    for (const projectId of ids) {
      if (!userCanAccessProject(user.role, user.allowedProjects, projectId)) {
        throw new ForbiddenException('Sem permissao para acessar este projeto');
      }
      const project = await this.prisma.project.findFirst({
        where: { id: projectId, tenantId: user.tenantId },
        select: { type: true },
      });
      if (!project) {
        throw new ForbiddenException('Sem permissao para acessar este projeto');
      }
      if (
        !userCanAccessProjectType(
          user.role,
          user.allowedProjectTypes,
          user.allowedModules ?? [],
          project.type,
        )
      ) {
        throw new ForbiddenException(
          'Sem permissao para acessar este tipo de projeto',
        );
      }
    }
    return true;
  }
}
