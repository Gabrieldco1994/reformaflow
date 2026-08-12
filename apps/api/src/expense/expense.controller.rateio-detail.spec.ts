import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ExpenseController } from './expense.controller';
import { ExpenseService } from './expense.service';

/**
 * QA (issue #423) — contrato de ROTA + delegação do controller para o novo
 * endpoint de leitura read-only:
 *
 *   GET /projects/:projectId/expenses/:id/rateio
 *
 * Nesta branch a rota ainda NÃO existe em `ExpenseController` — RED
 * esperado (ver detalhes de cada `it`). Ambos os testes usam
 * `ExpenseController.prototype.getRateioDetail` / `(controller as any)`
 * deliberadamente para não travar `tsc --noEmit` (pre-commit) por causa de
 * um método/rota que ainda não existe: a falha esperada é a de runtime
 * (`Cannot read properties of undefined` / `is not a function`), não uma
 * quebra de compilação.
 */
describe('ExpenseController — GET :id/rateio (issue #423, contrato de rota)', () => {
  it('declara @Get(\':id/rateio\") no método getRateioDetail (RequestMethod.GET)', () => {
    const handler = (ExpenseController.prototype as any).getRateioDetail;
    expect(handler).toBeDefined();

    const path = Reflect.getMetadata(PATH_METADATA, handler);
    const method = Reflect.getMetadata(METHOD_METADATA, handler);

    expect(path).toBe(':id/rateio');
    expect(method).toBe(RequestMethod.GET);
  });

  it('NÃO reaproveita o path :id/ratear (verbo de escrita) para a leitura — rotas distintas', () => {
    const readHandler = (ExpenseController.prototype as any).getRateioDetail;
    const writeHandler = ExpenseController.prototype.ratear;
    const readPath = readHandler && Reflect.getMetadata(PATH_METADATA, readHandler);
    const writePath = Reflect.getMetadata(PATH_METADATA, writeHandler);
    expect(readPath).toBeDefined();
    expect(readPath).not.toBe(writePath);
  });

  describe('delegação tenant/projeto/id (ordem dos argumentos)', () => {
    let controller: any;
    let service: { getRateioDetail: jest.Mock };

    beforeEach(async () => {
      service = { getRateioDetail: jest.fn().mockResolvedValue({ sourceId: 'src1', items: [] }) };
      const module: TestingModule = await Test.createTestingModule({
        controllers: [ExpenseController],
        providers: [{ provide: ExpenseService, useValue: service }],
      }).compile();
      controller = module.get(ExpenseController);
    });

    it('repassa (tenantId, projectId, id) NA ORDEM CORRETA — troca de tenantId/projectId é regressão clássica', async () => {
      await controller.getRateioDetail('tenant-abc', 'project-xyz', 'src-telhanorte');
      expect(service.getRateioDetail).toHaveBeenCalledWith('tenant-abc', 'project-xyz', 'src-telhanorte');
    });

    it('retorna exatamente o payload do service (controller não remapeia/filtra campos)', async () => {
      const payload = {
        sourceId: 'src1',
        totalCents: 1_277_100,
        allocatedCents: 1_277_100,
        sobraCents: 0,
        items: new Array(9).fill(0).map((_, i) => ({ targetExpenseId: `tgt-${i}` })),
      };
      service.getRateioDetail.mockResolvedValueOnce(payload);
      const res = await controller.getRateioDetail('t1', 'p1', 'src1');
      expect(res).toEqual(payload);
    });
  });
});
