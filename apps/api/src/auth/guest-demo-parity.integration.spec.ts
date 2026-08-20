// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../scripts/test-db-env.cjs');

import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectService } from '../project/project.service';
import { ReceiptService } from '../receipt/receipt.service';
import { ExpenseService } from '../expense/expense.service';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';
import { MerchantClassifierService } from '../merchant-classifier/merchant-classifier.service';
import { DemoService } from '../demo/demo.service';
import { GUEST_PROJECT_TYPES } from './auth.service';

/**
 * #505 — trava do acoplamento silencioso entre o SEED e a CONCESSÃO do convidado.
 *
 * `auth.service.registerGuest` concede ao convidado exatamente
 * `GUEST_PROJECT_TYPES`, e `demo.service.seedTenant` semeia os projetos que ele
 * encontra ao entrar. Hoje os dois conjuntos coincidem — mas em pontos
 * diferentes do código e por literais diferentes (`ProjectType.PESSOAL` de um
 * lado, a string `'PESSOAL'` do outro). Se alguém mudar o seed (adicionar CASA,
 * trocar REFORMA), o convidado passa a ter acesso a um tipo que não recebeu, ou
 * a não receber acesso ao que existe no seu próprio tenant — e NADA quebra.
 *
 * Este teste não repete os literais: ele SEMEIA um tenant pelo caminho de
 * produção real (`DemoService.seedTenant`) e lê de volta os tipos que os
 * projetos efetivamente nasceram tendo. A concessão do convidado tem de ser
 * igual a esse conjunto. Trocar o seed sem trocar a concessão passa a falhar
 * aqui, apontando o dedo para o lugar certo.
 */
describe('#505 — concessão do convidado == tipos que a demonstração semeia', () => {
  const setupPrisma = new PrismaClient();
  const prisma = new PrismaService();
  let previousAppMode: string | undefined;
  let tenantId: string;

  beforeAll(async () => {
    previousAppMode = process.env['APP_MODE'];
    process.env['APP_MODE'] = 'demo';
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    const tenant = await setupPrisma.tenant.create({
      data: { name: `guest-demo-parity-${Date.now()}` },
    });
    tenantId = tenant.id;
  });

  afterAll(async () => {
    await setupPrisma.cashFlowEntry.deleteMany({ where: { tenantId } });
    await setupPrisma.expense.updateMany({
      where: { tenantId },
      data: { linkedExpenseId: null },
    });
    await setupPrisma.expense.deleteMany({ where: { tenantId } });
    await setupPrisma.receipt.deleteMany({ where: { tenantId } });
    await setupPrisma.demoSeed.deleteMany({ where: { tenantId } });
    await setupPrisma.room.deleteMany({ where: { project: { tenantId } } });
    await setupPrisma.project.deleteMany({ where: { tenantId } });
    await setupPrisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.onModuleDestroy();
    await setupPrisma.$disconnect();
    if (previousAppMode === undefined) delete process.env['APP_MODE'];
    else process.env['APP_MODE'] = previousAppMode;
  });

  it('os tipos de projeto que o seed cria são exatamente os concedidos ao convidado', async () => {
    const classifier = new MerchantClassifierService(prisma);
    const service = new DemoService(
      prisma,
      new ProjectService(prisma),
      new ReceiptService(prisma, classifier),
      new ExpenseService(prisma, new ConciliacaoService(prisma)),
    );

    await service.seedTenant(tenantId);

    const seeded = await setupPrisma.project.findMany({
      where: { tenantId, deletedAt: null },
      select: { type: true },
    });
    // Derivado do seed real — não de uma lista escrita à mão aqui, que viraria
    // uma terceira fonte de verdade e ficaria verde no dia do drift.
    const seededTypes = new Set(seeded.map((p) => p.type));
    const grantedTypes = new Set<string>(GUEST_PROJECT_TYPES);

    expect(seededTypes.size).toBeGreaterThan(0);
    expect(seededTypes).toEqual(grantedTypes);
  });
});
