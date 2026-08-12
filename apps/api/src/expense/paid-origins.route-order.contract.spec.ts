import 'reflect-metadata';
import { PATH_METADATA } from '@nestjs/common/constants';
import { ExpenseController } from './expense.controller';

describe('ExpenseController — ordem das rotas GET', () => {
  it("declara 'paid-origins' ANTES de ':id' (senão :id engole a rota e devolve 404)", () => {
    const proto = ExpenseController.prototype as any;
    const order = Object.getOwnPropertyNames(proto)
      .filter((k) => k !== 'constructor')
      .map((k) => ({ k, path: Reflect.getMetadata(PATH_METADATA, proto[k]) }))
      .filter((m) => typeof m.path === 'string');
    const idx = (p: string) => order.findIndex((m) => m.path === p);
    expect(idx('paid-origins')).toBeGreaterThanOrEqual(0);
    expect(idx('paid-origins')).toBeLessThan(idx(':id'));
  });

  it('o handler recebe tenant, projectId e o requester (para o gate de módulo)', () => {
    expect(ExpenseController.prototype.paidOrigins.length).toBeGreaterThanOrEqual(3);
  });
});
