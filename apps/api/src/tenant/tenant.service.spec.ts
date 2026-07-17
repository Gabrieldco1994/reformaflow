import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { TenantService } from './tenant.service';

describe('TenantService.remove', () => {
  function makeService(overrides: {
    tenant?: unknown;
    projectCount?: number;
  } = {}) {
    const prisma = {
      tenant: {
        findUnique: jest.fn().mockResolvedValue(
          'tenant' in overrides ? overrides.tenant : { id: 't2', name: 'Tenant Teste' },
        ),
        delete: jest.fn(),
      },
      project: { count: jest.fn().mockResolvedValue(overrides.projectCount ?? 0) },
      user: { deleteMany: jest.fn() },
    } as any;
    return { service: new TenantService(prisma), prisma };
  }

  it('blocks excluding the requester\'s own tenant', async () => {
    const { service } = makeService();
    await expect(service.remove('t1', 't1')).rejects.toThrow(BadRequestException);
  });

  it('blocks excluding a tenant with at least one project', async () => {
    const { service } = makeService({ projectCount: 1 });
    await expect(service.remove('t2', 't1')).rejects.toThrow(ForbiddenException);
  });

  it('404s when the tenant does not exist', async () => {
    const { service } = makeService({ tenant: null });
    await expect(service.remove('t2', 't1')).rejects.toThrow(NotFoundException);
  });

  it('deletes users then tenant when tenant has no projects', async () => {
    const { service, prisma } = makeService({ projectCount: 0 });
    await service.remove('t2', 't1');
    expect(prisma.user.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 't2' } });
    expect(prisma.tenant.delete).toHaveBeenCalledWith({ where: { id: 't2' } });
  });
});
