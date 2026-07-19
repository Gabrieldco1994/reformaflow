import { ProjectService } from './project.service';

function makePrismaMock() {
  const tx = {
    project: {
      create: jest.fn(),
    },
    room: {
      create: jest.fn(),
    },
  };

  const prisma: any = {
    project: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(async (cb: any) => cb(tx)),
  };

  prisma.__tx = tx;
  return prisma;
}

describe('ProjectService createdByUserId', () => {
  it('stamps the authenticated creator on project create', async () => {
    const prisma = makePrismaMock();
    prisma.__tx.project.create.mockResolvedValue({ id: 'project-1' });
    prisma.project.findFirst.mockResolvedValue({
      id: 'project-1',
      tenantId: 'tenant-1',
      type: 'CASA',
      rooms: [],
      _count: { receipts: 0, expenses: 0, cashFlow: 0 },
    });

    const service = new ProjectService(prisma);
    await service.create(
      'tenant-1',
      { type: 'REFORMA', name: 'Obra Demo' } as any,
      { id: 'user-1', role: 'ADMIN', allowedModules: [], allowedProjects: [], allowedProjectTypes: [] },
    );

    expect(prisma.__tx.project.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ createdByUserId: 'user-1' }),
      }),
    );
  });

  it('does not persist a spoofed createdByUserId on update', async () => {
    const prisma = makePrismaMock();
    prisma.project.findFirst.mockResolvedValue({
      id: 'project-1',
      tenantId: 'tenant-1',
      type: 'CASA',
      rooms: [],
      _count: { receipts: 0, expenses: 0, cashFlow: 0 },
    });
    prisma.project.update.mockResolvedValue({ id: 'project-1' });

    const service = new ProjectService(prisma);
    await service.update('tenant-1', 'project-1', {
      name: 'Casa Nova',
      createdByUserId: 'attacker',
    } as any);

    expect(prisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ createdByUserId: expect.anything() }),
      }),
    );
  });
});
