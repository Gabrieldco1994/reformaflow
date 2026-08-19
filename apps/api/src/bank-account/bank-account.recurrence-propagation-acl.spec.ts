// The database guard must run before PrismaClient is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../scripts/test-db-env.cjs");

import { PrismaClient } from "@prisma/client";
import { CardInvoiceSettlementService } from "../credit-card/card-invoice-settlement.service";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import type { RateioRequester } from "../expense/rateio.types";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import { PrismaService } from "../prisma/prisma.service";
import { BankAccountService } from "./bank-account.service";

/**
 * #481 — a propagação de recorrências do extrato ESCREVE `RecurringBill` num
 * projeto CASA/CARRO que não é o projeto da importação. Antes deste fix ela
 * escolhia o PRIMEIRO projeto CASA/CARRO ativo do tenant inteiro, sem receber o
 * requisitante e sem exigir o módulo `recurringBills` — qualquer usuário com
 * acesso à conta bancária escrevia (create E update) num projeto fora da sua ACL.
 *
 * Contrato coberto aqui:
 *  1. requisitante COM o projeto CASA e o módulo `recurringBills` → propaga;
 *  2. requisitante SEM o único projeto CASA do tenant → ZERO escrita, estado
 *     financeiro fora do projeto de origem byte-idêntico (inclusive uma conta
 *     recorrente pré-existente, que o bug ATUALIZAVA sem criar nada — por isso
 *     `recurrencesCreated === 0` sozinho não é prova);
 *  3. módulo NÃO relacionado suportado pelo MESMO tipo (CASA tem `maintenance`)
 *     não libera o recurso (classe SEC-1 do #480);
 *  4. OWNER segue irrestrito no tenant;
 *  5. dois projetos CASA, só o segundo acessível → a recorrência nasce no
 *     ACESSÍVEL (a seleção é escopada, não "o primeiro do tenant" com guarda
 *     depois).
 */

const setup = new PrismaClient();
const prisma = new PrismaService();

const TENANT = "sec481-recurrence-tenant";
const PESSOAL = "sec481-recurrence-pessoal";
/** Primeiro CASA criado no tenant — é o que o código vulnerável escolhia. */
const CASA_FIRST = "sec481-recurrence-casa-first";
const CASA_ALLOWED = "sec481-recurrence-casa-allowed";
const CARRO_HIDDEN = "sec481-recurrence-carro-hidden";
const ACCOUNT_ID = "sec481-recurrence-account";
const BANK_LAST4 = "4811";
const CREATED_BY = "sec481-recurrence-user";

const FIXED_CLOCK = new Date("2026-08-19T15:00:00.000Z");
/** Data do lançamento ENEL no extrato (OFX sempre gera meia-noite UTC). */
const TX_DATE = new Date("2026-07-10T00:00:00.000Z");
const SEEDED_AT = new Date("2026-05-01T12:00:00.000Z");
const UTILITY_MERCHANT = "ENEL SP";
const UTILITY_CENTS = 12_345;
const VEHICLE_TAX_MERCHANT = "IPVA 2026 DETRAN";

/**
 * `propagateRecurrences` usa `payDate.getDate()` (dia do mês na TZ do runner) —
 * em UTC-3 uma data meia-noite UTC cai no dia anterior. Esse off-by-one é
 * comportamento pré-existente e NÃO é o alvo do #481: o dia é derivado aqui em
 * vez de fixado para o spec não travar aritmética de fuso que ninguém revisou.
 */
const EXPECTED_DUE_DAY = TX_DATE.getDate();
/**
 * Já `proximoVencimento` é estável em qualquer fuso: +1 mês sobre o mesmo
 * instante, com o mesmo dia local.
 */
const EXPECTED_NEXT_DUE = new Date("2026-08-10T00:00:00.000Z");

/** Tem o projeto CASA e o módulo dono do recurso (`recurringBills`). */
const authorizedRequester: RateioRequester = {
  role: "USER",
  allowedProjects: [PESSOAL, CASA_ALLOWED],
  allowedProjectTypes: ["PESSOAL", "CASA"],
  allowedModules: ["bankAccounts", "expenses", "recurringBills"],
};

/** Tem o módulo e o TIPO CASA, mas não o projeto CASA que existe no tenant. */
const noCasaProjectRequester: RateioRequester = {
  role: "USER",
  allowedProjects: [PESSOAL],
  allowedProjectTypes: ["PESSOAL", "CASA"],
  allowedModules: ["bankAccounts", "expenses", "recurringBills"],
};

