import { ForbiddenException } from '@nestjs/common';
import { ModulesGuard } from './modules.guard';

describe('ModulesGuard', () => {
  const reflector = { getAllAndOverride: jest.fn() };
  const prisma = {
    project: { findFirst: jest.fn() },
  };

  const context = (allowedModules: string[]) =>
    ({
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => ({
          params: { projectId: 'project-1' },
          user: {
            role: 'USER',
            tenantId: 'tenant-1',
            allowedProjectTypes: ['COMPRA'],
            allowedModules,
          },
        }),
      }),
    }) as any;

  beforeEach(() => {
    jest.clearAllMocks();
    reflector.getAllAndOverride.mockReturnValue([
      'priceCompare',
      'expenses',
    ]);
    prisma.project.findFirst.mockResolvedValue({ type: 'COMPRA' });
  });

  it('requires every module declared by the endpoint', async () => {
    const guard = new ModulesGuard(reflector as any, prisma as any);

    await expect(
      guard.canActivate(context(['priceCompare'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows the request when user and project support every module', async () => {
    const guard = new ModulesGuard(reflector as any, prisma as any);

    await expect(
      guard.canActivate(context(['priceCompare', 'expenses'])),
    ).resolves.toBe(true);
  });
});
