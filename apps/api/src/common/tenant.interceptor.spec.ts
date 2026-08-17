import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { TenantInterceptor } from './interceptors/tenant.interceptor';

function makeContext(request: any): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as ExecutionContext;
}

describe("TenantInterceptor", () => {
  const originalOverride = process.env['ALLOW_TENANT_OVERRIDE'];
  let interceptor: TenantInterceptor;

  beforeEach(() => {
    interceptor = new TenantInterceptor();
    delete process.env['ALLOW_TENANT_OVERRIDE'];
  });

  afterAll(() => {
    if (originalOverride === undefined)
      delete process.env['ALLOW_TENANT_OVERRIDE'];
    else process.env['ALLOW_TENANT_OVERRIDE'] = originalOverride;
  });

  it("prioriza tenantId do JWT sobre headers/query", async () => {
    const request: any = {
      user: { tenantId: "tenant-jwt" },
      headers: { "x-tenant-id": "tenant-header" },
      query: { tenantId: "tenant-query" },
    };
    const result$ = interceptor.intercept(makeContext(request), {
      handle: () => of("ok"),
    });

    await expect(firstValueFrom(result$)).resolves.toBe("ok");
    expect(request.tenantId).toBe("tenant-jwt");
  });

  it("bloqueia override por header/query quando ALLOW_TENANT_OVERRIDE=false", () => {
    const request: any = {
      headers: { "x-tenant-id": "tenant-header" },
      query: { tenantId: "tenant-query" },
      user: undefined,
    };

    expect(() =>
      interceptor.intercept(makeContext(request), { handle: () => of("ok") }),
    ).toThrow(UnauthorizedException);
  });

  it("permite override por header quando ALLOW_TENANT_OVERRIDE=true", async () => {
    process.env['ALLOW_TENANT_OVERRIDE'] = '1';
    const request: any = {
      headers: { 'x-tenant-id': 'tenant-header' },
      query: {},
      user: undefined,
    };

    const result$ = interceptor.intercept(makeContext(request), {
      handle: () => of("ok"),
    });
    await expect(firstValueFrom(result$)).resolves.toBe("ok");
    expect(request.tenantId).toBe("tenant-header");
  });
});