/**
 * Alcança os projetos CASA (por `maintenance`/`expenses`, ambos módulos de
 * CASA) mas NÃO tem `recurringBills` — módulo não relacionado jamais libera o
 * recurso (#480 SEC-1).
 *
 * Duas lentes, porque só a primeira é alcançável de verdade: com tipos
 * explícitos no grant, `reconcileUserModules` back-filla TODOS os módulos do
 * tipo (inclusive `recurringBills`), então o shape realista de quem tem
 * `maintenance` e não tem `recurringBills` é o legado `allowedProjectTypes: []`.
 * A segunda lente fica como defesa em profundidade: o serviço não pode confiar
 * que a reconciliação rodou.
 */
const unrelatedModuleRequesters: Array<[string, RateioRequester]> = [
  [
    "legado sem grant de tipos",
    {
      role: "USER",
      allowedProjects: [PESSOAL, CASA_FIRST, CASA_ALLOWED],
      allowedProjectTypes: [],
      allowedModules: ["bankAccounts", "expenses", "maintenance"],
    },
  ],
  [
    "com grant de tipos explícito",
    {
      role: "USER",
      allowedProjects: [PESSOAL, CASA_FIRST, CASA_ALLOWED],
      allowedProjectTypes: ["PESSOAL", "CASA"],
      allowedModules: ["bankAccounts", "expenses", "maintenance"],
    },
  ],
];

const ownerRequester: RateioRequester = {
  role: "OWNER",
  allowedProjects: [],
  allowedProjectTypes: [],
  allowedModules: [],
};

function ofxTransaction(
  date: string,
  amountCents: number,
  memo: string,
  fitId: string,
): string {
  // Mesma convenção normalizada dos outros specs de banco: positivo é débito
  // de saída, e o OFX guarda o valor negativo.
  const ofxAmountCents = -amountCents;
  const sign = ofxAmountCents >= 0 ? "" : "-";
  const amount = Math.abs(ofxAmountCents / 100).toFixed(2);
  const type = amountCents >= 0 ? "DEBIT" : "CREDIT";
  return [
    "<STMTTRN>",
    `<TRNTYPE>${type}</TRNTYPE>`,
    `<DTPOSTED>${date}</DTPOSTED>`,
    `<TRNAMT>${sign}${amount}</TRNAMT>`,
    `<FITID>${fitId}</FITID>`,
    `<MEMO>${memo}</MEMO>`,
    "</STMTTRN>",
  ].join("");
}

function bankOfx(...transactions: string[]): Buffer {
  return Buffer.from(
    [
      "OFXHEADER:100",
      "DATA:OFXSGML",
      "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>",
      `<BANKACCTFROM><ACCTID>${BANK_LAST4}</ACCTID></BANKACCTFROM>`,
      "<BANKTRANLIST>",
      ...transactions,
      "</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>",
    ].join("\n"),
  );
}

function utilityStatement(fitId = "SEC481-ENEL"): Buffer {
  return bankOfx(
    ofxTransaction("20260710", UTILITY_CENTS, UTILITY_MERCHANT, fitId),
  );
}

async function createCasaProject(id: string, name: string): Promise<void> {
  await setup.project.create({
    data: { id, tenantId: TENANT, type: "CASA", name },
  });
}

async function cleanupTransient(): Promise<void> {
  await setup.rateioAllocation.deleteMany({ where: { tenantId: TENANT } });
  await setup.crossProjectSettlement.deleteMany({
    where: { tenantId: TENANT },
  });
  await setup.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
  await setup.expense.deleteMany({ where: { tenantId: TENANT } });
  await setup.receipt.deleteMany({ where: { tenantId: TENANT } });
  await setup.recurringBill.deleteMany({ where: { tenantId: TENANT } });
  await setup.bankStatementImport.deleteMany({ where: { tenantId: TENANT } });
  await setup.creditCardStatementImport.deleteMany({
    where: { tenantId: TENANT },
  });
  await setup.creditCard.deleteMany({ where: { tenantId: TENANT } });
  // Os projetos CASA são criados POR TESTE: a ordem de criação é parte do
  // cenário ("primeiro do tenant" × "acessível").
  await setup.project.deleteMany({
    where: { tenantId: TENANT, id: { not: PESSOAL } },
  });
}

