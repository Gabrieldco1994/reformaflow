import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  isFullAccessRole,
  userCanAccessProject,
  userCanAccessProjectType,
  ACL_NOT_FOUND_MESSAGE,
} from '../access-rules';
import { PrismaService } from '../../prisma/prisma.service';
import { SERVICE_OWNED_PROJECT_ACCESS_KEY } from '../decorators/service-owned-project-access.decorator';

/** Campos que carregam um ID de projeto em params/query/body. */
const PROJECT_ID_FIELDS = ['projectId', 'sourceProjectId', 'targetProjectId'];
export const OPAQUE_PROJECT_ACCESS = 'opaqueProjectAccess';

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
 * Excecao explicita: handlers marcados com `@ServiceOwnedProjectAccess()` (metadata estatica
 * por handler, hoje so os cinco do controller de sessoes de importacao) pulam a extracao de ids; o service deles faz
 * reauth + ancora/cartao. Ausencia da marca NAO protege um handler novo: o guard so age
 * quando encontra um id de projeto reconhecido.
 *
 * Observacao: rotas que referenciam um projeto apenas via ID de recurso-filho
 * (ex.: budget-allocations/:id, links cross-project por targetExpenseId) nao sao
 * cobertas aqui — exigem checagem no service.
 */
@Injectable()
export class ProjectAccessGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user) return true;
    if (isFullAccessRole(user.role)) return true;
    if (
      this.reflector.get<boolean | undefined>(
        SERVICE_OWNED_PROJECT_ACCESS_KEY,
        context.getHandler(),
      ) === true
    ) {
      return true;
    }
    const denied = (message: string) => Reflect.getMetadata(OPAQUE_PROJECT_ACCESS, context.getHandler())
      ? new NotFoundException(ACL_NOT_FOUND_MESSAGE)
      : new ForbiddenException(message);

    const ids = new Set<string>([
      ...collectProjectIds(request.params),
      ...collectProjectIds(request.query),
      ...collectProjectIds(request.body),
    ]);

    for (const projectId of ids) {
      if (!userCanAccessProject(user.role, user.allowedProjects, projectId)) {
        throw denied('Sem permissao para acessar este projeto');
      }
      const project = await this.prisma.project.findFirst({
        where: { id: projectId, tenantId: user.tenantId },
        select: { type: true },
      });
      if (!project) {
        throw denied('Sem permissao para acessar este projeto');
      }
      if (
        !userCanAccessProjectType(
          user.role,
          user.allowedProjectTypes,
          user.allowedModules ?? [],
          project.type,
        )
      ) {
        throw denied(
          'Sem permissao para acessar este tipo de projeto',
        );
      }
    }
    return true;
  }
}
