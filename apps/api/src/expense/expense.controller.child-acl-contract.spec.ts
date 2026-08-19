/**
 * B1a (#448) — contrato de controller: `ExpenseController` precisa repassar
 * o `requester` (`@CurrentUser()`) para `link` (linkCrossProject),
 * `conciliarParcela`, `ratear`, `createRecorrente` (obraProjectId child) e
 * `findCrossProject` (listagem cross-project). Autorado RED contra o
 * baseline pré-#448/pré-security-phase-2; GREEN após a implementação —
 * mantido como regression lock.
 *
 * No baseline pré-#448, NENHUM dos cinco sequer declarava o parâmetro
 * `@CurrentUser()` (ou, no caso de `ratearMixed`, só repassava `requester.id`
 * — autoria, não o requester inteiro/scope de ACL), então não havia de onde
 * o child ACL (issue #448) ler o scope de quem está chamando.
 *
 * `createRecorrente`/`findCrossProject` (security phase 2, achados
 * verificados 2026-08-18): mesma lacuna para o child `dto.obraProjectId`/a
 * listagem cross-project, que chegam SÓ por body/query, nunca pelo
 * `:projectId` que o `ProjectAccessGuard` global enxerga. `createRecorrente`
 * já declarava `@CurrentUser()` no baseline (só repassava `requester.id`,
 * como `ratearMixed`); `findCrossProject` é que nem declarava o parâmetro.
 *
 * Teste de CONTRATO (service mockado); a lógica de ACL em si é coberta com
 * Prisma real em `expense.child-acl.spec.ts`,
 * `expense.recorrente-cross-project-acl.spec.ts` e
 * `expense.find-cross-project-acl.spec.ts`.
 */
import { ExpenseController } from './expense.controller';

const REQUESTER = { id: 'u1', role: 'USER', allowedProjects: ['p1'], allowedProjectTypes: ['PESSOAL'], allowedModules: ['expenses'] };

function buildController(serviceOverrides: Record<string, jest.Mock>) {
  const service = {
    linkCrossProject: jest.fn().mockResolvedValue({ ok: true }),
    conciliarParcela: jest.fn().mockResolvedValue({ ok: true }),
    ratear: jest.fn().mockResolvedValue({ ok: true }),
    ratearMixed: jest.fn().mockResolvedValue({ ok: true }),
    desratear: jest.fn().mockResolvedValue({ ok: true }),
    desconciliar: jest.fn().mockResolvedValue({ ok: true }),
    remove: jest.fn().mockResolvedValue({ ok: true }),
    createRecorrente: jest.fn().mockResolvedValue({ ok: true }),
    findCrossProject: jest.fn().mockResolvedValue([]),
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

  it.each([
    ['desratear', ['t1', 'p1', 'src-1', REQUESTER]],
    ['desconciliar', ['t1', 'p1', 'src-1', REQUESTER]],
    ['remove', ['t1', 'p1', 'src-1', REQUESTER]],
  ] as const)('%s repassa o requester completo às reversões', async (method, args) => {
    const { controller, service } = buildController({});
    await (controller[method] as (...callArgs: unknown[]) => Promise<unknown>)(...args);
    expect(service[method]).toHaveBeenCalledWith('t1', 'p1', 'src-1', REQUESTER);
  });

  it('createRecorrente: o REQUESTER INTEIRO (não só requester.id) chega ao service (security phase 2)', async () => {
    const { controller, service } = buildController({});
    const dto = {
      frequencia: 'MENSAL', dataInicio: '2026-08-01', dataFim: '2026-08-01',
      tipoDespesa: 'MATERIAL_CONSTRUCAO', valor: 100, titulo: 'Recorrência', obraProjectId: 'obra-1',
    };
    await controller.createRecorrente('t1', 'p1', REQUESTER, dto as any);
    // No baseline, o controller só repassava `requester.id` (autoria) — o
    // scope de ACL nunca chegava ao service, então `dto.obraProjectId`
    // (child) nunca podia ser checado contra o requester.
    expect(service.createRecorrente.mock.calls[0]).toContainEqual(REQUESTER);
  });

  it('findCrossProject: requester chega ao service (security phase 2)', async () => {
    const { controller, service } = buildController({});
    // Assinatura real (fix 1651d0a3): findCrossProject(tenantId, projectId,
    // requester, search?, targetProjectId?, status?, limit?) — requester é o
    // 3º arg, ANTES dos query params opcionais, não o 7º. Cast só no
    // requester (o controller ainda não declara esse parâmetro nesta
    // branch, que é test-only; a ordem/contagem de argumentos já é a real).
    await controller.findCrossProject('t1', 'p1', REQUESTER as any);
    // No baseline, o método do controller nem declarava `@CurrentUser()` —
    // a listagem cross-project não tinha NENHUM requester para filtrar por.
    expect(service.findCrossProject.mock.calls[0]).toContainEqual(REQUESTER);
  });
});
