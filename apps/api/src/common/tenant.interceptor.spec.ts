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

/**
 * B0 (#447) — "Produção rejeita override sem sessão". Today
 * `ALLOW_TENANT_OVERRIDE=1` alone is enough to accept a header/query tenantId
 * even with ZERO JWT (`request.user` undefined) — the flag substitutes for a
 * session instead of only ever OVERRIDING an already-authenticated session's
 * tenant claim. That directly contradicts the existing "permite override por
 * header quando ALLOW_TENANT_OVERRIDE=true" test above (same file, same
 * describe): that test is the CURRENT/legacy behavior this program flags as
 * the vulnerability, not a contract this suite defends going forward — it is
 * expected to be tightened (require `request.user` even when the flag is on)
 * by the implementer alongside this fix, not left as two contradictory tests.
 */
describe("TenantInterceptor — sem JWT, override nunca substitui a sessão (B0 #447)", () => {
  const originalOverride = process.env['ALLOW_TENANT_OVERRIDE'];
  let interceptor: TenantInterceptor;

  beforeEach(() => {
    interceptor = new TenantInterceptor();
  });

  afterAll(() => {
    if (originalOverride === undefined)
      delete process.env['ALLOW_TENANT_OVERRIDE'];
    else process.env['ALLOW_TENANT_OVERRIDE'] = originalOverride;
  });

  it("401 sem request.user mesmo com ALLOW_TENANT_OVERRIDE=1 e header presente", () => {
    process.env['ALLOW_TENANT_OVERRIDE'] = '1';
    const request: any = {
      headers: { 'x-tenant-id': 'tenant-header' },
      query: {},
      user: undefined,
    };

    expect(() =>
      interceptor.intercept(makeContext(request), { handle: () => of('ok') }),
    ).toThrow(UnauthorizedException);
  });

  it("401 sem request.user mesmo com ALLOW_TENANT_OVERRIDE=1 e query presente", () => {
    process.env['ALLOW_TENANT_OVERRIDE'] = '1';
    const request: any = {
      headers: {},
      query: { tenantId: 'tenant-query' },
      user: undefined,
    };

    expect(() =>
      interceptor.intercept(makeContext(request), { handle: () => of('ok') }),
    ).toThrow(UnauthorizedException);
  });
});
