import { Test, TestingModule } from "@nestjs/testing";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import {
  MonthlyOverviewService,
  MonthlyOverviewMutationRequester,
} from "./monthly-overview.service";
import { PrismaService } from "../prisma/prisma.service";
import { CardInvoiceSettlementService } from "../credit-card/card-invoice-settlement.service";

/**
 * B0 (#447) — as DUAS mutações de fatura (`payInvoice` / `undoInvoicePayment`)
 * herdaram o rename da rota (`:projectId` → `:pessoalProjectId`, deliberado para
 * que `resolveAnchor` seja dono da distinção 404/403/400 nos 7 GETs), mas NÃO
 * herdaram a autorização a nível de service: `ProjectAccessGuard` só reconhece
 * `projectId`/`sourceProjectId`/`targetProjectId`, então com o param renomeado
 * NENHUMA camada checava o scope do requester — um USER restrito com o módulo
 * `monthlyOverview` mutava qualquer anchor PESSOAL do mesmo tenant.
 *
 * Contrato: `ensurePessoalProject(tenantId, projectId, requester)` roda ANTES de
 * qualquer leitura/escrita nas duas mutações (403 sem tocar no Prisma), e o
 * `requester` é OBRIGATÓRIO nas duas — requester opcional é fail-open por
 * construção (basta um chamador esquecer o argumento para o dinheiro se mover
 * sem dono). Quem tem acesso total declara o papel (ADMIN/OWNER); ausência de
 * requester não é mais sinônimo de acesso total.
 */
