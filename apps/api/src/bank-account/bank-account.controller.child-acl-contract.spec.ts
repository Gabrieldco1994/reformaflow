/**
 * B1a (#448) — RED (contrato de controller): espelha
 * `credit-card.controller.child-acl-contract.spec.ts` para
 * `BankAccountController.linkToExpense`.
 */
import { BankAccountController } from './bank-account.controller';

describe('BankAccountController.linkToExpense — repassa requester ao service (#448 B1a)', () => {
  it('o requester autenticado (@CurrentUser) chega como argumento ao service.linkToExpense', async () => {
    const service = { linkToExpense: jest.fn().mockResolvedValue({ ok: true }) };
    const controller = new BankAccountController(service as any);

    const requester = { id: 'u1', role: 'USER', allowedProjects: ['p1'], allowedProjectTypes: ['PESSOAL'], allowedModules: ['bankAccounts'] };

    await (controller as any).linkToExpense(
      't1', 'p1', 'account-expense-1', { targetExpenseId: 'target-1', parcelaIndex: 0, realValor: 100 }, requester,
    );

    expect(service.linkToExpense).toHaveBeenCalled();
    const args = service.linkToExpense.mock.calls[0];
    expect(args).toContainEqual(requester);
  });
});
