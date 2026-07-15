import {
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { AgentDailyQuotaGuard } from './agent-daily-quota.guard';

function ctx(req: any): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as ExecutionContext;
}

describe('AgentDailyQuotaGuard', () => {
  let prisma: any;
  let guard: AgentDailyQuotaGuard;

  beforeEach(() => {
    prisma = {
      agentDailyQuota: {
        updateMany: jest.fn(),
        create: jest.fn(),
      },
    };
    guard = new AgentDailyQuotaGuard(prisma);
  });

  it('bloqueia sem tenant no usuário autenticado', async () => {
    await expect(guard.canActivate(ctx({ user: {} }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('consome cota com increment direto quando registro já existe', async () => {
    prisma.agentDailyQuota.updateMany.mockResolvedValueOnce({ count: 1 });
    await expect(
      guard.canActivate(ctx({ user: { tenantId: 't1' } })),
    ).resolves.toBe(true);
    expect(prisma.agentDailyQuota.create).not.toHaveBeenCalled();
  });

  it('cria bucket diário quando ainda não existe', async () => {
    prisma.agentDailyQuota.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.agentDailyQuota.create.mockResolvedValueOnce({ id: 'q1' });
    await expect(
      guard.canActivate(ctx({ user: { tenantId: 't1' } })),
    ).resolves.toBe(true);
  });

  it('bloqueia quando limite diário já foi atingido', async () => {
    prisma.agentDailyQuota.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });
    prisma.agentDailyQuota.create.mockRejectedValueOnce(new Error('race'));

    await expect(
      guard.canActivate(ctx({ user: { tenantId: 't1' } })),
    ).rejects.toEqual(
      expect.objectContaining({
        status: HttpStatus.TOO_MANY_REQUESTS,
      }),
    );
  });
});
