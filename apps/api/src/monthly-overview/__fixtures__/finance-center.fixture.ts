import type { Prisma, PrismaClient } from "@prisma/client";

export const FINANCE_CENTER_CLOCK = new Date("2026-08-17T15:00:00.000Z");
export const FINANCE_CENTER_MONTH = "2026-08";

export const FINANCE_CENTER_IDS = {
  tenantA: "fc-tenant-a",
  tenantB: "fc-tenant-b",
  projects: {
    pessoal: "fc-a-pessoal",
    secondPessoal: "fc-a-pessoal-second",
    allowed: "fc-a-allowed-reforma",
    hidden: "fc-a-hidden-casa",
    tenantBPessoal: "fc-b-pessoal",
  },
  users: {
    signup: "fc-a-user-signup",
    managed: "fc-a-user-managed",
    admin: "fc-a-user-admin",
    guest: "fc-a-user-guest",
    invalid: "fc-a-user-invalid",
    nonArray: "fc-a-user-non-array",
    mixed: "fc-a-user-mixed",
  },
  accounts: {
    tenantA: "fc-a-bank-4242",
    tenantB: "fc-b-bank-4242",
  },
  cards: {
    c1: "fc-a-card-c1",
    c2: "fc-a-card-c2",
    c3: "fc-a-card-c3",
    tenantBC1: "fc-b-card-c1",
  },
  receipts: {
    bank: "fc-a-receipt-bank",
    wallet: "fc-a-receipt-wallet",
    tenantBCollision: "fc-b-receipt-collision",
  },
  expenses: {
    rateioSource: "fc-a-exp-rateio-source",
    rateioAllowedTarget: "fc-a-exp-rateio-allowed",
    rateioHiddenTarget: "fc-a-exp-rateio-hidden",
    mirrorSource: "fc-a-exp-mirror-source",
    mirrorTarget: "fc-a-exp-mirror-target",
    cardPaysCard: "fc-a-exp-card-pays-card",
    c1Payment: "fc-a-exp-c1-payment",
    c2Purchase: "fc-a-exp-c2-purchase",
    c3Purchase: "fc-a-exp-c3-purchase",
    tenantBCollision: "fc-b-exp-collision",
  },
  rateio: {
    allowed: "fc-a-rateio-allowed",
    hidden: "fc-a-rateio-hidden",
  },
  mirrorSettlement: "fc-a-mirror-settlement",
  serverScenario: "fc-a-server-scenario",
  serverScenarioItem: "fc-a-server-scenario-item",
} as const;

export const FINANCE_CENTER_PERSONA_GRANTS = {
  signup: {
    role: "USER",
    isGuest: false,
    allowedModules: '["dashboard","expenses","bankAccounts","creditCards"]',
    allowedProjects: "[]",
    allowedProjectTypes: '["PESSOAL","REFORMA"]',
  },
  managed: {
    role: "USER",
    isGuest: false,
    allowedModules: '["dashboard","expenses"]',
    allowedProjects: '["fc-a-pessoal","fc-a-allowed-reforma"]',
    allowedProjectTypes: '["PESSOAL","REFORMA"]',
  },
  admin: {
    role: "ADMIN",
    isGuest: false,
    allowedModules: "[]",
    allowedProjects: "[]",
    allowedProjectTypes: "[]",
  },
  guest: {
    role: "USER",
    isGuest: true,
    allowedModules: '["dashboard"]',
    allowedProjects: '["fc-a-pessoal"]',
    allowedProjectTypes: '["PESSOAL"]',
  },
  invalid: {
    role: "USER",
    isGuest: false,
    allowedModules: "{invalid-json",
    allowedProjects: '["fc-a-pessoal"]',
    allowedProjectTypes: '["PESSOAL"]',
  },
  nonArray: {
    role: "USER",
    isGuest: false,
    allowedModules: '{"dashboard":true}',
    allowedProjects: '{"fc-a-pessoal":true}',
    allowedProjectTypes: '{"PESSOAL":true}',
  },
  mixed: {
    role: "USER",
    isGuest: false,
    allowedModules: '["dashboard",7,null,"expenses"]',
    allowedProjects: '["fc-a-pessoal",7,null,"fc-a-allowed-reforma"]',
    allowedProjectTypes: '["PESSOAL",7,null,"REFORMA"]',
  },
} as const;

