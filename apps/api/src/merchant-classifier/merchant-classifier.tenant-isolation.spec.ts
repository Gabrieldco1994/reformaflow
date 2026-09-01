import { INestApplication } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { MerchantClassifierController } from "./merchant-classifier.controller";
import { MerchantClassifierService } from "./merchant-classifier.service";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Regressão #589 — isolamento de tenant no MerchantClassifierController.
 *
 * Este spec roda contra o Prisma REAL e sobe um servidor HTTP REAL de propósito.
 * Mockar o PrismaService esconderia o bug: o dano depende de como o Prisma trata
 * `undefined` em cada posição do `where` (dropado no topo, mas não dentro de um
 * `OR`), e um mock que replica a lógica do serviço ficaria verde com o bug.
 *
 * Caminho exercitado ponta a ponta: request sem tenant → controller →
 * `@CurrentTenant()` → query real no banco → resposta.
 */
const TENANTS = ["tenant-a-589", "tenant-b-589", "tenant-c-589"] as const;
const MERCHANT_RAW = "Padaria Sigilosa do Tenant A";
const MERCHANT_KEY = MerchantClassifierService.normalizeKey(MERCHANT_RAW);

describe("MerchantClassifier — isolamento de tenant (#589)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [MerchantClassifierController],
      providers: [MerchantClassifierService, PrismaService],
    }).compile();

    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    await app.init();
    // porta efêmera: não conflita com a API de dev na 3001
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await prisma.merchantCategory.deleteMany({
      where: { merchantKey: MERCHANT_KEY },
    });
    await app?.close();
  });

  beforeEach(async () => {
    await prisma.merchantCategory.deleteMany({
      where: { merchantKey: MERCHANT_KEY },
    });
    // Três tenants distintos com uma regra manual para a MESMA chave normalizada.
    for (const tenantId of TENANTS) {
      await prisma.merchantCategory.create({
        data: {
          tenantId,
          merchantKey: MERCHANT_KEY,
          merchantSample: `${MERCHANT_RAW} (${tenantId})`,
          category: "alimentação",
          subcategory: "padaria",
          source: "MANUAL",
          confidence: 1,
        },
      });
    }
  });

  const survivingTenants = async () => {
    const rows = await prisma.merchantCategory.findMany({
      where: { merchantKey: MERCHANT_KEY },
      orderBy: { tenantId: "asc" },
    });
    return rows.map((r) => r.tenantId);
  };

  /**
   * O dano mais grave da issue: `removeManual` põe `tenantId` no TOPO do
   * `deleteMany`, e ali o Prisma DESCARTA `undefined` — o filtro de tenant
   * simplesmente some e a query vira "apague essa chave de todo mundo".
   * Uma request sem tenant destrói a regra de todos os tenants.
   */
  it("remove-rule sem tenant não pode apagar a regra dos outros tenants", async () => {
    expect(await survivingTenants()).toEqual([...TENANTS]);

    const res = await fetch(`${baseUrl}/merchant-categories/remove-rule`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchant: MERCHANT_RAW }),
    });

    // invariante central primeiro: o dano é a perda de dados, não o status.
    // Asserir o status antes mascararia a destruição cross-tenant no relatório.
    expect(await survivingTenants()).toEqual([...TENANTS]);
    expect(res.status).toBe(401);
  });

  it("GET /merchant-categories sem tenant é rejeitado", async () => {
    const res = await fetch(`${baseUrl}/merchant-categories`);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(MERCHANT_KEY);
  });

  it("POST /merchant-categories/classify sem tenant é rejeitado", async () => {
    const res = await fetch(`${baseUrl}/merchant-categories/classify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchants: [MERCHANT_RAW] }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /merchant-categories/suggest sem tenant é rejeitado", async () => {
    const res = await fetch(`${baseUrl}/merchant-categories/suggest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: MERCHANT_RAW }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /merchant-categories/override sem tenant é rejeitado e não escreve", async () => {
    const res = await fetch(`${baseUrl}/merchant-categories/override`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchant: MERCHANT_RAW, category: "saúde" }),
    });

    expect(res.status).toBe(401);
    // nenhuma regra global órfã (tenantId null) criada por request sem tenant
    const orphans = await prisma.merchantCategory.findMany({
      where: { merchantKey: MERCHANT_KEY, tenantId: null },
    });
    expect(orphans).toHaveLength(0);
    expect(await survivingTenants()).toEqual([...TENANTS]);
  });

  it("header x-tenant-id sozinho não autentica tenant (sem JWT/override)", async () => {
    const res = await fetch(`${baseUrl}/merchant-categories`, {
      headers: { "x-tenant-id": TENANTS[1] },
    });
    expect(res.status).toBe(401);
  });
});

