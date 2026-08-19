import { TEST_OWNER_REQUESTER } from '../test-utils/acl-requester-test-helper';
import { BadRequestException } from '@nestjs/common';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';
import { ExpenseService } from './expense.service';
import { withAclRequester } from '../test-utils/acl-requester-test-helper';

/**
 * Reprodução do incidente de produção: uma despesa PESSOAL importada da fatura
 * do cartão foi vinculada (Vincular transações) para quitar 1 parcela de um
 * alvo REFORMA (`CrossProjectSettlement`). Depois, um caminho genérico de
 * "remover vínculo" limpou `linkedExpenseId` da fonte SEM passar por
 * `unsettleBySource` — deixando a `CrossProjectSettlement` órfã, o alvo
 * incorretamente marcado como pago, e o mutex de `ratearSource` permanentemente
 * bloqueado (E5). Este spec:
 *   1) reproduz o estado órfão (bypass direto do estado, simulando o bug
 *      histórico anterior ao fix — não usa a guarda nova);
 *   2) confirma que o mutex ficava travado nesse estado;
 *   3) exercita o `desconciliar` CORRIGIDO (que agora ignora `linkedExpenseId`
 *      e delega a `reverseSourceLinks`) sobre essa MESMA fonte já com o
 *      ponteiro nulo — e confirma o auto-heal completo.
 */

const TENANT_ID = 'tenant-1';
const PESSOAL_PROJECT_ID = 'pessoal-1';
const REFORMA_PROJECT_ID = 'reforma-1';
const SOURCE_ID = 'mirror-1';
const TARGET_ID = 'target-1';

function makeExpenseRow(over: Partial<any> = {}) {
  return {
    id: 'unset',
    tenantId: TENANT_ID,
    projectId: 'unset',
    deletedAt: null,
    linkedExpenseId: null,
    tipoDespesa: 'MATERIAL_CONSTRUCAO',
    categoriaMaoDeObra: null,
    roomId: null,
    valor: 11_000,
    quantidade: 1,
    valorTotal: 11_000,
    titulo: 'row',
    fornecedor: null,
    formaPagamento: 'A_VISTA',
    dataPagamento: new Date('2026-05-10T00:00:00.000Z'),
    quantidadeParcela: null,
    dataInicioParcela: null,
    installmentDateOverrides: null,
    status: 'PAGO',
    paidParcelas: null,
    cardLast4: '1234',
    bankLast4: null,
    accountId: null,
    settlesInvoiceKey: null,
    settledByExpenseId: null,
    createdByUserId: null,
    room: null,
    ...over,
  };
}

