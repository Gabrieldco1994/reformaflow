/**
 * B1a (#448) — contrato de controller para `payInvoice`/`undoInvoicePayment`.
 *
 * IMPORTANTE — isto sempre foi um REGRESSION LOCK (GREEN), não um RED: o
 * `body` tipado inline do controller não é uma classe `class-validator` (é um
 * tipo TS puro), então o controller repassa o objeto INTEIRO ao service
 * verbatim — qualquer campo extra do payload (`cardId`/`accountId`) já
 * atravessava o controller mesmo no baseline pré-#448, antes de a assinatura
 * TS sequer declarar esses campos (que só afeta o compile-time, não o
 * runtime). Ou seja: a lacuna do #448 nunca esteve nesta camada — estava
 * inteiramente no SERVICE, que no baseline ignorava `cardId`/`accountId`
 * (RED autorado e hoje GREEN em `invoice-identity-contract.spec.ts`; a
 * implementação real agora declara `cardId`/`accountId` no tipo do body — ver
 * `monthly-overview.controller.ts`). Mantido aqui como trava de regressão: se
 * um dia este handler passar a usar uma DTO `class-validator` com
 * `whitelist`, este teste flagra a quebra silenciosa do pass-through.
 */
import { MonthlyOverviewController } from './monthly-overview.controller';

const REQUESTER = { id: 'u1', role: 'USER', allowedProjects: ['p1'], allowedProjectTypes: ['PESSOAL'], allowedModules: ['monthlyOverview'] };

describe('MonthlyOverviewController — repassa identidade aditiva (cardId/accountId) ao service (#448 B1a)', () => {
  it('payInvoice: cardId/accountId do body chegam ao service junto do legado', async () => {
    const service = { payInvoice: jest.fn().mockResolvedValue({ ok: true }) };
    const controller = new MonthlyOverviewController(service as any);

    const body = {
      cardId: 'card-real-id', cardLast4: '1111', accountId: 'acc-real-id', bankLast4: '9999',
      month: '2026-08', amountCents: 1000, paymentDate: '2026-08-10',
    };
    await controller.payInvoice('t1', REQUESTER, 'p1', body);

    // service.payInvoice(tenantId, projectId, dto, requester) — dto é o 3º arg (índice 2).
    const [, , forwardedBody] = service.payInvoice.mock.calls[0];
    expect(forwardedBody.cardId).toBe('card-real-id');
    expect(forwardedBody.accountId).toBe('acc-real-id');
  });

  it('undoInvoicePayment: cardId do body chega ao service junto do legado', async () => {
    const service = { undoInvoicePayment: jest.fn().mockResolvedValue({ ok: true }) };
    const controller = new MonthlyOverviewController(service as any);

    const body = { cardId: 'card-real-id', cardLast4: '1111', dueMonth: '2026-08' };
    await controller.undoInvoicePayment('t1', REQUESTER, 'p1', body);

    // service.undoInvoicePayment(tenantId, projectId, dto, requester) — dto é o 3º arg.
    const [, , forwardedBody] = service.undoInvoicePayment.mock.calls[0];
    expect(forwardedBody.cardId).toBe('card-real-id');
  });
});
