import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { isNonGuestFullAccess } from '../common/access-rules';

/**
 * Mensagem única da recusa. 403 (e não "vazio equivalente") é o contrato
 * aprovado em #449: a rota é administrativa, então recusar é a resposta honesta
 * — e não existe informação de negócio que o status revele, porque o corpo não
 * diz uma palavra sobre o que existe do outro lado.
 */
export const BUDGET_ALLOCATION_ADMIN_ONLY =
  'Alocação de Orçamento é um histórico administrativo somente leitura';

/**
 * #449 B2 — Budget Allocation só é legível por requisitante administrativo
 * autenticado do tenant: ADMIN ou OWNER (`isFullAccessRole`), nunca convidado.
 *
 * Não pode virar `@Roles('ADMIN')`: o `RolesGuard` aprova por `isFullAccessRole`
 * sem nunca ler `isGuest`, e o convidado de demo nasce com
 * `role: 'ADMIN', isGuest: true` (#497) — a troca reabriria o histórico
 * administrativo para todo convidado de demonstração.
 */
@Injectable()
export class BudgetAllocationAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    if (!isNonGuestFullAccess(request?.user)) {
      throw new ForbiddenException(BUDGET_ALLOCATION_ADMIN_ONLY);
    }
    return true;
  }
}