function makeHarness() {
  const rows = new Map<string, any>([
    [
      SOURCE_ID,
      makeExpenseRow({
        id: SOURCE_ID,
        projectId: PESSOAL_PROJECT_ID,
        valorTotal: 11_000,
        formaPagamento: 'A_VISTA',
        status: 'PAGO',
      }),
    ],
    [
      TARGET_ID,
      makeExpenseRow({
        id: TARGET_ID,
        projectId: REFORMA_PROJECT_ID,
        valorTotal: 33_000,
        formaPagamento: 'PARCELADO',
        quantidadeParcela: 3,
        dataInicioParcela: new Date('2026-05-01T00:00:00.000Z'),
        status: 'PLANEJADO',
        paidParcelas: null,
      }),
    ],
    [
      'standalone-1',
      makeExpenseRow({ id: 'standalone-1', projectId: PESSOAL_PROJECT_ID, status: 'PAGO' }),
    ],
  ]);

  // key: `${targetExpenseId}|${parcelaIndex}`
  const settlements = new Map<string, any>();

  const prisma: any = {
    project: {
      findFirst: jest.fn(async ({ where }: any) => ({
        id: where.id,
        tenantId: TENANT_ID,
        type: where.id === PESSOAL_PROJECT_ID ? 'PESSOAL' : 'REFORMA',
      })),
    },
    expense: {
      findFirst: jest.fn(async ({ where }: any) => {
        const row = rows.get(where.id);
        if (!row) return null;
        return where.deletedAt === null && row.deletedAt !== null ? null : row;
      }),
      findMany: jest.fn(async ({ where }: any) =>
        [...rows.values()].filter(
          (row) =>
            row.tenantId === where.tenantId &&
            row.linkedExpenseId === where.linkedExpenseId &&
            (where.deletedAt === undefined || row.deletedAt === where.deletedAt),
        ),
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const current = rows.get(where.id);
        const definedData = Object.fromEntries(
          Object.entries(data).filter(([, value]) => value !== undefined),
        );
        const updated = { ...current, ...definedData };
        rows.set(where.id, updated);
        return updated;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const [id, row] of rows) {
          if (
            row.tenantId === where.tenantId &&
            (where.linkedExpenseId === undefined || row.linkedExpenseId === where.linkedExpenseId) &&
            (where.deletedAt === undefined || row.deletedAt === where.deletedAt)
          ) {
            rows.set(id, { ...row, ...data });
            count += 1;
          }
        }
        return { count };
      }),
    },
    rateioAllocation: {
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({}),
    },
    crossProjectSettlement: {
      findUnique: jest.fn(async ({ where }: any) => {
        const k = `${where.targetExpenseId_parcelaIndex.targetExpenseId}|${where.targetExpenseId_parcelaIndex.parcelaIndex}`;
        return settlements.get(k) ?? null;
      }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const k = `${where.targetExpenseId_parcelaIndex.targetExpenseId}|${where.targetExpenseId_parcelaIndex.parcelaIndex}`;
        const cur = settlements.get(k);
        if (cur) Object.assign(cur, update);
        else settlements.set(k, { ...create });
        return settlements.get(k);
      }),
      findMany: jest.fn(async ({ where }: any) =>
        [...settlements.values()].filter(
          (row) =>
            row.tenantId === where.tenantId &&
            (where.sourceExpenseId === undefined || row.sourceExpenseId === where.sourceExpenseId),
        ),
      ),
      deleteMany: jest.fn(async ({ where }: any) => {
        let count = 0;
        for (const [k, row] of settlements) {
          if (
            (where.sourceExpenseId === undefined || row.sourceExpenseId === where.sourceExpenseId) &&
            (where.targetExpenseId === undefined || row.targetExpenseId === where.targetExpenseId)
          ) {
            settlements.delete(k);
            count += 1;
          }
        }
        return { count };
      }),
      count: jest.fn(async ({ where }: any) =>
        [...settlements.values()].filter((row) => {
          if (where.OR) {
            return where.OR.some(
              (clause: any) =>
                (clause.sourceExpenseId === undefined || row.sourceExpenseId === clause.sourceExpenseId) &&
                (clause.targetExpenseId === undefined || row.targetExpenseId === clause.targetExpenseId),
            );
          }
          return (
            (where.sourceExpenseId === undefined || row.sourceExpenseId === where.sourceExpenseId) &&
            (where.targetExpenseId === undefined || row.targetExpenseId === where.targetExpenseId)
          );
        }).length,
      ),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    cashFlowEntry: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest.fn(async (work: any) =>
      typeof work === 'function' ? work(prisma) : Promise.all(work),
    ),
  };

  const conciliacao = new ConciliacaoService(prisma);
  const service = withAclRequester(new ExpenseService(prisma, conciliacao), prisma);
  return { service, prisma, rows, settlements, conciliacao };
}

