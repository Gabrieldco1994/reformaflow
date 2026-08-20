import { PATH_METADATA, METHOD_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ExpenseController } from './expense.controller';
import { ExpenseService } from './expense.service';
import { PaidOriginsService } from './paid-origins.service';

describe('ExpenseController — GET :id/rateio (contrato de rota + lente, #423)', () => {
  let controller: ExpenseController;
  let service: { getRateio: jest.Mock };

  beforeEach(async () => {
    service = { getRateio: jest.fn().mockResolvedValue({ sourceExpenseId: 'src1', items: [] }) };
    const mod: TestingModule = await Test.createTestingModule({
      controllers: [ExpenseController],
      providers: [
        { provide: ExpenseService, useValue: service },
        { provide: PaidOriginsService, useValue: { findForProject: jest.fn() } },
      ],
    }).compile();
    controller = mod.get(ExpenseController);
  });

  it('rota é GET :id/rateio no método canônico getRateio', () => {
    const handler = ExpenseController.prototype.getRateio;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':id/rateio');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, handler))
      .not.toBe(Reflect.getMetadata(PATH_METADATA, ExpenseController.prototype.ratear)); // leitura ≠ escrita
  });

  it('repassa (tenantId, projectId, id, requester) — a lente é o 4º argumento', async () => {
    const requester = { role: 'USER', allowedProjects: ['p1'], allowedProjectTypes: ['PESSOAL'], allowedModules: ['expenses'] };
    await controller.getRateio('tenant-abc', 'project-xyz', 'src-1', requester as never);
    expect(service.getRateio).toHaveBeenCalledWith('tenant-abc', 'project-xyz', 'src-1', requester);
  });

  it('o 4º parâmetro é resolvido de request.user (@CurrentUser), não inventado no service', () => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, ExpenseController, 'getRateio');
    const entrada = Object.entries(args ?? {}).find(([k]) => k.split(':').pop() === '3');
    expect(entrada).toBeDefined();                              // mutação: esquecer o @CurrentUser
    const user = { id: 'u1', role: 'USER', allowedProjects: ['p1'] };
    const ctx: any = { switchToHttp: () => ({ getRequest: () => ({ user, tenantId: 't1', params: {} }) }) };
    const { factory, data } = entrada![1] as any;
    expect(factory(data, ctx)).toBe(user);
  });

  it('não remapeia o payload do service (o filtro é responsabilidade do service, em um lugar só)', async () => {
    const payload = { sourceExpenseId: 's', rateado: true, totalSourceCents: 1, rateadoCents: 1,
      sobraCents: 0, removedTargetsCount: 0, items: [] };
    service.getRateio.mockResolvedValueOnce(payload);
    await expect(controller.getRateio('t', 'p', 'i', {} as never)).resolves.toEqual(payload);
  });
});
