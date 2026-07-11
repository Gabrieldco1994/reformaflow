import { AgentToolsService, ToolContext } from './agent-tools.service';

/**
 * Idempotência do create_expense: um reenvio do mesmo comando (ex.: o usuário
 * achou que deu "timeout" mas o servidor já havia criado) NÃO pode duplicar a
 * despesa. O guard procura uma despesa idêntica criada nos últimos 5 min.
 */
describe('AgentToolsService.create_expense — guard de duplicata', () => {
  const ctx: ToolContext = { tenantId: 'tenant-1', projectId: 'proj-1', role: 'OWNER' };

  function build(existing: unknown) {
    const prisma: any = {
      project: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'proj-1', name: 'Pessoal', type: 'PESSOAL' }),
      },
      expense: { findFirst: jest.fn().mockResolvedValue(existing) },
    };
    const expenses: any = {
      create: jest.fn().mockResolvedValue({
        id: 'new-exp',
        titulo: 'PIX QRS AMAZON COM',
        fornecedor: 'Amazon',
        valorTotal: 9427,
      }),
    };
    const service = new AgentToolsService(
      prisma,
      {} as any,
      expenses,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { service, prisma, expenses };
  }

  const args = {
    valor: '94,27',
    tipoDespesa: 'COMPRAS_VAREJO',
    titulo: 'PIX QRS AMAZON COM',
    fornecedor: 'Amazon',
    data: '2026-07-05',
    formaPagamento: 'PIX',
    status: 'PAGO',
  };

  it('cria normalmente quando NÃO há duplicata recente', async () => {
    const { service, expenses } = build(null);

    const res: any = await service.execute('create_expense', ctx, args);

    expect(expenses.create).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    expect(res.duplicadaEvitada).toBeUndefined();
    expect(res.despesa.id).toBe('new-exp');
  });

  it('NÃO cria de novo quando já existe uma idêntica recente (reenvio)', async () => {
    const { service, expenses } = build({
      id: 'exp-existente',
      titulo: 'PIX QRS AMAZON COM',
      fornecedor: 'Amazon',
      valorTotal: 9427,
    });

    const res: any = await service.execute('create_expense', ctx, args);

    expect(expenses.create).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    expect(res.duplicadaEvitada).toBe(true);
    expect(res.despesa.id).toBe('exp-existente');
  });

  it('consulta a duplicata pela chave natural + janela de 5 min', async () => {
    const { service, prisma } = build(null);

    await service.execute('create_expense', ctx, args);

    const where = prisma.expense.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      deletedAt: null,
      tipoDespesa: 'COMPRAS_VAREJO',
      valor: 9427,
      valorTotal: 9427,
      quantidade: 1,
      formaPagamento: 'PIX',
      status: 'PAGO',
      titulo: 'PIX QRS AMAZON COM',
      fornecedor: 'Amazon',
    });
    expect(where.createdAt?.gte).toBeInstanceOf(Date);
    expect(where.dataCompra).toBeInstanceOf(Date);
  });
});
