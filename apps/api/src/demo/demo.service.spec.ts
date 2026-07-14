import { ConflictException, NotFoundException } from '@nestjs/common';
import { DemoService } from './demo.service';

describe('DemoService', () => {
  let prisma: any;
  let projects: any;
  let receipts: any;
  let expenses: any;
  let service: DemoService;

  beforeEach(() => {
    prisma = {
      demoSeed: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      project: {
        count: jest.fn(),
      },
    };
    projects = { create: jest.fn() };
    receipts = { create: jest.fn() };
    expenses = { create: jest.fn() };
    service = new DemoService(prisma, projects, receipts, expenses);
    delete process.env['APP_MODE'];
  });

  it('bloqueia seed fora de APP_MODE=demo', async () => {
    await expect(service.seedTenant('t1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('retorna conflito quando tenant já foi seedado', async () => {
    process.env['APP_MODE'] = 'demo';
    prisma.demoSeed.findFirst.mockResolvedValue({
      id: 's1',
      tenantId: 't1',
      version: 1,
      status: 'DONE',
    });

    await expect(service.seedTenant('t1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('executa seed e marca status DONE', async () => {
    process.env['APP_MODE'] = 'demo';
    prisma.demoSeed.findFirst.mockResolvedValue(null);
    prisma.project.count.mockResolvedValue(0);
    prisma.demoSeed.create.mockResolvedValue({ id: 's1' });
    projects.create
      .mockResolvedValueOnce({ id: 'pessoal', type: 'PESSOAL' })
      .mockResolvedValueOnce({ id: 'reforma', type: 'REFORMA' });
    receipts.create.mockResolvedValue({ id: 'r1' });
    expenses.create
      .mockResolvedValueOnce({ id: 'e-alvo' })
      .mockResolvedValueOnce({ id: 'e-espelho' });
    prisma.demoSeed.update.mockResolvedValue({ id: 's1', status: 'DONE' });

    await expect(service.seedTenant('t1')).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        projects: { pessoalId: 'pessoal', reformaId: 'reforma' },
      }),
    );
    expect(prisma.demoSeed.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 's1' },
        data: expect.objectContaining({ status: 'DONE' }),
      }),
    );
  });
});
