import { AgentToolsService, ToolContext } from './agent-tools.service';

/**
 * get_maintenance_status (issue #290): a Maria responde "quando foi a última
 * troca de óleo?" lendo MaintenanceLog. Cobre resolução de projeto (única
 * fonte por escopo, sem vazar outro carro), filtro por tipo e o caso "sem
 * registro".
 */
describe('AgentToolsService.get_maintenance_status', () => {
  const carro = { id: 'carro-1', name: 'Meu Carro', type: 'CARRO' };
  const outroCarro = { id: 'carro-2', name: 'Carro da Maria', type: 'CARRO' };

  function build(opts: {
    projects?: unknown[];
    findFirstProject?: unknown;
    log?: unknown;
  }) {
    const prisma: any = {
      project: {
        findFirst: jest.fn().mockResolvedValue(opts.findFirstProject ?? null),
        findMany: jest.fn().mockResolvedValue(opts.projects ?? []),
      },
      maintenanceLog: {
        findFirst: jest.fn().mockResolvedValue(opts.log ?? null),
      },
    };
    const service = new AgentToolsService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { service, prisma };
  }

  it('resolve o único projeto elegível do escopo e devolve última manutenção + próxima', async () => {
    const { service, prisma } = build({
      projects: [carro],
      log: {
        tipo: 'TROCA_OLEO',
        dataRealizada: new Date('2026-05-10'),
        dataProxima: new Date('2026-11-10'),
        quilometragem: 42000,
        custo: 18000,
        fornecedor: 'Oficina do Zé',
      },
    });
    const ctx: ToolContext = { tenantId: 'tenant-1', role: 'OWNER' };

    const res: any = await service.execute('get_maintenance_status', ctx, { tipo: 'TROCA_OLEO' });

    expect(res.encontrado).toBe(true);
    expect(res.projeto).toBe('Meu Carro');
    expect(res.tipo).toBe('TROCA_OLEO');
    expect(res.dataRealizada).toBe('2026-05-10');
    expect(res.dataProxima).toBe('2026-11-10');
    expect(res.quilometragem).toBe(42000);

    const where = prisma.maintenanceLog.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ tenantId: 'tenant-1', projectId: 'carro-1', deletedAt: null, tipo: 'TROCA_OLEO' });
  });

  it('respeita o projectScope — não enxerga manutenção de outro carro fora do escopo', async () => {
    const { service, prisma } = build({
      projects: [carro],
      log: { tipo: 'TROCA_OLEO', dataRealizada: new Date('2026-05-10'), dataProxima: null, quilometragem: 42000 },
    });
    const ctx: ToolContext = { tenantId: 'tenant-1', role: 'USER', projectScope: ['carro-1'] };

    await service.execute('get_maintenance_status', ctx, {});

    const whereProjects = prisma.project.findMany.mock.calls[0][0].where;
    expect(whereProjects).toMatchObject({ tenantId: 'tenant-1', deletedAt: null, id: { in: ['carro-1'] } });
  });

  it('pede para especificar quando há mais de um projeto elegível e nenhum em foco', async () => {
    const { service } = build({ projects: [carro, outroCarro] });
    const ctx: ToolContext = { tenantId: 'tenant-1', role: 'OWNER' };

    const res: any = await service.execute('get_maintenance_status', ctx, {});

    expect(res.error).toMatch(/mais de um projeto/i);
  });

  it('usa o projeto em foco quando ambíguo mas há um projectId no contexto', async () => {
    const { service, prisma } = build({
      projects: [carro, outroCarro],
      log: { tipo: 'REVISAO', dataRealizada: new Date('2026-01-01'), dataProxima: null, quilometragem: 10000 },
    });
    const ctx: ToolContext = { tenantId: 'tenant-1', role: 'OWNER', projectId: 'carro-2' };

    const res: any = await service.execute('get_maintenance_status', ctx, {});

    expect(res.encontrado).toBe(true);
    const where = prisma.maintenanceLog.findFirst.mock.calls[0][0].where;
    expect(where.projectId).toBe('carro-2');
  });

  it('devolve encontrado=false com mensagem quando não há registro do tipo pedido', async () => {
    const { service } = build({ projects: [carro], log: null });
    const ctx: ToolContext = { tenantId: 'tenant-1', role: 'OWNER' };

    const res: any = await service.execute('get_maintenance_status', ctx, { tipo: 'PNEUS' });

    expect(res.encontrado).toBe(false);
    expect(res.mensagem).toMatch(/PNEUS/);
  });

  it('rejeita projeto de tipo sem módulo de manutenção (ex.: COMPRA)', async () => {
    const { service } = build({ findFirstProject: { id: 'compra-1', name: 'Compra X', type: 'COMPRA' } });
    const ctx: ToolContext = { tenantId: 'tenant-1', role: 'OWNER' };

    const res: any = await service.execute('get_maintenance_status', ctx, { projectId: 'compra-1' });

    expect(res.error).toMatch(/não têm registro de manutenção/i);
  });
});
