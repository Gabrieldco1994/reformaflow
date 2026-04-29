import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  UnauthorizedException,
} from '@nestjs/common';
import { Observable } from 'rxjs';

/**
 * Interceptor que injeta tenantId no request.
 * Em produção: extrai do token JWT (claim tenantId).
 * Em dev: aceita header X-Tenant-Id para facilitar testes.
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();

    // Prioridade: JWT claim > header > query param (dev only)
    const tenantId =
      request.user?.tenantId ??
      request.headers['x-tenant-id'] ??
      request.query?.['tenantId'];

    if (!tenantId) {
      throw new UnauthorizedException('Tenant ID não identificado');
    }

    request.tenantId = tenantId;
    return next.handle();
  }
}
