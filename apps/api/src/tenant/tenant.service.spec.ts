import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TenantService } from './tenant.service';

describe('TenantService.remove', () => {
  function makeService(overrides: { tenant?: unknown } = {}) {
    const prisma = {
      tenant: {
        findUnique: jest.fn().mockResolvedValue(
          'tenant' in overrides ? overrides.tenant : { id: 't2', name: 'Tenant Teste' },
        ),
        delete: jest.fn(),
      },
      project: { deleteMany: jest.fn() },
      user: { deleteMany: jest.fn() },
    } as any;
    return { service: new TenantService(prisma), prisma };
  }

  it('blocks excluding the requester\'s own tenant', async () => {
    const { service } = makeService();
    await expect(service.remove('t1', 't1')).rejects.toThrow(BadRequestException);
  });

  it('404s when the tenant does not exist', async () => {
    const { service } = makeService({ tenant: null });
    await expect(service.remove('t2', 't1')).rejects.toThrow(NotFoundException);
  });

  it('cascades: deletes projects, then users, then the tenant', async () => {
    const { service, prisma } = makeService();
    await service.remove('t2', 't1');
    expect(prisma.project.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 't2' } });
    expect(prisma.user.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 't2' } });
    expect(prisma.tenant.delete).toHaveBeenCalledWith({ where: { id: 't2' } });
  });
});
