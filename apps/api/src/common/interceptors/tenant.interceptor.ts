import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  UnauthorizedException,
} from '@nestjs/common';
import { Observable } from 'rxjs';

const TENANT_HEADER_NAME = 'x-tenant-id';
const TENANT_QUERY_NAME = 'tenantId';
const ALLOW_TENANT_OVERRIDE_FLAG = 'ALLOW_TENANT_OVERRIDE';
const ENABLED_FLAG_VALUE = '1';
const TENANT_UNAUTHORIZED_MESSAGE = 'Tenant ID não identificado';

function asSingleString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === 'string');
    return asSingleString(first);
  }
  return null;
}

/**
 * Interceptor que injeta tenantId no request.
 * Source-of-truth: claim tenantId do JWT (request.user.tenantId).
 * Header/query só podem sobrescrever quando ALLOW_TENANT_OVERRIDE=1.
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();

    const jwtTenantId = asSingleString(request.user?.tenantId);
    const canOverrideTenant = process.env[ALLOW_TENANT_OVERRIDE_FLAG] === ENABLED_FLAG_VALUE;
    const headerTenantId = asSingleString(request.headers?.[TENANT_HEADER_NAME]);
    const queryTenantId = asSingleString(request.query?.[TENANT_QUERY_NAME]);

    const tenantId = canOverrideTenant
      ? jwtTenantId ?? headerTenantId ?? queryTenantId
      : jwtTenantId;

    if (!tenantId) {
      throw new UnauthorizedException(TENANT_UNAUTHORIZED_MESSAGE);
    }

    request.tenantId = tenantId;
    return next.handle();
  }
}