describe('classifyBatch — SEC-3 preserva MANUAL sob corrida real (#582 TOCTOU)', () => {
  const RACY_RAW = 'Fornecedor Corrida 582';
  const RACY_KEY = MerchantClassifierService.normalizeKey(RACY_RAW);
  const A = 'tenant-a-589';
  const B = 'tenant-b-589';
  const C = 'tenant-c-589';

  let prisma: PrismaService;
  let svc: MerchantClassifierService;
  let prevKey: string | undefined;

  beforeAll(async () => {
    prevKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'test-key-582';
    const moduleRef = await Test.createTestingModule({
      providers: [MerchantClassifierService, PrismaService],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    svc = moduleRef.get(MerchantClassifierService);
  });

  afterAll(async () => {
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
    await prisma.merchantCategory.deleteMany({ where: { merchantKey: { in: [RACY_KEY] } } });
    await (prisma as any).$disconnect?.();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await prisma.merchantCategory.deleteMany({ where: { merchantKey: RACY_KEY } });
  });

  it('regra MANUAL de A criada DURANTE a chamada do Gemini sobrevive (não vira AI)', async () => {
    let enteredGemini!: () => void;
    let releaseGemini!: () => void;
    const entered = new Promise<void>((r) => (enteredGemini = r));
    const gate = new Promise<void>((r) => (releaseGemini = r));
    jest.spyOn(svc as any, 'callGemini').mockImplementation(async () => {
      enteredGemini();
      await gate;
      return [{ merchant: RACY_RAW, category: 'transporte', subcategory: null, confidence: 0.95 }];
    });

    const classifyP = svc.classifyBatch([RACY_RAW], A);
    await entered;
    await svc.setManual(RACY_RAW, 'alimentação', null, A);
    releaseGemini();
    await classifyP;

    const row = await prisma.merchantCategory.findUnique({
      where: { tenantId_merchantKey: { tenantId: A, merchantKey: RACY_KEY } },
    });
    expect(row).toBeTruthy();
    expect(row!.source).toBe('MANUAL');
    expect(row!.category).toBe('alimentação');
    expect(row!.confidence).toBe(1);
  });

  it('classifyBatch de B não cria nem edita nenhuma linha MANUAL de A/C nem a global', async () => {
    for (const t of [A, C]) {
      await prisma.merchantCategory.create({
        data: { tenantId: t, merchantKey: RACY_KEY, merchantSample: RACY_RAW, category: 'alimentação', subcategory: null, source: 'MANUAL', confidence: 1 },
      });
    }
    await prisma.merchantCategory.create({
      data: { tenantId: null, merchantKey: RACY_KEY, merchantSample: RACY_RAW, category: 'saúde', subcategory: null, source: 'MANUAL', confidence: 1 },
    });
    jest.spyOn(svc as any, 'callGemini').mockResolvedValue([
      { merchant: RACY_RAW, category: 'transporte', subcategory: null, confidence: 0.99 },
    ]);

    await svc.classifyBatch([RACY_RAW], B);

    const rows = await prisma.merchantCategory.findMany({ where: { merchantKey: RACY_KEY }, orderBy: { tenantId: 'asc' } });
    const byT = new Map(rows.map((r) => [r.tenantId ?? '__global__', r]));
    expect(byT.get(A)).toMatchObject({ source: 'MANUAL', category: 'alimentação' });
    expect(byT.get(C)).toMatchObject({ source: 'MANUAL', category: 'alimentação' });
    expect(byT.get('__global__')).toMatchObject({ source: 'MANUAL', category: 'saúde' });
    if (byT.get(B)) expect(byT.get(B)).toMatchObject({ tenantId: B, source: 'AI' });
  });

  it('classifyBatch(["x"], "") lança BadRequestException e não escreve (classe do #589)', async () => {
    await expect(svc.classifyBatch(['x'], '')).rejects.toThrow();
    const rows = await prisma.merchantCategory.findMany({ where: { merchantKey: MerchantClassifierService.normalizeKey('x') } });
    expect(rows).toHaveLength(0);
  });
});
