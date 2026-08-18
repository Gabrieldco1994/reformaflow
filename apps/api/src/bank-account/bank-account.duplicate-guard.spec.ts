/**
 * B1a (#448) — guard de duplicado de CONTA BANCÁRIA ATIVA (mesmo
 * tenant+projeto+last4), espelhando `credit-card.duplicate-guard.spec.ts` +
 * `credit-card.duplicate-concurrency.spec.ts`. Autorado RED contra o baseline
 * pré-#448; GREEN após a implementação — mantido como regression lock.
 *
 * Contrato (issue #448, B1a): "Guard de crescimento de duplicado ativo
 * card/account bloqueia em aplicação" + "Testes reais de concorrência SQLite
 * (não mock) cobrem a matriz de duplicado/settlement."
 *
 * No baseline pré-#448, `createAccount`/`updateAccount`
 * (bank-account.service.ts) não checavam last4 duplicado — mesma lacuna do
 * cartão. Prisma REAL (SQLite descartável), sem mock de banco.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../scripts/test-db-env.cjs');

import { PrismaClient } from '@prisma/client';
import { ConflictException } from '@nestjs/common';
import { BankAccountService } from './bank-account.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';
import { MerchantClassifierService } from '../merchant-classifier/merchant-classifier.service';
import { CardInvoiceSettlementService } from '../credit-card/card-invoice-settlement.service';

const setupPrisma = new PrismaClient();
const prisma = new PrismaService();

const TENANT = 'badup-tenant';
const PROJECT_A = 'badup-project-a';
const PROJECT_B = 'badup-project-b';

async function cleanup() {
  await setupPrisma.bankAccount.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.project.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.tenant.deleteMany({ where: { id: TENANT } });
}

function buildService(client: PrismaService | PrismaClient) {
  return new BankAccountService(
    client as unknown as PrismaService,
    new MerchantClassifierService(client as unknown as PrismaService),
    new ConciliacaoService(client as unknown as PrismaService),
    new CardInvoiceSettlementService(client as unknown as PrismaService),
  );
}

describe('BankAccountService — guard de duplicado ativo (last4) real DB (#448 B1a)', () => {
  let service: BankAccountService;

  beforeAll(async () => {
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    await cleanup();
    await setupPrisma.tenant.create({ data: { id: TENANT, name: 'BA duplicate guard tenant' } });
    await setupPrisma.project.createMany({
      data: [
        { id: PROJECT_A, tenantId: TENANT, type: 'PESSOAL', name: 'Projeto A' },
        { id: PROJECT_B, tenantId: TENANT, type: 'PESSOAL', name: 'Projeto B' },
      ],
    });
    service = buildService(prisma);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
    await setupPrisma.$disconnect();
  });

  afterEach(async () => {
    await setupPrisma.bankAccount.deleteMany({ where: { tenantId: TENANT } });
  });

  const newAccountDto = (last4: string) => ({
    institution: 'ITAU',
    nickname: `Conta ${last4}`,
    last4,
  });

  it('create: 409 ao criar 2ª conta ATIVA com mesmo tenant+projeto+last4', async () => {
    const first = await service.createAccount(TENANT, PROJECT_A, newAccountDto('1234') as any);
    expect(first.bankAccount.last4).toBe('1234');

    await expect(
      service.createAccount(TENANT, PROJECT_A, newAccountDto('1234') as any),
    ).rejects.toBeInstanceOf(ConflictException);

    const count = await setupPrisma.bankAccount.count({
      where: { tenantId: TENANT, projectId: PROJECT_A, last4: '1234', deletedAt: null },
    });
    expect(count).toBe(1);
  });

  it('create: permitido em outro projeto do mesmo tenant (cross-project não colide)', async () => {
    await service.createAccount(TENANT, PROJECT_A, newAccountDto('5555') as any);
    const other = await service.createAccount(TENANT, PROJECT_B, newAccountDto('5555') as any);
    expect(other.bankAccount.projectId).toBe(PROJECT_B);

    const count = await setupPrisma.bankAccount.count({
      where: { tenantId: TENANT, last4: '5555', deletedAt: null },
    });
    expect(count).toBe(2);
  });

  it('create: permitido quando a única titular do last4 está soft-deleted (reuse)', async () => {
    const first = await service.createAccount(TENANT, PROJECT_A, newAccountDto('6060') as any);
    await service.deleteAccount(TENANT, PROJECT_A, first.bankAccount.id);

    const deletedRow = await setupPrisma.bankAccount.findUnique({
      where: { id: first.bankAccount.id },
    });
    expect(deletedRow?.deletedAt).not.toBeNull();

    const second = await service.createAccount(TENANT, PROJECT_A, newAccountDto('6060') as any);
    expect(second.bankAccount.id).not.toBe(first.bankAccount.id);

    const activeCount = await setupPrisma.bankAccount.count({
      where: { tenantId: TENANT, projectId: PROJECT_A, last4: '6060', deletedAt: null },
    });
    expect(activeCount).toBe(1);
  });

  it('update: 409 ao mudar o last4 de uma conta para colidir com uma irmã ATIVA do mesmo projeto', async () => {
    const a = await service.createAccount(TENANT, PROJECT_A, newAccountDto('1111') as any);
    const b = await service.createAccount(TENANT, PROJECT_A, newAccountDto('2222') as any);

    await expect(
      service.updateAccount(TENANT, PROJECT_A, b.bankAccount.id, { last4: '1111' } as any),
    ).rejects.toBeInstanceOf(ConflictException);

    const bRow = await setupPrisma.bankAccount.findUnique({ where: { id: b.bankAccount.id } });
    expect(bRow?.last4).toBe('2222');
    const aRow = await setupPrisma.bankAccount.findUnique({ where: { id: a.bankAccount.id } });
    expect(aRow?.last4).toBe('1111');
  });

  it('update: self (mesmo last4 da própria conta) é permitido — não é colisão consigo mesma', async () => {
    const a = await service.createAccount(TENANT, PROJECT_A, newAccountDto('7777') as any);
    const updated = await service.updateAccount(TENANT, PROJECT_A, a.bankAccount.id, {
      last4: '7777',
      nickname: 'Renomeada',
    } as any);
    expect(updated.last4).toBe('7777');
    expect(updated.nickname).toBe('Renomeada');
  });

  it('concorrência real: 2 creates simultâneos (Promise.allSettled) — exatamente 1 sucesso, 1 Conflict, 1 ativa', async () => {
    const [r1, r2] = await Promise.allSettled([
      service.createAccount(TENANT, PROJECT_A, newAccountDto('9090') as any),
      service.createAccount(TENANT, PROJECT_A, newAccountDto('9090') as any),
    ]);

    const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled');
    const rejected = [r1, r2].filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);

    const activeAccounts = await setupPrisma.bankAccount.findMany({
      where: { tenantId: TENANT, projectId: PROJECT_A, last4: '9090', deletedAt: null },
    });
    expect(activeAccounts).toHaveLength(1);
  });
});
