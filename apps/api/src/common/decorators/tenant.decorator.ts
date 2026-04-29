import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Decorator para extrair tenantId do request.
 * O tenantId é injetado pelo TenantInterceptor após autenticação.
 */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest();
    return request.tenantId;
  },
);

/**
 * Decorator para extrair userId do request.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