export const FINANCE_CENTER_PLANNING_LOCAL = {
  storageKey: "personal-planning:fc-a-pessoal",
  payload: {
    version: 2,
    activeScenarioId: "fc-local-planning-main",
    scenarios: [
      {
        id: "fc-local-planning-main",
        name: "Planning local sintético",
        createdAt: "2026-08-01T12:00:00.000Z",
        updatedAt: "2026-08-01T12:00:00.000Z",
        assumptions: {
          monthsAhead: 3,
          monthlyIncomeCents: 450_000,
          monthlyExpenseCents: 125_000,
          incomeGrowthPct: 0,
          expenseGrowthPct: 0,
          targetMonthlySurplusCents: 100_000,
          expenseByTypeCents: { MORADIA: 125_000 },
        },
        months: ["2026-08", "2026-09", "2026-10"],
        incomeByMonthCents: {
          "2026-08": 450_000,
          "2026-09": 450_000,
          "2026-10": 450_000,
        },
        expenseByTypeByMonthCents: {
          "2026-08": { MORADIA: 125_000 },
          "2026-09": { MORADIA: 125_000 },
          "2026-10": { MORADIA: 125_000 },
        },
        expenseTypeOrder: ["MORADIA"],
      },
    ],
  },
} as const;

const IDS = FINANCE_CENTER_IDS;
const D = (day: string) => new Date(`${day}T12:00:00.000Z`);

export async function cleanupFinanceCenterFixture(
  prisma: PrismaClient,
): Promise<void> {
  const tenantIds = [IDS.tenantA, IDS.tenantB];
  await prisma.$transaction(async (tx) => {
    await tx.cashFlowEntry.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await tx.rateioAllocation.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await tx.crossProjectSettlement.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await tx.purchaseScenarioItem.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await tx.purchaseScenario.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await tx.invoiceAdjustment.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await tx.creditCardStatementImport.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await tx.bankStatementImport.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await tx.expense.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.receipt.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.creditCard.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.bankAccount.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.user.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.project.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  });
}

export async function persistFinanceCenterFixture(
  prisma: PrismaClient,
): Promise<void> {
  await cleanupFinanceCenterFixture(prisma);

  await prisma.$transaction(async (tx) => {
    await tx.tenant.createMany({
      data: [
        {
          id: IDS.tenantA,
          name: "Fixture sintética Centro Financeiro A",
          expiresAt: D("2026-12-31"),
          createdAt: D("2026-01-01"),
          updatedAt: D("2026-01-01"),
        },
        {
          id: IDS.tenantB,
          name: "Fixture sintética Centro Financeiro B",
          expiresAt: D("2026-12-31"),
          createdAt: D("2026-01-01"),
          updatedAt: D("2026-01-01"),
        },
      ],
    });

    await tx.project.createMany({
      data: [
        {
          id: IDS.projects.pessoal,
          tenantId: IDS.tenantA,
          type: "PESSOAL",
          name: "Pessoal âncora sintético",
          createdAt: D("2026-01-01"),
          updatedAt: D("2026-01-01"),
        },
        {
          id: IDS.projects.secondPessoal,
          tenantId: IDS.tenantA,
          type: "PESSOAL",
          name: "Segundo Pessoal sintético",
          createdAt: D("2026-01-02"),
          updatedAt: D("2026-01-02"),
        },
        {
          id: IDS.projects.allowed,
          tenantId: IDS.tenantA,
          type: "REFORMA",
          name: "Projeto permitido sintético",
          createdAt: D("2026-01-03"),
          updatedAt: D("2026-01-03"),
        },
        {
          id: IDS.projects.hidden,
          tenantId: IDS.tenantA,
          type: "CASA",
          name: "Projeto oculto sintético",
          createdAt: D("2026-01-04"),
          updatedAt: D("2026-01-04"),
        },
        {
          id: IDS.projects.tenantBPessoal,
          tenantId: IDS.tenantB,
          type: "PESSOAL",
          name: "Pessoal colisão sintético",
          createdAt: D("2026-01-01"),
          updatedAt: D("2026-01-01"),
        },
      ],
    });

    await createPersonas(tx);
    await createAccountsAndCards(tx);
    await createReceipts(tx);
    await createFinancialRelationships(tx);
    await createTenantBCollisions(tx);
    await createServerPlanner(tx);
  });
}

