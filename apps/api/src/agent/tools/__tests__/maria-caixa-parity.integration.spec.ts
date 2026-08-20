// The test DB guard must load before PrismaService imports PrismaClient.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../../../scripts/test-db-env.cjs");

/**
 * #508 — PARIDADE DE SALDO EM CONTA: Maria × tela `/conta`.
 *
 * Defeito medido (Journey QA): conta com saldo inicial R$ 3.200,00, salário de
 * R$ 4.500,00 e R$ 813,40 de despesas pagas. A Maria (`get_account_balances`)
 * respondia R$ 3.686,60 enquanto a manchete de `/conta` estampava R$ 6.886,60 —
 * delta de exatamente R$ 3.200,00, o `openingBalanceCents`, porque a tool
 * derivava o número por caminho próprio (`BankAccountService.listAccounts`,
 * movimento puro) em vez do motor canônico §10 (`getCaixaConta`).
 *
 * O oráculo destes testes é o SERVIÇO REAL (`MonthlyOverviewService.getCaixaConta`,
 * a mesma fonte que alimenta `caixaHoje` da tela), nunca um número montado à mão:
 * uma fixture com o valor esperado escrito por mim só provaria a minha suposição.
 * Os pins em centavos existem para travar o valor absoluto (mutação de sinal /
 * remoção da parcela do saldo inicial não passam despercebidas), mas a asserção
 * que define o contrato é a IGUALDADE entre as duas fontes.
 */
import { PrismaClient } from "@prisma/client";
import { ProjectType } from "@reformaflow/domain";
import { PrismaService } from "../../../prisma/prisma.service";
import { MonthlyOverviewService } from "../../../monthly-overview/monthly-overview.service";
import { CardInvoiceSettlementService } from "../../../credit-card/card-invoice-settlement.service";
import { CreditCardService } from "../../../credit-card/credit-card.service";
import { TenantFinancialService } from "../../../tenant-financial/tenant-financial.service";
import { AgentToolsService, type ToolContext } from "../agent-tools.service";

/** Relógio congelado: o §10 corta ocorrências com data > hoje. */
const CLOCK = new Date("2026-03-15T12:00:00.000Z");
const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const TENANT = "qa508-caixa-tenant";

/** Números do Journey QA da #508, em centavos. */
const CENTS = {
  saldoInicial: 320_000, // R$ 3.200,00
  salario: 450_000, // R$ 4.500,00
  despesasPagas: 81_340, // R$ 813,40
  /** O que a TELA estampa: 320.000 + 450.000 − 81.340. */
  telaConta: 688_660, // R$ 6.886,60
  /** O que a Maria respondia ANTES: movimento puro, sem o saldo inicial. */
  mariaAntes: 368_660, // R$ 3.686,60
} as const;

interface AccountSeed {
  openingBalanceCents: number;
  openingBalanceDate: Date | null;
}
interface MovementSeed {
  valor: number;
  data: Date;
}
interface Scenario {
  /** Sufixo do id — cada cenário tem projeto próprio, sem interferência entre casos. */
  slug: string;
  account: AccountSeed;
  receipts: MovementSeed[];
  expenses: MovementSeed[];
  /** Default PESSOAL; usado para provar o gate de tipo do §10. */
  projectType?: ProjectType;
  /** Segunda conta do MESMO projeto, com movimento próprio (last4 distinto). */
  secondAccount?: { last4: string; receipts: MovementSeed[] };
}

const setup = new PrismaClient();
const prisma = new PrismaService();
const cardSettlement = new CardInvoiceSettlementService(prisma);
const monthly = new MonthlyOverviewService(prisma, cardSettlement);
const cards = new CreditCardService(prisma, {} as never, {} as never);
const financial = new TenantFinancialService(prisma, monthly);
const tools = new AgentToolsService(
  prisma,
  financial,
  {} as never, // expenses
  {} as never, // receipts
  cards,
  {} as never, // merchantClassifier
  {} as never, // priceMonitor
  monthly,
);

const LAST4 = "9999";