async function cleanupAll(): Promise<void> {
  await cleanupTransient();
  await setup.bankAccount.deleteMany({ where: { tenantId: TENANT } });
  await setup.project.deleteMany({ where: { tenantId: TENANT } });
  await setup.tenant.deleteMany({ where: { id: TENANT } });
}

/** Todas as contas recorrentes do tenant, com TODOS os campos. */
function recurringBills() {
  return setup.recurringBill.findMany({
    where: { tenantId: TENANT },
    orderBy: { id: "asc" },
  });
}

/**
 * Estado financeiro do tenant FORA do projeto de origem da importação, mais a
 * tabela de contas recorrentes inteira.
 *
 * O import legítimo escreve no projeto de origem (despesa + caixa + registro do
 * lote) — comparar o tenant inteiro seria comparar contra o próprio trabalho do
 * usuário. O que precisa ficar byte-idêntico é tudo que está FORA do alcance
 * dele. Lido com PrismaClient cru (sem o middleware de soft-delete), então
 * linhas soft-deletadas também entram na comparação.
 */
async function foreignFinancialSnapshot() {
  const foreign = { tenantId: TENANT, projectId: { not: PESSOAL } };
  const [bills, expenses, receipts, entries, settlements, allocations] =
    await Promise.all([
      recurringBills(),
      setup.expense.findMany({ where: foreign, orderBy: { id: "asc" } }),
      setup.receipt.findMany({ where: foreign, orderBy: { id: "asc" } }),
      setup.cashFlowEntry.findMany({ where: foreign, orderBy: { id: "asc" } }),
      setup.crossProjectSettlement.findMany({
        where: { tenantId: TENANT },
        orderBy: { id: "asc" },
      }),
      setup.rateioAllocation.findMany({
        where: { tenantId: TENANT },
        orderBy: { id: "asc" },
      }),
    ]);
  return { bills, expenses, receipts, entries, settlements, allocations };
}

/** Conta recorrente pré-existente — o bug ATUALIZAVA esta linha, sem criar nada. */
async function seedExistingBill(projectId: string) {
  return setup.recurringBill.create({
    data: {
      id: "sec481-recurrence-existing-bill",
      tenantId: TENANT,
      projectId,
      nome: "Energia elétrica",
      valor: 9_900,
      categoria: "LUZ",
      frequencia: "MENSAL",
      diaVencimento: 5,
      status: "ATIVO",
      ultimoPagamento: SEEDED_AT,
      proximoVencimento: new Date("2026-06-05T00:00:00.000Z"),
      observacoes: "Conta pré-existente SENTINELA",
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
    },
  });
}