describe("MonthlyOverviewService — mutações de fatura respeitam o scope do requester (B0 #447)", () => {
  let service: MonthlyOverviewService;
  let prisma: any;
  let settlement: any;

  const tenantId = "tenant-1";
  const ANCHOR = "pessoal-anchor";
  const ALLOWED = "pessoal-allowed";

  const PROJECTS = [
    { id: ANCHOR, name: "Pessoal (anchor)", type: "PESSOAL" },
    { id: ALLOWED, name: "Pessoal (autorizado)", type: "PESSOAL" },
  ];

  /** USER restrito cujo `allowedProjects` NÃO inclui o anchor alvo. */
  const restrictedRequester: MonthlyOverviewMutationRequester = {
    id: "user-abc",
    role: "USER",
    allowedProjects: [ALLOWED],
    allowedProjectTypes: ["PESSOAL"],
    allowedModules: ["monthlyOverview"],
  };

  const payDto = {
    cardLast4: "1111",
    month: "2026-06",
    amountCents: 7_000,
    bankLast4: "4247",
    paymentDate: "2026-05-31",
  };
  const undoDto = { cardLast4: "1111", dueMonth: "2026-06" };

  beforeEach(async () => {
    prisma = {
      project: {
        // O anchor EXISTE no tenant (não é 404) e é PESSOAL (não é 400):
        // o único motivo de recusa possível é o scope do requester (403).
        findFirst: jest.fn().mockResolvedValue({
          id: ANCHOR,
          tenantId,
          type: "PESSOAL",
          deletedAt: null,
        }),
        // Materializa o scope como o Prisma real faria (filtra por id/type).
        findMany: jest.fn().mockImplementation((args: any = {}) => {
          const where = args.where ?? {};
          const ids: string[] | undefined = where.id?.in;
          const types: string[] | undefined = where.type?.in;
          return Promise.resolve(
            PROJECTS.filter(
              (p) =>
                (ids === undefined || ids.includes(p.id)) &&
                (types === undefined || types.includes(p.type)),
            ).map((p) => ({ id: p.id })),
          );
        }),
      },
      creditCard: {
        findFirst: jest.fn().mockResolvedValue({
          id: "card-1",
          last4: "1111",
          nickname: "Nubank",
          closingDay: 20,
          dueDay: 28,
        }),
      },
      bankAccount: { findFirst: jest.fn().mockResolvedValue({ last4: "4247" }) },
      expense: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: "pay-1" }),
        update: jest.fn(),
      },
      cashFlowEntry: { findMany: jest.fn().mockResolvedValue([]) },
      invoiceAdjustment: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(),
    };

    settlement = {
      settleInvoice: jest
        .fn()
        .mockResolvedValue({ settledExpenses: 0, settledParcelas: 0 }),
      unsettleInvoice: jest
        .fn()
        .mockResolvedValue({ revertedExpenses: 0, revertedParcelas: 0 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MonthlyOverviewService,
        { provide: PrismaService, useValue: prisma },
        { provide: CardInvoiceSettlementService, useValue: settlement },
      ],
    }).compile();

    service = module.get<MonthlyOverviewService>(MonthlyOverviewService);
  });

  function expectNoWrite() {
    expect(prisma.expense.create).not.toHaveBeenCalled();
    expect(prisma.expense.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(settlement.settleInvoice).not.toHaveBeenCalled();
    expect(settlement.unsettleInvoice).not.toHaveBeenCalled();
    // Recusa ANTES de qualquer leitura do projeto alvo (nem enumera cartões).
    expect(prisma.creditCard.findFirst).not.toHaveBeenCalled();
  }

  it("payInvoice recusa (403) requester restrito fora do anchor, sem escrever nada", async () => {
    await expect(
      service.payInvoice(tenantId, ANCHOR, payDto, restrictedRequester),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expectNoWrite();
  });

  it("undoInvoicePayment recusa (403) requester restrito fora do anchor, sem escrever nada", async () => {
    await expect(
      service.undoInvoicePayment(tenantId, ANCHOR, undoDto, restrictedRequester),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expectNoWrite();
  });

  it("regression-lock: o MESMO requester passa quando o anchor está no allowedProjects (payInvoice audita requester.id)", async () => {
    const authorized: MonthlyOverviewMutationRequester = {
      ...restrictedRequester,
      allowedProjects: [ANCHOR],
    };

    await expect(
      service.payInvoice(tenantId, ANCHOR, payDto, authorized),
    ).resolves.toEqual(expect.objectContaining({ ok: true }));

    // Autoria auditada VEM do requester autorizado — não de um id solto que o
    // chamador poderia forjar independentemente da credencial.
    expect(prisma.expense.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: ANCHOR,
          tipoDespesa: "PAGAMENTO_FATURA_CARTAO",
          createdByUserId: authorized.id,
        }),
      }),
    );
  });

  it("regression-lock: undoInvoicePayment autorizado passa da checagem de scope e segue o fluxo normal", async () => {
    const authorized: MonthlyOverviewMutationRequester = {
      ...restrictedRequester,
      allowedProjects: [ANCHOR],
    };
    prisma.creditCard.findFirst.mockResolvedValue(null);

    await expect(
      service.undoInvoicePayment(tenantId, ANCHOR, undoDto, authorized),
    ).rejects.toBeInstanceOf(NotFoundException); // "Cartão não encontrado" — passou do 403.

    expect(prisma.creditCard.findFirst).toHaveBeenCalled();
  });

  it("acesso total é DECLARADO pelo papel (ADMIN), não pela ausência de requester", async () => {
    const admin: MonthlyOverviewMutationRequester = { id: "admin-1", role: "ADMIN" };

    await expect(service.payInvoice(tenantId, ANCHOR, payDto, admin)).resolves.toEqual(
      expect.objectContaining({ ok: true }),
    );
    expect(prisma.expense.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ createdByUserId: "admin-1" }),
      }),
    );
  });

  // O gate primário é o compilador (requester é argumento obrigatório nas duas
  // mutações). Este caso pina o comportamento em runtime para chamador não
  // tipado (JS/`any`): fail-CLOSED, nunca acesso total silencioso.
  it.each([
    ["payInvoice", (svc: any) => svc.payInvoice(tenantId, ANCHOR, payDto)],
    ["undoInvoicePayment", (svc: any) => svc.undoInvoicePayment(tenantId, ANCHOR, undoDto)],
  ])("%s sem requester falha fechado (403) em vez de assumir acesso total", async (_name, call) => {
    await expect(call(service as any)).rejects.toBeInstanceOf(ForbiddenException);

    expectNoWrite();
    // Nem chega a resolver o anchor: recusa antes de qualquer I/O.
    expect(prisma.project.findFirst).not.toHaveBeenCalled();
  });
});
