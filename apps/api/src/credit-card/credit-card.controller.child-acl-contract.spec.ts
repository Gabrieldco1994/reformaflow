/**
 * B1a (#448) — RED (contrato de controller): `CreditCardController.linkToExpense`
 * precisa repassar o `requester` (`@CurrentUser()`) ao service, para que o
 * child ACL (issue #448) tenha DE ONDE ler o scope de quem está chamando.
 *
 * Hoje o controller só repassa `tenantId/projectId/expenseId/targetExpenseId/
 * opts` — nenhum requester chega ao service. Teste de CONTRATO (service
 * mockado; a lógica de ACL em si é coberta com Prisma real em
 * `credit-card.duplicate-guard.spec.ts` e `expense.child-acl.spec.ts`).
 */
import { CreditCardController } from './credit-card.controller';

describe('CreditCardController.linkToExpense — repassa requester ao service (#448 B1a)', () => {
  it('o requester autenticado (@CurrentUser) chega como argumento ao service.linkToExpense', async () => {
    const service = { linkToExpense: jest.fn().mockResolvedValue({ ok: true }) };
    const controller = new CreditCardController(service as any);

    const requester = { id: 'u1', role: 'USER', allowedProjects: ['p1'], allowedProjectTypes: ['PESSOAL'], allowedModules: ['creditCards'] };

    await (controller as any).linkToExpense(
      't1', 'p1', 'card-expense-1', { targetExpenseId: 'target-1', parcelaIndex: 0, realValor: 100 }, requester,
    );

    expect(service.linkToExpense).toHaveBeenCalled();
    const args = service.linkToExpense.mock.calls[0];
    // Falha hoje: nenhum argumento da chamada é (ou contém) o requester.
    expect(args).toContainEqual(requester);
  });
});