async function seedScenario(s: Scenario): Promise<string> {
  const projectId = `qa508-${s.slug}`;
  await setup.project.create({
    data: {
      id: projectId,
      tenantId: TENANT,
      type: s.projectType ?? ProjectType.PESSOAL,
      name: `PESSOAL ${s.slug}`,
    },
  });
  await setup.bankAccount.create({
    data: {
      id: `qa508-acc-${s.slug}`,
      tenantId: TENANT,
      projectId,
      institution: "NUBANK",
      nickname: "Nubank Conta",
      last4: LAST4,
      openingBalanceCents: s.account.openingBalanceCents,
      openingBalanceDate: s.account.openingBalanceDate,
    },
  });
  if (s.receipts.length > 0) {
    await setup.receipt.createMany({
      data: s.receipts.map((r, i) => ({
        id: `qa508-rec-${s.slug}-${i}`,
        tenantId: TENANT,
        projectId,
        tipo: "SALARIO",
        status: "EM_CAIXA",
        valor: r.valor,
        data: r.data,
        bankLast4: LAST4,
        origin: "account",
      })),
    });
  }
  if (s.expenses.length > 0) {
    await setup.expense.createMany({
      data: s.expenses.map((e, i) => ({
        id: `qa508-exp-${s.slug}-${i}`,
        tenantId: TENANT,
        projectId,
        tipoDespesa: "ALIMENTACAO",
        titulo: `Despesa ${i}`,
        valor: e.valor,
        quantidade: 1,
        valorTotal: e.valor,
        formaPagamento: "A_VISTA",
        dataPagamento: e.data,
        status: "PAGO",
        bankLast4: LAST4,
        origin: "account",
      })),
    });
  }
  if (s.secondAccount) {
    await setup.bankAccount.create({
      data: {
        id: `qa508-acc2-${s.slug}`,
        tenantId: TENANT,
        projectId,
        institution: "ITAU",
        nickname: "Itaú Conta Corrente",
        last4: s.secondAccount.last4,
        openingBalanceCents: 0,
        openingBalanceDate: null,
      },
    });
    await setup.receipt.createMany({
      data: s.secondAccount.receipts.map((r, i) => ({
        id: `qa508-rec2-${s.slug}-${i}`,
        tenantId: TENANT,
        projectId,
        tipo: "SALARIO",
        status: "EM_CAIXA",
        valor: r.valor,
        data: r.data,
        bankLast4: s.secondAccount!.last4,
        origin: "account",
      })),
    });
  }
  return projectId;
}

/** Contexto OWNER: escopo irrestrito, para isolar o cálculo do gate de ACL. */
function ownerContext(): ToolContext {
  return {
    tenantId: TENANT,
    projectId: null,
    projectScope: null,
    role: "OWNER",
    allowedProjects: [],
    allowedProjectTypes: [],
    allowedModules: [],
    userId: "qa508-user",
    scopeFor: async () => null,
  };
}

/** Saldo bancário que a Maria devolve para UM projeto, em centavos. */
async function mariaSaldoDoProjeto(projectId: string): Promise<number> {
  const out = (await tools.execute(
    "get_account_balances",
    ownerContext(),
    {},
  )) as {
    error?: string;
    contas: Array<{ conta: string; projeto: string; saldoCentavos: number }>;
    totais: { saldoBancarioTotalCentavos: number };
  };
  // `execute` engole exceções num `{ error }`: sem isto, um throw viraria "0" silencioso.
  expect(out.error).toBeUndefined();
  const projeto = `PESSOAL ${projectId.replace("qa508-", "")}`;
  return out.contas
    .filter((c) => c.projeto === projeto)
    .reduce((sum, c) => sum + c.saldoCentavos, 0);
}