async function createPersonas(tx: Prisma.TransactionClient): Promise<void> {
  const personaRows = [
    {
      id: IDS.users.signup,
      username: "fc-signup",
      email: "fc-signup@example.test",
      name: "Signup USER sintético",
      createdByUserId: null,
      ...FINANCE_CENTER_PERSONA_GRANTS.signup,
    },
    {
      id: IDS.users.admin,
      username: "fc-admin",
      email: "fc-admin@example.test",
      name: "Admin sintético",
      createdByUserId: null,
      ...FINANCE_CENTER_PERSONA_GRANTS.admin,
    },
    {
      id: IDS.users.managed,
      username: "fc-managed",
      email: "fc-managed@example.test",
      name: "Managed USER sintético",
      createdByUserId: IDS.users.admin,
      ...FINANCE_CENTER_PERSONA_GRANTS.managed,
    },
    {
      id: IDS.users.guest,
      username: "fc-guest",
      email: "fc-guest@example.test",
      name: "Guest sintético",
      createdByUserId: IDS.users.admin,
      lastLoginAt: D("2026-08-16"),
      lastActivityAt: D("2026-08-17"),
      ...FINANCE_CENTER_PERSONA_GRANTS.guest,
    },
    {
      id: IDS.users.invalid,
      username: "fc-invalid",
      email: "fc-invalid@example.test",
      name: "Grant inválido sintético",
      createdByUserId: IDS.users.admin,
      ...FINANCE_CENTER_PERSONA_GRANTS.invalid,
    },
    {
      id: IDS.users.nonArray,
      username: "fc-non-array",
      email: "fc-non-array@example.test",
      name: "Grant não array sintético",
      createdByUserId: IDS.users.admin,
      ...FINANCE_CENTER_PERSONA_GRANTS.nonArray,
    },
    {
      id: IDS.users.mixed,
      username: "fc-mixed",
      email: "fc-mixed@example.test",
      name: "Grant misto sintético",
      createdByUserId: IDS.users.admin,
      ...FINANCE_CENTER_PERSONA_GRANTS.mixed,
    },
  ];

  for (const row of personaRows) {
    await tx.user.create({
      data: {
        ...row,
        tenantId: IDS.tenantA,
        createdAt: D("2026-01-05"),
        updatedAt: D("2026-01-05"),
      },
    });
  }
}

async function createAccountsAndCards(
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.bankAccount.createMany({
    data: [
      {
        id: IDS.accounts.tenantA,
        tenantId: IDS.tenantA,
        projectId: IDS.projects.pessoal,
        institution: "TEST_BANK",
        nickname: "Conta sintética A",
        last4: "4242",
        openingBalanceCents: 1_000_000,
        openingBalanceDate: D("2026-01-01"),
        createdAt: D("2026-01-01"),
        updatedAt: D("2026-01-01"),
      },
      {
        id: IDS.accounts.tenantB,
        tenantId: IDS.tenantB,
        projectId: IDS.projects.tenantBPessoal,
        institution: "TEST_BANK",
        nickname: "Conta sintética B",
        last4: "4242",
        openingBalanceCents: 1_000_000,
        openingBalanceDate: D("2026-01-01"),
        createdAt: D("2026-01-01"),
        updatedAt: D("2026-01-01"),
      },
    ],
  });

  await tx.creditCard.createMany({
    data: [
      cardRow(
        IDS.cards.c1,
        IDS.tenantA,
        IDS.projects.pessoal,
        "1111",
        "C1 sintético",
      ),
      cardRow(
        IDS.cards.c2,
        IDS.tenantA,
        IDS.projects.pessoal,
        "2222",
        "C2 sintético",
      ),
      cardRow(
        IDS.cards.c3,
        IDS.tenantA,
        IDS.projects.pessoal,
        "3333",
        "C3 sintético",
      ),
      cardRow(
        IDS.cards.tenantBC1,
        IDS.tenantB,
        IDS.projects.tenantBPessoal,
        "1111",
        "C1 colisão sintético",
      ),
    ],
  });
}