describe("BankAccountService.propagateRecurrences — ACL do projeto de destino (#481)", () => {
  let service: BankAccountService;

  function commit(requester: RateioRequester, statement = utilityStatement()) {
    return service.commitImport(
      TENANT,
      PESSOAL,
      ACCOUNT_ID,
      statement,
      "sec481-extrato.ofx",
      "OFX",
      "2026-07",
      undefined,
      undefined,
      CREATED_BY,
      requester,
    );
  }

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
    jest.setSystemTime(FIXED_CLOCK);

    await setup.$connect();
    await prisma.onModuleInit();
    await cleanupAll();
    await setup.tenant.create({
      data: { id: TENANT, name: "SEC-481 recurrence tenant" },
    });
    await setup.project.create({
      data: {
        id: PESSOAL,
        tenantId: TENANT,
        type: "PESSOAL",
        name: "Pessoal SEC-481",
      },
    });
    await setup.bankAccount.create({
      data: {
        id: ACCOUNT_ID,
        tenantId: TENANT,
        projectId: PESSOAL,
        institution: "ITAU",
        nickname: "Conta SEC-481",
        last4: BANK_LAST4,
      },
    });

    service = new BankAccountService(
      prisma,
      new MerchantClassifierService(prisma),
      new ConciliacaoService(prisma),
      new CardInvoiceSettlementService(prisma),
    );
  });

  afterEach(cleanupTransient);

  afterAll(async () => {
    await cleanupAll();
    await prisma.onModuleDestroy();
    await setup.$disconnect();
    jest.useRealTimers();
  });

  it("propaga a recorrência para o projeto CASA acessível quando o requisitante tem o módulo recurringBills", async () => {
    await createCasaProject(CASA_ALLOWED, "Casa acessível");

    const result = await commit(authorizedRequester);

    expect(result.inserted).toBe(1);
    expect(result.recurrencesCreated).toBe(1);
    expect(await recurringBills()).toEqual([
      {
        id: expect.any(String),
        tenantId: TENANT,
        projectId: CASA_ALLOWED,
        nome: "Energia elétrica",
        valor: UTILITY_CENTS,
        categoria: "LUZ",
        frequencia: "MENSAL",
        diaVencimento: EXPECTED_DUE_DAY,
        status: "ATIVO",
        ultimoPagamento: TX_DATE,
        proximoVencimento: EXPECTED_NEXT_DUE,
        observacoes: `Detectado automaticamente do extrato (${UTILITY_MERCHANT})`,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
        deletedAt: null,
      },
    ]);
  });

  it("não escreve nada quando o único projeto CASA do tenant está fora da ACL do requisitante", async () => {
    await createCasaProject(CASA_FIRST, "Casa fora da ACL SENTINELA");
    await seedExistingBill(CASA_FIRST);
    const before = await foreignFinancialSnapshot();

    const result = await commit(noCasaProjectRequester);

    // A importação em si continua funcionando no projeto de origem…
    expect(result.inserted).toBe(1);
    // …e nada vazou para o projeto inacessível: nem create, nem update.
    expect(result.recurrencesCreated).toBe(0);
    expect(await foreignFinancialSnapshot()).toEqual(before);
  });

  it.each(unrelatedModuleRequesters)(
    "não escreve nada quando o requisitante alcança o projeto CASA só por um módulo não relacionado (%s)",
    async (_lens, requester) => {
      await createCasaProject(CASA_FIRST, "Casa alcançada por maintenance");
      await createCasaProject(
        CASA_ALLOWED,
        "Casa também alcançada por maintenance",
      );
      await seedExistingBill(CASA_ALLOWED);
      const before = await foreignFinancialSnapshot();

      const result = await commit(requester);

      expect(result.inserted).toBe(1);
      expect(result.recurrencesCreated).toBe(0);
      expect(await foreignFinancialSnapshot()).toEqual(before);
    },
  );

  it("OWNER mantém o comportamento irrestrito no tenant", async () => {
    // O OWNER não tem escopo: cai no primeiro CASA do tenant, como sempre.
    await createCasaProject(CASA_FIRST, "Casa primeira do tenant");
    await createCasaProject(CASA_ALLOWED, "Casa seguinte");

    const result = await commit(ownerRequester);

    expect(result.recurrencesCreated).toBe(1);
    expect(await recurringBills()).toEqual([
      expect.objectContaining({
        projectId: CASA_FIRST,
        nome: "Energia elétrica",
        categoria: "LUZ",
        valor: UTILITY_CENTS,
        diaVencimento: EXPECTED_DUE_DAY,
        proximoVencimento: EXPECTED_NEXT_DUE,
        ultimoPagamento: TX_DATE,
      }),
    ]);
  });

  it("escolhe o projeto CASA ACESSÍVEL, não o primeiro do tenant, quando existem dois", async () => {
    await createCasaProject(CASA_FIRST, "Casa fora da ACL SENTINELA");
    await createCasaProject(CASA_ALLOWED, "Casa acessível");

    const result = await commit(authorizedRequester);

    expect(result.recurrencesCreated).toBe(1);
    expect(await recurringBills()).toEqual([
      expect.objectContaining({
        projectId: CASA_ALLOWED,
        nome: "Energia elétrica",
        categoria: "LUZ",
        valor: UTILITY_CENTS,
      }),
    ]);
  });

  it("escopa CASA e CARRO de forma independente: IPVA em projeto CARRO fora da ACL não escreve", async () => {
    await createCasaProject(CASA_ALLOWED, "Casa acessível");
    await setup.project.create({
      data: {
        id: CARRO_HIDDEN,
        tenantId: TENANT,
        type: "CARRO",
        name: "Carro fora da ACL SENTINELA",
      },
    });

    const result = await commit(
      authorizedRequester,
      bankOfx(
        ofxTransaction(
          "20260710",
          UTILITY_CENTS,
          UTILITY_MERCHANT,
          "SEC481-ENEL",
        ),
        ofxTransaction("20260710", 80_000, VEHICLE_TAX_MERCHANT, "SEC481-IPVA"),
      ),
    );

    // A recorrência de CASA nasce; a de CARRO (IPVA) não tem destino autorizado.
    expect(result.recurrencesCreated).toBe(1);
    expect(await recurringBills()).toEqual([
      expect.objectContaining({
        projectId: CASA_ALLOWED,
        categoria: "LUZ",
      }),
    ]);
  });
});