describe("#508 — Maria e a tela /conta têm que dar o MESMO saldo (motor §10)", () => {
  beforeAll(async () => {
    jest.useFakeTimers({
      doNotFake: [
        "hrtime",
        "nextTick",
        "performance",
        "queueMicrotask",
        "setImmediate",
        "setInterval",
        "setTimeout",
      ],
    });
    jest.setSystemTime(CLOCK);
    await setup.$connect();
    await prisma.onModuleInit();
    await cleanup();
    await setup.tenant.create({ data: { id: TENANT, name: "QA 508" } });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
    await setup.$disconnect();
    jest.useRealTimers();
  });

  async function cleanup() {
    await setup.expense.deleteMany({ where: { tenantId: TENANT } });
    await setup.receipt.deleteMany({ where: { tenantId: TENANT } });
    await setup.bankAccount.deleteMany({ where: { tenantId: TENANT } });
    await setup.project.deleteMany({ where: { tenantId: TENANT } });
    await setup.tenant.deleteMany({ where: { id: TENANT } });
  }

  it("reproduz o Journey QA: R$ 3.200 iniciais + R$ 4.500 − R$ 813,40 = R$ 6.886,60 nas DUAS fontes", async () => {
    const projectId = await seedScenario({
      slug: "journey",
      account: {
        openingBalanceCents: CENTS.saldoInicial,
        openingBalanceDate: D("2026-01-31"),
      },
      receipts: [{ valor: CENTS.salario, data: D("2026-02-05") }],
      expenses: [{ valor: CENTS.despesasPagas, data: D("2026-02-10") }],
    });

    // Fonte da TELA: o mesmo `caixaHoje` que a manchete de /conta renderiza.
    const tela = await monthly.getCaixaConta(TENANT, projectId);
    expect(tela.hoje).toBe(CENTS.telaConta);
    expect(tela.saldoInicial).toBe(CENTS.saldoInicial);

    const maria = await mariaSaldoDoProjeto(projectId);

    expect(maria).toBe(tela.hoje); // contrato: as duas fontes NUNCA divergem
    expect(maria).toBe(CENTS.telaConta); // pin absoluto (R$ 6.886,60)
    expect(maria).not.toBe(CENTS.mariaAntes); // a regressão exata da #508
  });

  it("respeita a data de corte: movimento ANTES do saldo inicial não é somado por cima dele", async () => {
    const projectId = await seedScenario({
      slug: "corte",
      account: {
        openingBalanceCents: 1_000_000,
        openingBalanceDate: D("2026-02-01"),
      },
      receipts: [
        { valor: 500_000, data: D("2026-01-20") }, // ANTES do corte → já embutido no saldo inicial
        { valor: 200_000, data: D("2026-02-01") }, // NO dia do corte → conta (saldo é na abertura do dia)
        { valor: 300_000, data: D("2026-02-20") }, // DEPOIS → conta
      ],
      expenses: [
        { valor: 100_000, data: D("2026-01-25") }, // ANTES do corte → ignorado
        { valor: 50_000, data: D("2026-02-10") }, // DEPOIS → conta
      ],
    });

    const tela = await monthly.getCaixaConta(TENANT, projectId);
    // 1.000.000 + 200.000 + 300.000 − 50.000; os de janeiro ficam de fora.
    expect(tela.hoje).toBe(1_450_000);

    const maria = await mariaSaldoDoProjeto(projectId);
    expect(maria).toBe(tela.hoje);
    expect(maria).toBe(1_450_000);
    // Se o corte sumisse, a dupla contagem daria 1.850.000.
    expect(maria).not.toBe(1_850_000);
  });

  it("saldo inicial ZERO com data: devolve o movimento puro, não NaN nem null", async () => {
    const projectId = await seedScenario({
      slug: "zero",
      account: { openingBalanceCents: 0, openingBalanceDate: D("2026-01-31") },
      receipts: [{ valor: CENTS.salario, data: D("2026-02-05") }],
      expenses: [{ valor: CENTS.despesasPagas, data: D("2026-02-10") }],
    });

    const tela = await monthly.getCaixaConta(TENANT, projectId);
    const maria = await mariaSaldoDoProjeto(projectId);

    expect(Number.isFinite(maria)).toBe(true);
    expect(maria).toBe(tela.hoje);
    expect(maria).toBe(CENTS.mariaAntes); // 450.000 − 81.340: aqui movimento puro É o certo
  });

  it("saldo inicial AUSENTE (0 e sem data): continua batendo com a tela, sem inventar número", async () => {
    const projectId = await seedScenario({
      slug: "ausente",
      account: { openingBalanceCents: 0, openingBalanceDate: null },
      receipts: [{ valor: 123_400, data: D("2026-02-05") }],
      expenses: [{ valor: 23_400, data: D("2026-02-10") }],
    });

    const tela = await monthly.getCaixaConta(TENANT, projectId);
    expect(tela.temSaldoInicial).toBe(false);

    const maria = await mariaSaldoDoProjeto(projectId);
    expect(Number.isFinite(maria)).toBe(true);
    expect(maria).toBe(tela.hoje);
    expect(maria).toBe(100_000);
  });

  it("conta SEM nenhum movimento devolve o saldo inicial cru — não zero", async () => {
    const projectId = await seedScenario({
      slug: "sem-movimento",
      account: {
        openingBalanceCents: CENTS.saldoInicial,
        openingBalanceDate: D("2026-01-31"),
      },
      receipts: [],
      expenses: [],
    });

    const tela = await monthly.getCaixaConta(TENANT, projectId);
    const maria = await mariaSaldoDoProjeto(projectId);

    expect(maria).toBe(tela.hoje);
    expect(maria).toBe(CENTS.saldoInicial); // remover a parcela do saldo inicial derruba ESTE teste
  });

  it("projeto com DUAS contas: a Maria repete o §10 da conta âncora, sem somar duas vezes", async () => {
    // Limitação HERDADA do motor (§10 é primary-only, ver `pickPrimaryBankAccount`):
    // o movimento da conta secundária não entra no caixa — nem na tela, nem na Maria.
    // Este teste não a conserta; ele TRAVA as duas fontes no mesmo comportamento, para
    // que promover o §10 a corte por conta mova as duas juntas.
    const projectId = await seedScenario({
      slug: "duas-contas",
      account: {
        openingBalanceCents: 200_000,
        openingBalanceDate: D("2026-01-31"),
      },
      receipts: [{ valor: 100_000, data: D("2026-02-05") }],
      expenses: [],
      secondAccount: {
        last4: "4247",
        receipts: [{ valor: 777_000, data: D("2026-02-06") }],
      },
    });

    const tela = await monthly.getCaixaConta(TENANT, projectId);
    const maria = await mariaSaldoDoProjeto(projectId);

    expect(maria).toBe(tela.hoje);
    expect(maria).toBe(300_000); // 200.000 + 100.000, só a conta âncora
    expect(maria).not.toBe(1_077_000); // somar a secundária seria divergir da tela

    const out = (await tools.execute(
      "get_account_balances",
      ownerContext(),
      {},
    )) as {
      contas: Array<{ conta: string; projeto: string }>;
    };
    const doProjeto = out.contas.filter(
      (c) => c.projeto === `PESSOAL duas-contas`,
    );
    expect(doProjeto).toHaveLength(1); // uma linha por §10, não uma por conta
    expect(doProjeto[0]?.conta).toBe("Nubank Conta"); // a conta ÂNCORA, não a primeira criada
  });

  it("projeto NÃO-PESSOAL não entra no bloco de contas — §10 é contrato do cockpit PESSOAL", async () => {
    await seedScenario({
      slug: "casa",
      projectType: ProjectType.CASA,
      account: {
        openingBalanceCents: 999_000,
        openingBalanceDate: D("2026-01-31"),
      },
      receipts: [{ valor: 111_000, data: D("2026-02-05") }],
      expenses: [],
    });

    const out = (await tools.execute(
      "get_account_balances",
      ownerContext(),
      {},
    )) as {
      error?: string;
      contas: Array<{ projeto: string }>;
    };
    expect(out.error).toBeUndefined();
    expect(out.contas.map((c) => c.projeto)).not.toContain("PESSOAL casa");
  });

  it("o total agregado da tool é a soma dos §10 de cada PESSOAL — não uma segunda fórmula", async () => {
    const out = (await tools.execute(
      "get_account_balances",
      ownerContext(),
      {},
    )) as {
      error?: string;
      contas: Array<{ projeto: string; saldoCentavos: number }>;
      totais: { saldoBancarioTotalCentavos: number };
    };
    expect(out.error).toBeUndefined();

    const projetos = await setup.project.findMany({
      where: { tenantId: TENANT, deletedAt: null, type: ProjectType.PESSOAL },
      select: { id: true },
    });
    const somaCanonica = (
      await Promise.all(
        projetos.map((p) => monthly.getCaixaConta(TENANT, p.id)),
      )
    ).reduce((sum, c) => sum + c.hoje, 0);

    expect(out.totais.saldoBancarioTotalCentavos).toBe(somaCanonica);
  });
});
