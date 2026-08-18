/**
 * B1a (#448) — RED: concorrência real (SQLite, não mock) do guard de duplicado
 * de cartão ATIVO.
 *
 * Contrato (issue #448, B1a): "Testes reais de concorrência SQLite (não mock)
 * cobrem a matriz de duplicado/settlement."
 *
 * Duas requisições SIMULTÂNEAS criando o mesmo (tenantId, projectId, last4)
 * devem resultar em: exatamente 1 sucesso, exatamente 1 Conflict (409), e
 * exatamente 1 cartão ATIVO no banco ao final — nunca 2 sucessos, nunca 0
 * cartões ativos.
 *
 * Honestidade sobre o mecanismo: um guard puramente "SELECT depois INSERT" em
 * `this.prisma` (aplicação, sem transação serializável nem índice único no
 * banco) é vulnerável a corrida entre o SELECT e o INSERT de dois requests
 * concorrentes na MESMA PrismaService (mesmo connection pool) — e mais ainda
 * entre duas PrismaClient/conexões distintas. Este arquivo não abranda a
 * asserção para "pelo menos um bloqueado": ele afirma o INVARIANTE financeiro
 * (nunca >1 ativo) e, se a implementação só resolver isso com um índice único
 * no schema (fora do escopo desta issue, que é aditiva e não mexe em schema —
 * ver "Fora de escopo" do #448), o teste FALHA de verdade e a falha deve ser
 * reportada de volta ao backend-expert, não silenciada.
 */
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

const TENANT = 'ccconc-tenant';
const PROJECT = 'ccconc-project';

// Clock congelado — nenhuma asserção de data neste arquivo depende do relógio
// real, mas fixamos mesmo assim por convenção de determinismo do repositório.
const CLOCK = new Date('2026-08-18T12:00:00.000Z');

async function cleanup() {
  await setupPrisma.creditCard.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.project.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.tenant.deleteMany({ where: { id: TENANT } });
}

function buildService(client: PrismaService | PrismaClient) {
  return new CreditCardService(
    client as unknown as PrismaService,
    new ConciliacaoService(client as unknown as PrismaService),
    new MerchantClassifierService(client as unknown as PrismaService),
  );
}

describe('CreditCardService — concorrência real do guard de duplicado (#448 B1a)', () => {
  let service: CreditCardService;

  beforeAll(async () => {
    jest.useFakeTimers({
      doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'setInterval', 'setTimeout'],
    });
    jest.setSystemTime(CLOCK);
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    await cleanup();
    await setupPrisma.tenant.create({ data: { id: TENANT, name: 'Concurrency guard tenant' } });
    await setupPrisma.project.create({
      data: { id: PROJECT, tenantId: TENANT, type: 'PESSOAL', name: 'Projeto concorrência' },
    });
    service = buildService(prisma);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
    await setupPrisma.$disconnect();
    jest.useRealTimers();
  });

  afterEach(async () => {
    await setupPrisma.creditCard.deleteMany({ where: { tenantId: TENANT } });
  });

  const dto = (last4: string) => ({ institution: 'ITAU', brand: 'Visa', nickname: `Race ${last4}`, last4 } as any);

  it('mesma PrismaService, 2 creates concorrentes (Promise.allSettled): exatamente 1 sucesso, 1 Conflict, 1 ativo', async () => {
    const [r1, r2] = await Promise.allSettled([
      service.createCard(TENANT, PROJECT, dto('9090')),
      service.createCard(TENANT, PROJECT, dto('9090')),
    ]);

    const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled');
    const rejected = [r1, r2].filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);

    const activeCards = await setupPrisma.creditCard.findMany({
      where: { tenantId: TENANT, projectId: PROJECT, last4: '9090', deletedAt: null },
    });
    expect(activeCards).toHaveLength(1);
  });

  it('duas conexões Prisma SEPARADAS (não só duas promises no mesmo client): nunca >1 cartão ativo com o mesmo last4', async () => {
    // Simula 2 processos/API-instances distintos: cada um com sua PRÓPRIA
    // PrismaClient/conexão, não a mesma PrismaService compartilhada. Um guard
    // "check depois insert" que só serializa dentro de uma única conexão (ex.:
    // um mutex em memória do processo) não pega essa corrida — só um
    // constraint de banco (índice único) ou transação serializável reais
    // pegam. Se a implementação atual não sustentar isso, ESTE teste deve
    // falhar honestamente, não ser abrandado para "ao menos um bloqueado".
    const clientA = new PrismaClient();
    const clientB = new PrismaClient();
    await clientA.$connect();
    await clientB.$connect();
    try {
      const serviceA = buildService(clientA);
      const serviceB = buildService(clientB);

      const [ra, rb] = await Promise.allSettled([
        serviceA.createCard(TENANT, PROJECT, dto('8181')),
        serviceB.createCard(TENANT, PROJECT, dto('8181')),
      ]);

      const fulfilled = [ra, rb].filter((r) => r.status === 'fulfilled');
      const activeCards = await setupPrisma.creditCard.findMany({
        where: { tenantId: TENANT, projectId: PROJECT, last4: '8181', deletedAt: null },
      });

      // Invariante financeiro real, não uma amolecida "pelo menos 1 rejeitado":
      // nunca mais de 1 cartão ativo com o mesmo (tenant, projeto, last4),
      // e o número de sucessos relatados tem que bater com o que persistiu.
      expect(activeCards.length).toBeLessThanOrEqual(1);
      expect(fulfilled.length).toBe(activeCards.length);
    } finally {
      await clientA.$disconnect();
      await clientB.$disconnect();
    }
  });
});