function cardRow(
  id: string,
  tenantId: string,
  projectId: string,
  last4: string,
  nickname: string,
) {
  return {
    id,
    tenantId,
    projectId,
    institution: "TEST_CARD",
    brand: "Visa",
    nickname,
    last4,
    closingDay: 20,
    dueDay: 10,
    createdAt: D("2026-01-01"),
    updatedAt: D("2026-01-01"),
  };
}

async function createReceipts(tx: Prisma.TransactionClient): Promise<void> {
  await tx.receipt.createMany({
    data: [
      {
        id: IDS.receipts.bank,
        tenantId: IDS.tenantA,
        projectId: IDS.projects.pessoal,
        valor: 83_978,
        data: D("2026-08-05"),
        tipo: "PAGAMENTO",
        status: "EM_CAIXA",
        descricao: "Crédito bancário sintético",
        externalId: "fc-collision-receipt",
        bankLast4: "4242",
        accountId: IDS.accounts.tenantA,
        origin: "account",
        createdAt: D("2026-08-05"),
        updatedAt: D("2026-08-05"),
      },
      {
        id: IDS.receipts.wallet,
        tenantId: IDS.tenantA,
        projectId: IDS.projects.pessoal,
        valor: 33_023,
        data: D("2026-08-06"),
        tipo: "OUTROS",
        status: "EM_CAIXA",
        descricao: "Entrada Carteira sintética",
        externalId: "fc-wallet-receipt",
        origin: "none",
        createdAt: D("2026-08-06"),
        updatedAt: D("2026-08-06"),
      },
    ],
  });

  await tx.cashFlowEntry.createMany({
    data: [
      receiptEntry(
        "fc-a-cfe-bank-receipt",
        IDS.receipts.bank,
        83_978,
        "2026-08-05",
      ),
      receiptEntry(
        "fc-a-cfe-wallet-receipt",
        IDS.receipts.wallet,
        33_023,
        "2026-08-06",
      ),
    ],
  });
}

function receiptEntry(
  id: string,
  receiptId: string,
  valor: number,
  day: string,
) {
  return {
    id,
    tenantId: IDS.tenantA,
    projectId: IDS.projects.pessoal,
    receiptId,
    valor,
    tipo: "RECEBIMENTO",
    data: D(day),
    categoria: "OUTROS",
    status: "EM_CAIXA",
    createdAt: D(day),
    updatedAt: D(day),
  };
}

