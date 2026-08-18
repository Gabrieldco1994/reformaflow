/**
 * B1a (#448) — RED: guard de duplicado de cartão ATIVO (mesmo tenant+projeto+last4).
 *
 * Contrato (issue #448, B1a):
 *  "Guard de crescimento de duplicado ativo card/account bloqueia em aplicação."
 *
 * Hoje `createCard`/`updateCard` (credit-card.service.ts) NÃO checam last4
 * duplicado: o INSERT/UPDATE bruto sempre passa. Este arquivo materializa o
 * contrato esperado com Prisma REAL (SQLite descartável) — nada de mock que
 * espelhe a lógica do service (isso provaria a suposição, não o comportamento).
 *
 * Matriz coberta:
 *  - create: 409 quando já existe cartão ATIVO com o mesmo tenant+projeto+last4;
 *  - create: permitido em outro PROJETO do mesmo tenant (cross-project);
 *  - create: permitido quando o único cartão com aquele last4 está soft-deleted;
 *  - update: 409 ao mudar o last4 de um cartão para colidir com um irmão ATIVO
 *    do MESMO projeto;
 *  - update: permitido quando o last4 informado é o do PRÓPRIO cartão (self, no-op).
 *
 * Toda RED aqui é "nada bloqueia" — a asserção que falha é `expect(...).rejects`
 * não disparar (a chamada resolve com sucesso em vez de lançar 409).
 */
// O guard do banco de teste precisa carregar ANTES de qualquer import do Prisma.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../scripts/test-db-env.cjs');

import { PrismaClient } from '@prisma/client';
import { ConflictException } from '@nestjs/common';
import { CreditCardService } from './credit-card.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';
import { MerchantClassifierService } from '../merchant-classifier/merchant-classifier.service';

const setupPrisma = new PrismaClient();
const prisma = new PrismaService();

const TENANT = 'ccdup-tenant';
const PROJECT_A = 'ccdup-project-a';
const PROJECT_B = 'ccdup-project-b';

async function cleanup() {
  await setupPrisma.creditCard.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.project.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.tenant.deleteMany({ where: { id: TENANT } });
}

describe('CreditCardService — guard de duplicado ativo (last4) real DB (#448 B1a)', () => {
  let service: CreditCardService;

  beforeAll(async () => {
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    await cleanup();
    await setupPrisma.tenant.create({ data: { id: TENANT, name: 'Duplicate guard tenant' } });
    await setupPrisma.project.createMany({
      data: [
        { id: PROJECT_A, tenantId: TENANT, type: 'PESSOAL', name: 'Projeto A' },
        { id: PROJECT_B, tenantId: TENANT, type: 'PESSOAL', name: 'Projeto B' },
      ],
    });
    service = new CreditCardService(
      prisma,
      new ConciliacaoService(prisma),
      new MerchantClassifierService(prisma),
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
    await setupPrisma.$disconnect();
  });

  afterEach(async () => {
    await setupPrisma.creditCard.deleteMany({ where: { tenantId: TENANT } });
  });

  const newCardDto = (last4: string) => ({
    institution: 'ITAU',
    brand: 'Visa',
    nickname: `Cartão ${last4}`,
    last4,
  });

  it('create: 409 ao criar 2º cartão ATIVO com mesmo tenant+projeto+last4', async () => {
    const first = await service.createCard(TENANT, PROJECT_A, newCardDto('1234') as any);
    expect(first.last4).toBe('1234');

    await expect(
      service.createCard(TENANT, PROJECT_A, newCardDto('1234') as any),
    ).rejects.toBeInstanceOf(ConflictException);

    // Zero-write: a tentativa rejeitada não deixa um 2º registro no banco.
    const count = await setupPrisma.creditCard.count({
      where: { tenantId: TENANT, projectId: PROJECT_A, last4: '1234', deletedAt: null },
    });
    expect(count).toBe(1);
  });

  it('create: permitido em outro projeto do mesmo tenant (cross-project não colide)', async () => {
    await service.createCard(TENANT, PROJECT_A, newCardDto('5555') as any);
    const other = await service.createCard(TENANT, PROJECT_B, newCardDto('5555') as any);
    expect(other.last4).toBe('5555');
    expect(other.projectId).toBe(PROJECT_B);

    const count = await setupPrisma.creditCard.count({
      where: { tenantId: TENANT, last4: '5555', deletedAt: null },
    });
    expect(count).toBe(2);
  });

  it('create: permitido quando o único titular do last4 está soft-deleted (reuse)', async () => {
    const first = await service.createCard(TENANT, PROJECT_A, newCardDto('6060') as any);
    await service.deleteCard(TENANT, PROJECT_A, first.id);

    const deletedRow = await setupPrisma.creditCard.findUnique({ where: { id: first.id } });
    expect(deletedRow?.deletedAt).not.toBeNull();

    const second = await service.createCard(TENANT, PROJECT_A, newCardDto('6060') as any);
    expect(second.last4).toBe('6060');
    expect(second.id).not.toBe(first.id);

    const activeCount = await setupPrisma.creditCard.count({
      where: { tenantId: TENANT, projectId: PROJECT_A, last4: '6060', deletedAt: null },
    });
    expect(activeCount).toBe(1);
  });

  it('update: 409 ao mudar o last4 de um cartão para colidir com um irmão ATIVO do mesmo projeto', async () => {
    const a = await service.createCard(TENANT, PROJECT_A, newCardDto('1111') as any);
    const b = await service.createCard(TENANT, PROJECT_A, newCardDto('2222') as any);

    await expect(
      service.updateCard(TENANT, PROJECT_A, b.id, { last4: '1111' } as any),
    ).rejects.toBeInstanceOf(ConflictException);

    // Zero-write: o cartão B mantém seu last4 original, não sobrescreve 'a'.
    const bRow = await setupPrisma.creditCard.findUnique({ where: { id: b.id } });
    expect(bRow?.last4).toBe('2222');
    const aRow = await setupPrisma.creditCard.findUnique({ where: { id: a.id } });
    expect(aRow?.last4).toBe('1111');
  });

  it('update: self (mesmo last4 do próprio cartão) é permitido — não é colisão consigo mesmo', async () => {
    const a = await service.createCard(TENANT, PROJECT_A, newCardDto('7777') as any);
    const updated = await service.updateCard(TENANT, PROJECT_A, a.id, {
      last4: '7777',
      nickname: 'Renomeado',
    } as any);
    expect(updated.last4).toBe('7777');
    expect(updated.nickname).toBe('Renomeado');
  });
});
