import { NotFoundException } from '@nestjs/common';
import { ProjectService } from './project.service';

function makePrisma(project: any) {
  return {
    project: {
      findFirst: jest.fn().mockResolvedValue(project),
      update: jest.fn().mockImplementation(({ data }) => ({ ...project, ...data })),
    },
  } as any;
}

describe('ProjectService.completeOnboarding', () => {
  it('sets onboardedAt on the tenant-scoped project', async () => {
    const prisma = makePrisma({ id: 'p1', tenantId: 't1', type: 'CASA', onboardedAt: null, rooms: [], _count: {} });
    const service = new ProjectService(prisma);

    const result = await service.completeOnboarding('t1', 'p1');

    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { onboardedAt: expect.any(Date) },
    });
    expect(result.onboardedAt).toBeInstanceOf(Date);
  });

  it('throws NotFoundException for a project outside the tenant', async () => {
    const prisma: any = {
      project: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
    };
    const service = new ProjectService(prisma);

    await expect(service.completeOnboarding('t1', 'ghost')).rejects.toThrow(NotFoundException);
    expect(prisma.project.update).not.toHaveBeenCalled();
  });
});