describe('Reprodução: settlement órfão por bypass de unlinkExpense/desconciliar', () => {
  it('reproduz o histórico órfão, confirma o mutex travado e depois auto-cura via desconciliar corrigido', async () => {
    const { service, prisma, rows, settlements, conciliacao } = makeHarness();

    // 1) Vincula a fonte para quitar a parcela 0 do alvo (fluxo real "Vincular transações").
    await service.conciliarParcela(TENANT_ID, PESSOAL_PROJECT_ID, SOURCE_ID, {
      targetExpenseId: TARGET_ID,
      parcelaIndex: 0,
      realValor: 11_000,
    }, TEST_OWNER_REQUESTER);

    expect(settlements.size).toBe(1);
    expect(rows.get(SOURCE_ID)?.linkedExpenseId).toBe(TARGET_ID);
    expect(rows.get(TARGET_ID)?.paidParcelas).toBe('[0]');

    // 2) BYPASS histórico (pré-fix): algum caminho genérico limpa o ponteiro da
    // fonte diretamente, sem passar por unsettleBySource. Isto reproduz o bug —
    // NÃO usa a guarda nova (`guardSettlementParticipation`), que é justamente o
    // que passa a impedir isto daqui em diante nos endpoints corrigidos.
    rows.set(SOURCE_ID, { ...rows.get(SOURCE_ID), linkedExpenseId: null });

    // A settlement continua órfã: linkedExpenseId sumiu, mas o registro sobrevive.
    expect(settlements.size).toBe(1);
    expect(rows.get(SOURCE_ID)?.linkedExpenseId).toBeNull();

    // 3) Mutex permanece travado: ratearSource nesta MESMA fonte ainda rejeita
    // com a mensagem E5 (a tabela crossProjectSettlement, não o ponteiro nulo,
    // é a fonte da verdade consultada pelo mutex).
    await expect(
      conciliacao.ratearSource(prisma, {
        tenantId: TENANT_ID,
        sourceExpenseId: SOURCE_ID,
        allocations: [{ targetExpenseId: TARGET_ID, allocation: 11_000 }],
      }, TEST_OWNER_REQUESTER),
    ).rejects.toThrow(/conciliada por parcela/i);

    // 4) Chama o `desconciliar` CORRIGIDO na mesma fonte, já com o ponteiro nulo
    // (exatamente o estado do registro real em produção). O fix remove a guarda
    // `if (!source.linkedExpenseId) return alreadyUnlinked` e delega
    // incondicionalmente a `reverseSourceLinks`, que consulta a tabela real.
    const result = await service.desconciliar(TENANT_ID, PESSOAL_PROJECT_ID, SOURCE_ID, TEST_OWNER_REQUESTER);
    expect(result).toEqual({ ok: true });

    // 5) Auto-cura completa:
    expect(settlements.size).toBe(0); // settlement órfã removida
    expect(rows.get(TARGET_ID)?.paidParcelas).toBeNull(); // alvo restaurado
    expect(rows.get(TARGET_ID)?.status).toBe('PLANEJADO');
    expect(rows.get(SOURCE_ID)?.deletedAt).toBeInstanceOf(Date); // fonte soft-deletada

    // 6) O mutex libera: uma FONTE NOVA (não a mesma) pode ratear normalmente,
    // e o count de settlements para a fonte antiga é 0.
    const freshSourceId = 'mirror-2';
    rows.set(
      freshSourceId,
      makeExpenseRow({
        id: freshSourceId,
        projectId: PESSOAL_PROJECT_ID,
        valorTotal: 11_000,
        formaPagamento: 'A_VISTA',
        status: 'PAGO',
      }),
    );
    await prisma.$transaction(async (tx: any) => {
      await expect(
        conciliacao.ratearSource(tx, {
          tenantId: TENANT_ID,
          sourceExpenseId: freshSourceId,
          allocations: [{ targetExpenseId: TARGET_ID, allocation: 11_000 }],
        }, {
          role: 'ADMIN',
          allowedProjects: [],
          allowedProjectTypes: [],
          allowedModules: [],
        }),
      ).resolves.toEqual({ targets: [TARGET_ID] });
    });
    const oldSourceSettlementCount = await prisma.crossProjectSettlement.count({
      where: { sourceExpenseId: SOURCE_ID },
    });
    expect(oldSourceSettlementCount).toBe(0);  });

  it('re-clicar em "desvincular" numa despesa standalone (nunca foi fonte de settlement) é no-op seguro', async () => {
    const { service, rows } = makeHarness();

    const result = await service.desconciliar(TENANT_ID, PESSOAL_PROJECT_ID, 'standalone-1', TEST_OWNER_REQUESTER);

    expect(result).toEqual({ ok: true });
    expect(rows.get('standalone-1')?.deletedAt).toBeNull(); // não soft-deletada
  });
});
