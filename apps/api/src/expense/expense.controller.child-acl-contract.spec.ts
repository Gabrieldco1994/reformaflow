/**
 * B1a (#448) — contrato de controller: `ExpenseController` precisa repassar
 * o `requester` (`@CurrentUser()`) para `link` (linkCrossProject),
 * `conciliarParcela` e `ratear`. Autorado RED contra o baseline pré-#448;
 * GREEN após a implementação — mantido como regression lock.
 *
 * No baseline pré-#448, NENHUM dos três sequer declarava o parâmetro
 * `@CurrentUser()`, então não havia de onde o child ACL (issue #448) ler o
 * scope de quem está chamando. `ratearMixed` já declarava `@CurrentUser()`
 * mas só repassava `requester.id` (autoria), não o requester inteiro (scope
 * de ACL).
 *
 * Teste de CONTRATO (service mockado); a lógica de ACL em si é coberta com
 * Prisma real em `expense.child-acl.spec.ts`.
 */
import { ExpenseController } from './expense.controller';

const REQUESTER = { id: 'u1', role: 'USER', allowedProjects: ['p1'], allowedProjectTypes: ['PESSOAL'], allowedModules: ['expenses'] };

function buildController(serviceOverrides: Record<string, jest.Mock>) {
  const service = {
    linkCrossProject: jest.fn().mockResolvedValue({ ok: true }),
    conciliarParcela: jest.fn().mockResolvedValue({ ok: true }),
    ratear: jest.fn().mockResolvedValue({ ok: true }),
    ratearMixed: jest.fn().mockResolvedValue({ ok: true }),
    ...serviceOverrides,
  };
  const paidOriginsService = {};
  return { controller: new ExpenseController(service as any, paidOriginsService as any), service };
}

describe('ExpenseController — repassa requester ao service nas mutações child-ACL (#448 B1a)', () => {
  it('link (linkCrossProject): requester chega ao service', async () => {
    const { controller, service } = buildController({});
    await (controller as any).link('t1', 'p1', 'src-1', { targetExpenseId: 'tgt-1' }, REQUESTER);
    expect(service.linkCrossProject.mock.calls[0]).toContainEqual(REQUESTER);
  });

  it('conciliarParcela: requester chega ao service', async () => {
    const { controller, service } = buildController({});
    await (controller as any).conciliarParcela(
      't1', 'p1', 'src-1', { targetExpenseId: 'tgt-1', parcelaIndex: 0, realValor: 100 }, REQUESTER,
    );
    expect(service.conciliarParcela.mock.calls[0]).toContainEqual(REQUESTER);
  });

  it('ratear: requester chega ao service', async () => {
    const { controller, service } = buildController({});
    await (controller as any).ratear(
      't1', 'p1', 'src-1', { allocations: [{ targetExpenseId: 'tgt-1', allocation: 100 }] }, REQUESTER,
    );
    expect(service.ratear.mock.calls[0]).toContainEqual(REQUESTER);
  });

  it('ratearMixed: o REQUESTER INTEIRO (não só requester.id) chega ao service', async () => {
    const { controller, service } = buildController({});
    await controller.ratearMixed(
      't1', 'p1', 'src-1', REQUESTER, { newTargets: [], existing: [] },
    );
    // No baseline pré-#448, `ratearMixed` só repassava `requester.id` — o
    // objeto completo (scope de ACL) nunca chegava ao service.
    expect(service.ratearMixed.mock.calls[0]).toContainEqual(REQUESTER);
  });
});
