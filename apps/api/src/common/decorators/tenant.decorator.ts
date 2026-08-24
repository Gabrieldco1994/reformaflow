import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';

const TENANT_MISSING_MESSAGE = 'Tenant ID não identificado';

/**
 * Factory do `@CurrentTenant()`, exportada para permitir identificação precisa
 * por reflexão (ver `tenant-resolution.contract.spec.ts`): o contrato precisa
 * saber QUAIS métodos usam este decorator para exigir o TenantInterceptor no
 * método ou na classe. Comparar por identidade de função evita tanto o falso
 * verde do casamento textual quanto o falso positivo de controllers que aplicam
 * o interceptor por método (ex.: TenantController).
 */
export const currentTenantFactory = (
  _data: unknown,
  ctx: ExecutionContext,
): string => {
  const request = ctx.switchToHttp().getRequest();
  const tenantId = request?.tenantId;
  if (typeof tenantId !== 'string' || tenantId.trim().length === 0) {
    throw new UnauthorizedException(TENANT_MISSING_MESSAGE);
  }
  return tenantId;
};

/**
 * Decorator para extrair tenantId do request.
 * O tenantId é injetado pelo TenantInterceptor após autenticação.
 *
 * Falha alto (401) quando `request.tenantId` está ausente — tipicamente porque o
 * controller esqueceu `@UseInterceptors(TenantInterceptor)`. Devolver `undefined`
 * tipado como `string` era pior que um erro: o `tsc` acreditava na anotação e o
 * `undefined` vazava até o Prisma, onde num `where` de topo ele é DESCARTADO.
 * Foi assim que `remove-rule` sem tenant virou "apague essa chave de todos os
 * tenants" (#589). Um controller futuro que esquecer o interceptor quebra no
 * primeiro request, em vez de corromper dados em silêncio.
 */
export const CurrentTenant = createParamDecorator(currentTenantFactory);

/**
 * Decorator para extrair userId do request.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
