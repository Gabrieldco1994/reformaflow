import { ForbiddenException } from '@nestjs/common';
import { PendenciaController } from './pendencia.controller';

const REQUESTER = {
  id: 'user-480',
  role: 'USER',
  allowedProjects: ['pessoal', 'reforma-visible'],
  allowedProjectTypes: ['PESSOAL', 'REFORMA'],
  allowedModules: ['pendencias', 'expenses'],
};

describe('PendenciaController financial candidate ACL (#480)', () => {
  it('forwards the authenticated requester to the financial queue', async () => {
    const findFinancialQueue = jest.fn().mockResolvedValue({ total: 0, grupos: [] });
    const controller = new PendenciaController({ findFinancialQueue } as any);

    await controller.findFinancialQueue('tenant', 'pessoal', '2026-08', REQUESTER);

    expect(findFinancialQueue).toHaveBeenCalledWith(
      'tenant',
      'pessoal',
      '2026-08',
      REQUESTER,
    );
  });

  it('fails closed before calling the service when requester is missing', async () => {
    const findFinancialQueue = jest.fn();
    const controller = new PendenciaController({ findFinancialQueue } as any);

    expect(() =>
      controller.findFinancialQueue(
        'tenant',
        'pessoal',
        '2026-08',
        undefined as any,
      ),
    ).toThrow(ForbiddenException);
    expect(findFinancialQueue).not.toHaveBeenCalled();
  });
});
