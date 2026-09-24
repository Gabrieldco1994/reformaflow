// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../scripts/test-db-env.cjs');

import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectService } from '../project/project.service';
import { ReceiptService } from '../receipt/receipt.service';
import { ExpenseService } from '../expense/expense.service';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';
import { MerchantClassifierService } from '../merchant-classifier/merchant-classifier.service';
import { DemoService } from './demo.service';
import { DemoController } from './demo.controller';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { request } from '@playwright/test';
import { JwtStrategy } from '../auth/jwt.strategy';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';

const setupPrisma = new PrismaClient();
const prisma = new PrismaService();

describe('DemoService.seedTenant — child ACL real DB', () => {
  let previousAppMode: string | undefined;
  let tenantId: string;
  let requester: { id: string; role: string };

  beforeAll(async () => {
    previousAppMode = process.env['APP_MODE'];
    process.env['APP_MODE'] = 'demo';
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    const tenant = await setupPrisma.tenant.create({
      data: { name: `demo-seed-acl-${Date.now()}` },
    });
    tenantId = tenant.id;
    const user = await setupPrisma.user.create({
      data: { tenantId, username: tenantId, name: 'Synthetic demo admin', role: 'ADMIN' },
    });
    requester = { id: user.id, role: user.role };
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
    await setupPrisma.room.deleteMany({
      where: { project: { tenantId } },
    });
    await setupPrisma.project.deleteMany({ where: { tenantId } });
    await setupPrisma.user.deleteMany({ where: { tenantId } });
    await setupPrisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.onModuleDestroy();
    await setupPrisma.$disconnect();
    if (previousAppMode === undefined) delete process.env['APP_MODE'];
    else process.env['APP_MODE'] = previousAppMode;
  });

  it('conclui DONE e cria o espelho cross-project', async () => {
    const classifier = new MerchantClassifierService(prisma);
    const service = new DemoService(
      prisma,
      new ProjectService(prisma),
      new ReceiptService(prisma, classifier),
      new ExpenseService(prisma, new ConciliacaoService(prisma)),
    );

    const module = await Test.createTestingModule({
      controllers: [DemoController],
      providers: [
        JwtStrategy,
        { provide: PrismaService, useValue: prisma },
        { provide: DemoService, useValue: service },
      ],
    }).compile();
    const app = module.createNestApplication();
    const reflector = new Reflector();
    app.useGlobalGuards(new JwtAuthGuard(reflector), new RolesGuard(reflector));
    await app.listen(0, '127.0.0.1');
    const http = await request.newContext({ baseURL: await app.getUrl() });
    let result: Awaited<ReturnType<DemoService['seedTenant']>>;
    try {
      expect((await http.post('/demo/seed')).status()).toBe(401);
      const jwt = new JwtService({ secret: process.env.JWT_SECRET || 'dev-secret-change-me' });
      const response = await http.post('/demo/seed', {
        headers: { Authorization: `Bearer ${jwt.sign({ sub: requester.id, tenantId, sv: 0 })}` },
      });
      expect(response.status()).toBe(201);
      result = await response.json();
    } finally {
      await http.dispose();
      await app.close();
    }

    const seed = await setupPrisma.demoSeed.findUnique({
      where: { tenantId },
    });
    const mirror = await setupPrisma.expense.findFirst({
      where: {
        tenantId,
        projectId: result.projects.pessoalId,
        linkedExpenseId: { not: null },
        deletedAt: null,
      },
    });
    const target = mirror?.linkedExpenseId
      ? await setupPrisma.expense.findUnique({
          where: { id: mirror.linkedExpenseId },
        })
      : null;

    expect(seed?.status).toBe('DONE');
    expect(mirror).not.toBeNull();
    expect(target?.projectId).toBe(result.projects.reformaId);
  });
});
