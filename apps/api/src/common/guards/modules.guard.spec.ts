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

  // ponytail: regression-lock da decisão do PO (2026-07-22, ver #271) — cenários
  // de compra ancoram na projeção do PESSOAL, não num módulo `simulation` na
  // COMPRA. Se este teste quebrar, alguém reabriu esse caminho sem passar pelo PO.
  it("nega 'simulation' para projeto COMPRA (cenários ancoram no PESSOAL — decisão PO 2026-07-22, ver #271)", async () => {
    reflector.getAllAndOverride.mockReturnValue('simulation');
    const guard = new ModulesGuard(reflector as any, prisma as any);

    await expect(
      guard.canActivate(context(['simulation'])),
    ).rejects.toThrow('Sem permissão para este tipo de projeto');
  });

  // #291: dieta — receipts/cashFlow tinham 0 usos reais em COMPRA (dado real
  // do banco), removidos de TYPE_MODULES. Se estes testes quebrarem, alguém
  // reabriu a superfície sem passar pelo PO.
  it("nega 'receipts' para projeto COMPRA (dieta #291 — 0 usos reais)", async () => {
    reflector.getAllAndOverride.mockReturnValue('receipts');
    const guard = new ModulesGuard(reflector as any, prisma as any);

    await expect(
      guard.canActivate(context(['receipts'])),
    ).rejects.toThrow('Sem permissão para este tipo de projeto');
  });

  it("nega 'cashFlow' para projeto COMPRA (dieta #291 — 0 usos reais)", async () => {
    reflector.getAllAndOverride.mockReturnValue('cashFlow');
    const guard = new ModulesGuard(reflector as any, prisma as any);

    await expect(
      guard.canActivate(context(['cashFlow'])),
    ).rejects.toThrow('Sem permissão para este tipo de projeto');
  });

  // Regression-lock da issue #293 — CARRO passou a ter financing (motor
  // PRICE/SAC compartilhado com CASA); só falha aqui se TYPE_MODULES[CARRO]
  // perder o slug 'financing'.
  it("permite 'financing' para projeto CARRO (issue #293)", async () => {
    reflector.getAllAndOverride.mockReturnValue('financing');
    prisma.project.findFirst.mockResolvedValue({ type: 'CARRO' });
    const carroContext = (allowedModules: string[]) =>
      ({
        getHandler: jest.fn(),
        getClass: jest.fn(),
        switchToHttp: () => ({
          getRequest: () => ({
            params: { projectId: 'project-1' },
            user: {
              role: 'USER',
              tenantId: 'tenant-1',
              allowedProjectTypes: ['CARRO'],
              allowedModules,
            },
          }),
        }),
      }) as any;
    const guard = new ModulesGuard(reflector as any, prisma as any);

    await expect(
      guard.canActivate(carroContext(['financing'])),
    ).resolves.toBe(true);
  });
});