async function createFinancialRelationships(
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.expense.createMany({
    data: [
      expenseRow({
        id: IDS.expenses.rateioSource,
        projectId: IDS.projects.pessoal,
        title: "Fonte rateio sintética",
        total: 30_029,
        day: "2026-08-12",
        status: "PAGO",
        linkedExpenseId: IDS.expenses.rateioAllowedTarget,
        externalId: "fc-rateio-source",
      }),
      expenseRow({
        id: IDS.expenses.rateioAllowedTarget,
        projectId: IDS.projects.allowed,
        title: "Alvo rateio permitido sintético",
        total: 12_007,
        day: "2026-08-12",
        externalId: "fc-rateio-allowed",
      }),
      expenseRow({
        id: IDS.expenses.rateioHiddenTarget,
        projectId: IDS.projects.hidden,
        title: "Alvo rateio oculto sintético",
        total: 18_022,
        day: "2026-08-12",
        externalId: "fc-rateio-hidden",
      }),
      expenseRow({
        id: IDS.expenses.mirrorSource,
        projectId: IDS.projects.pessoal,
        title: "Espelho cartão C1 sintético",
        total: 90_040,
        day: "2026-07-05",
        cardLast4: "1111",
        linkedExpenseId: IDS.expenses.mirrorTarget,
        externalId: "fc-collision-expense",
      }),
      expenseRow({
        id: IDS.expenses.mirrorTarget,
        projectId: IDS.projects.allowed,
        title: "Despesa planejada espelhada sintética",
        total: 90_040,
        day: "2026-07-05",
        externalId: "fc-mirror-target",
      }),
      expenseRow({
        id: IDS.expenses.cardPaysCard,
        projectId: IDS.projects.pessoal,
        title: "C1 paga fatura C2 sintética",
        total: 10_010,
        day: "2026-07-06",
        status: "PAGO",
        type: "PAGAMENTO_FATURA_CARTAO",
        cardLast4: "1111",
        settlesInvoiceKey: "2222:2026-08",
        externalId: "fc-card-pays-card",
      }),
      expenseRow({
        id: IDS.expenses.c1Payment,
        projectId: IDS.projects.pessoal,
        title: "Pagamento fatura C1 sintética",
        total: 100_050,
        day: "2026-08-10",
        status: "PAGO",
        type: "PAGAMENTO_FATURA_CARTAO",
        cardLast4: "1111",
        bankLast4: "4242",
        accountId: IDS.accounts.tenantA,
        externalId: "fc-c1-payment",
      }),
      expenseRow({
        id: IDS.expenses.c2Purchase,
        projectId: IDS.projects.pessoal,
        title: "Compra C2 sintética",
        total: 10_010,
        day: "2026-07-07",
        cardLast4: "2222",
        externalId: "fc-c2-purchase",
      }),
      expenseRow({
        id: IDS.expenses.c3Purchase,
        projectId: IDS.projects.pessoal,
        title: "Compra C3 sintética",
        total: 7_003,
        day: "2026-07-08",
        cardLast4: "3333",
        externalId: "fc-c3-purchase",
      }),
    ],
  });

  await tx.rateioAllocation.createMany({
    data: [
      {
        id: IDS.rateio.allowed,
        tenantId: IDS.tenantA,
        sourceExpenseId: IDS.expenses.rateioSource,
        targetExpenseId: IDS.expenses.rateioAllowedTarget,
        allocation: 12_007,
        plannedStatus: "PLANEJADO",
        plannedValor: 12_007,
        plannedQuantidade: 1,
        plannedValorTotal: 12_007,
        plannedForma: "A_VISTA",
        plannedDataPagamento: D("2026-08-12"),
        createdAt: D("2026-08-12"),
      },
      {
        id: IDS.rateio.hidden,
        tenantId: IDS.tenantA,
        sourceExpenseId: IDS.expenses.rateioSource,
        targetExpenseId: IDS.expenses.rateioHiddenTarget,
        allocation: 18_022,
        plannedStatus: "PLANEJADO",
        plannedValor: 18_022,
        plannedQuantidade: 1,
        plannedValorTotal: 18_022,
        plannedForma: "A_VISTA",
        plannedDataPagamento: D("2026-08-12"),
        createdAt: D("2026-08-12"),
      },
    ],
  });

  await tx.crossProjectSettlement.create({
    data: {
      id: IDS.mirrorSettlement,
      tenantId: IDS.tenantA,
      sourceExpenseId: IDS.expenses.mirrorSource,
      targetExpenseId: IDS.expenses.mirrorTarget,
      parcelaIndex: 0,
      realValor: 90_040,
      plannedValor: 90_040,
      plannedStatus: "PLANEJADO",
      createdAt: D("2026-07-05"),
    },
  });

  await tx.cashFlowEntry.createMany({
    data: [
      expenseEntry(
        "fc-a-cfe-rateio-source",
        IDS.expenses.rateioSource,
        30_029,
        "2026-08-12",
        "PAGO",
      ),
      expenseEntry(
        "fc-a-cfe-mirror-source",
        IDS.expenses.mirrorSource,
        90_040,
        "2026-07-05",
      ),
      expenseEntry(
        "fc-a-cfe-card-pays-card",
        IDS.expenses.cardPaysCard,
        10_010,
        "2026-07-06",
        "PAGO",
      ),
      expenseEntry(
        "fc-a-cfe-c2-purchase",
        IDS.expenses.c2Purchase,
        10_010,
        "2026-07-07",
      ),
      expenseEntry(
        "fc-a-cfe-c3-purchase",
        IDS.expenses.c3Purchase,
        7_003,
        "2026-07-08",
      ),
    ],
  });
}

function expenseRow(params: {
  id: string;
  projectId: string;
  title: string;
  total: number;
  day: string;
  status?: string;
  type?: string;
  cardLast4?: string;
  bankLast4?: string;
  accountId?: string;
  linkedExpenseId?: string;
  settlesInvoiceKey?: string;
  externalId: string;
}) {
  return {
    id: params.id,
    tenantId: IDS.tenantA,
    projectId: params.projectId,
    tipoDespesa: params.type ?? "OUTROS",
    titulo: params.title,
    fornecedor: "Fornecedor sintético",
    valor: params.total,
    quantidade: 1,
    valorTotal: params.total,
    formaPagamento: "A_VISTA",
    dataPagamento: D(params.day),
    dataCompra: D(params.day),
    status: params.status ?? "PLANEJADO",
    cardLast4: params.cardLast4,
    bankLast4: params.bankLast4,
    accountId: params.accountId,
    origin: params.accountId ? "account" : "none",
    linkedExpenseId: params.linkedExpenseId,
    settlesInvoiceKey: params.settlesInvoiceKey,
    externalId: params.externalId,
    createdAt: D(params.day),
    updatedAt: D(params.day),
  };
}

function expenseEntry(
  id: string,
  expenseId: string,
  valor: number,
  day: string,
  status = "PLANEJADO",
) {
  return {
    id,
    tenantId: IDS.tenantA,
    projectId: IDS.projects.pessoal,
    expenseId,
    valor,
    tipo: "DESPESA",
    data: D(day),
    categoria: "OUTROS",
    formaPagamento: "A_VISTA",
    status,
    createdAt: D(day),
    updatedAt: D(day),
  };
}

async function createTenantBCollisions(
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.receipt.create({
    data: {
      id: IDS.receipts.tenantBCollision,
      tenantId: IDS.tenantB,
      projectId: IDS.projects.tenantBPessoal,
      valor: 83_978,
      data: D("2026-08-05"),
      tipo: "PAGAMENTO",
      status: "EM_CAIXA",
      descricao: "Crédito colisão sintético",
      externalId: "fc-collision-receipt",
      bankLast4: "4242",
      accountId: IDS.accounts.tenantB,
      origin: "account",
      createdAt: D("2026-08-05"),
      updatedAt: D("2026-08-05"),
    },
  });
  await tx.expense.create({
    data: {
      id: IDS.expenses.tenantBCollision,
      tenantId: IDS.tenantB,
      projectId: IDS.projects.tenantBPessoal,
      tipoDespesa: "OUTROS",
      titulo: "Despesa colisão sintética",
      fornecedor: "Fornecedor sintético",
      valor: 90_040,
      quantidade: 1,
      valorTotal: 90_040,
      formaPagamento: "A_VISTA",
      dataPagamento: D("2026-07-05"),
      dataCompra: D("2026-07-05"),
      status: "PLANEJADO",
      cardLast4: "1111",
      externalId: "fc-collision-expense",
      createdAt: D("2026-07-05"),
      updatedAt: D("2026-07-05"),
    },
  });
  await tx.cashFlowEntry.create({
    data: {
      id: "fc-b-cfe-collision",
      tenantId: IDS.tenantB,
      projectId: IDS.projects.tenantBPessoal,
      expenseId: IDS.expenses.tenantBCollision,
      valor: 90_040,
      tipo: "DESPESA",
      data: D("2026-07-05"),
      categoria: "OUTROS",
      formaPagamento: "A_VISTA",
      status: "PLANEJADO",
      createdAt: D("2026-07-05"),
      updatedAt: D("2026-07-05"),
    },
  });
}

async function createServerPlanner(
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.purchaseScenario.create({
    data: {
      id: IDS.serverScenario,
      tenantId: IDS.tenantA,
      projectId: IDS.projects.pessoal,
      nome: "Planejador server sintético",
      horizonteMeses: 6,
      createdAt: D("2026-08-01"),
      updatedAt: D("2026-08-01"),
    },
  });
  await tx.purchaseScenarioItem.create({
    data: {
      id: IDS.serverScenarioItem,
      scenarioId: IDS.serverScenario,
      tenantId: IDS.tenantA,
      projectId: IDS.projects.pessoal,
      nome: "Item server sintético",
      tipo: "PARCELADO",
      valorCents: 206_960,
      parcelas: 6,
      mesInicio: "2026-09",
      incluido: true,
      createdAt: D("2026-08-01"),
      updatedAt: D("2026-08-01"),
    },
  });
}
