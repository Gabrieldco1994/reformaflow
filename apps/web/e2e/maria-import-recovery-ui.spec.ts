import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  FIXTURE_INSTANT,
  receiptFixture,
  summaryFixture,
  viewFixture,
} from "../src/app/projects/[projectId]/maria/_lib/import-session-fixtures";

/**
 * Contrato de UI (componente real + API stubada — NÃO é QA de backend nem da jornada
 * real) da retomada de importações na página Maria: alvos ≥44×44, hit-test com o widget
 * financeiro presente/aberto, valores −6 dígitos nowrap, sem overflow, erro offline
 * visível e duplo toque do cancelamento enviando UMA requisição.
 */

const projectId = "maria-import-recovery";
const SHOT_DIR = "test-results/maria-import-recovery";
const WIDTHS = [375, 390, 900, 1280] as const;
const RECOVERY_GEOMETRY_VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
] as const;

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const active = summaryFixture({
  id: "sess-a",
  cardId: "card-qa",
  ownerProjectId: projectId,
});
const applied = summaryFixture({
  id: "sess-9",
  state: "APPLIED",
  cardId: "card-qa",
  ownerProjectId: projectId,
  appliedAt: "2026-09-20T02:30:00.000Z",
  actions: ["READ_RESULT"],
});

const DUE_MONTH = "2026-09";
const monthRow = {
  mes: DUE_MONTH,
  totalDespesas: 0,
  totalRecebimentos: 0,
  despesasRealizadas: 0,
  recebimentosRealizados: 0,
  saldoMes: 0,
  saldoMesRealizado: 0,
  porOrigem: {},
  porCategoria: [],
};
// Só o necessário para o corpo do chat (cockpit) montar: a retomada não lê este endpoint.
const monthlyOverview = {
  mesAtual: DUE_MONTH,
  meses: [monthRow],
  comparativo: {
    current: monthRow,
    previous: null,
    deltaDespesas: 0,
    deltaDespesasPct: null,
    deltaRecebimentos: 0,
    deltaRecebimentosPct: null,
    deltaSaldo: 0,
  },
  mesAtualEntries: [],
  entries: [],
  projetos: [{ id: projectId, name: "Pessoal QA", type: "PESSOAL" }],
  cards: [],
  caixa: {
    hoje: 0,
    saldoInicial: 0,
    temSaldoInicial: true,
    porMes: [{ mes: DUE_MONTH, caixa: 0 }],
  },
  projecao: {
    caixaHoje: 0,
    entrouMes: 0,
    saiuMes: 0,
    faltaPagarMes: 0,
    recebimentosPrevistosMes: 0,
    sobraPrevista: 0,
  },
};

// Recibo COERENTE (soma dos destinos = total; faturas = soma das ocorrências por ciclo), como a API aceitaria.
// Linha B reproduz o caso P01: data nominal 14/07 com ciclo explícito 11/2026 e valores assimétricos 100/60.
function coherentReceipt(longSchedule = false) {
  const base = receiptFixture();
  const occurrencesB = [
    {
      index: 0,
      parcela: "2/3",
      valor: 10_000,
      data: "2026-07-14",
      invoiceDueMonth: "2026-11",
    },
    {
      index: 1,
      parcela: "3/3",
      valor: 6_000,
      data: "2026-08-14",
      invoiceDueMonth: "2026-12",
    },
  ];
  const long = Array.from({ length: 24 }, (_, index) => ({
    index,
    parcela: `${index + 1}/24`,
    valor: 1_000,
    data: `2026-${String((index % 12) + 1).padStart(2, "0")}-14`,
    invoiceDueMonth: null,
  }));
  const lineA = {
    ...base.snapshot.lines[0],
    targets: [
      { projectId: projectId, amountCents: 10_000_000 },
      { projectId: "proj-outro", amountCents: 2_345_678 },
    ],
  };
  const lineB = {
    ...base.snapshot.lines[0],
    lineId: "line-b",
    titulo: "Ar-condicionado",
    totalCents: 16_000,
    targets: [],
    schedule: {
      version: 1 as const,
      occurrences: longSchedule ? long : occurrencesB,
    },
  };
  const lineBTotal = longSchedule ? 24_000 : 16_000;
  lineB.totalCents = lineBTotal;
  const kept = base.snapshot.lines[1];
  const deltas = longSchedule
    ? [
        { invoiceDueMonth: "2026-10", amountCents: 6_172_839 },
        { invoiceDueMonth: "2026-11", amountCents: 6_172_839 },
      ]
    : [
        { invoiceDueMonth: "2026-10", amountCents: 6_172_839 },
        { invoiceDueMonth: "2026-11", amountCents: 6_182_839 },
        { invoiceDueMonth: "2026-12", amountCents: 6_000 },
      ];
  return receiptFixture({
    items: [
      base.items[0],
      { ...base.items[0], lineId: "line-b", sourceExpenseId: "exp-b" },
      base.items[1],
    ],
    snapshot: {
      ...base.snapshot,
      lines: [lineA, lineB, kept],
      participantProjectIds: [projectId, "proj-outro"],
      createdEconomicTotalCents: 12_345_678 + (longSchedule ? 0 : lineBTotal),
      invoiceDeltas: deltas,
    },
  });
}

type Stub = {
  cancelRequests: string[];
  cancelDelayMs?: number;
  offline?: boolean;
  longSchedule?: boolean;
};

async function mockApi(page: Page, stub: Stub) {
  await page.clock.setFixedTime(new Date(FIXTURE_INSTANT));
  await page.context().addCookies([
    {
      name: "rf_token",
      value: "maria-import-recovery",
      url: `http://localhost:${process.env.PLAYWRIGHT_PORT ?? 3013}`,
    },
  ]);
  await page.route("http://localhost:3001/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    if (path === "/auth/me")
      return route.fulfill(
        json({
          id: "maria-import-user",
          username: "maria-import",
          name: "QA Importação",
          role: "ADMIN",
          tenantId: "maria-import-tenant",
          allowedModules: [],
          allowedProjects: [],
          allowedProjectTypes: [],
        }),
      );
    if (path === "/auth/config")
      return route.fulfill(
        json({ registerEnabled: false, guestEnabled: false }),
      );
    if (path === "/projects")
      return route.fulfill(
        json([{ id: projectId, name: "Pessoal QA", type: "PESSOAL" }]),
      );
    if (path === `/projects/${projectId}`)
      return route.fulfill(
        json({
          id: projectId,
          name: "Pessoal QA",
          type: "PESSOAL",
          onboardedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    if (path === `/projects/${projectId}/monthly-overview`)
      return route.fulfill(json(monthlyOverview));
    if (path === "/tenant/credit-cards")
      return route.fulfill(
        json([
          {
            id: "card-qa",
            nickname: "Cartão QA",
            last4: "9911",
            project: { id: projectId, name: "Pessoal QA" },
          },
        ]),
      );
    // page.route responde antes da rede: simular offline exige abortar a requisição.
    if (stub.offline && path.startsWith("/import-sessions"))
      return route.abort("internetdisconnected");
    if (path === "/import-sessions") {
      const state = url.searchParams.get("state");
      return route.fulfill(
        json({
          items: state === "applied" ? [applied] : [active],
          nextCursor: null,
          entry: { kind: "CARD_INVOICE", formats: ["CSV"] },
        }),
      );
    }
    if (path === "/import-sessions/sess-a" && req.method() === "GET")
      return route.fulfill(
        json(
          viewFixture({
            id: "sess-a",
            ownerProjectId: projectId,
            cardId: "card-qa",
          }),
        ),
      );
    if (path === "/import-sessions/sess-a/cancel" && req.method() === "POST") {
      stub.cancelRequests.push(req.postData() ?? "");
      if (stub.cancelDelayMs)
        await new Promise((r) => setTimeout(r, stub.cancelDelayMs));
      return route.fulfill(
        json(
          viewFixture({
            id: "sess-a",
            state: "CANCELLED",
            revision: 4,
            actions: [],
          }),
        ),
      );
    }
    if (path === "/import-sessions/sess-9/result")
      return route.fulfill(
        json({ state: "APPLIED", receipt: coherentReceipt(stub.longSchedule) }),
      );
    if (path === "/import-sessions/sess-9")
      return route.fulfill(
        json(
          viewFixture({
            id: "sess-9",
            state: "APPLIED",
            actions: ["READ_RESULT"],
          }),
        ),
      );
    return route.fulfill(json([]));
  });
}

async function boxOf(locator: Locator) {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = (x: number, y: number) => {
      const h = document.elementFromPoint(x, y);
      return h === el || (h != null && el.contains(h));
    };
    return {
      width: r.width,
      height: r.height,
      right: r.right,
      hitCenter: hit(r.left + r.width / 2, r.top + r.height / 2),
      hitCorner: hit(r.left + 8, r.top + 8),
    };
  });
}

async function expectTarget(locator: Locator, label: string) {
  await locator.scrollIntoViewIfNeeded();
  await expect
    .poll(async () => (await boxOf(locator)).hitCenter, {
      timeout: 5_000,
      message: `${label}: hit-test`,
    })
    .toBe(true);
  const box = await boxOf(locator);
  expect(box.width, `${label}: largura`).toBeGreaterThanOrEqual(44);
  expect(box.height, `${label}: altura`).toBeGreaterThanOrEqual(44);
  expect(box.hitCorner, `${label}: quina (8px, dentro do raio) coberta`).toBe(
    true,
  );
  return box;
}

async function noOverflow(page: Page, label: string) {
  const o = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(o.scrollWidth, `${label}: overflow horizontal`).toBeLessThanOrEqual(
    o.innerWidth,
  );
}

async function recoveryGeometry(page: Page) {
  return page.evaluate(() => {
    const result = Array.from(document.querySelectorAll("button")).find(
      (element) => element.textContent?.trim() === "Importações da Maria",
    );
    const card = Array.from(document.querySelectorAll("label")).find(
      (element) => element.textContent?.includes("Cartão da fatura"),
    );
    const conversation = document.querySelector(
      '[role="region"][aria-label="Conversa com Maria"]',
    );
    const dock = document.querySelector(".pessoal-minimal-maria-dock");
    if (!(result instanceof HTMLElement))
      throw new Error("Recovery button is missing");
    if (!(card instanceof HTMLElement))
      throw new Error("Authoritative card-invoice intake is missing");
    if (!(dock instanceof HTMLElement))
      throw new Error("Maria dock is missing");
    const rect = (element: Element) => {
      const value = element.getBoundingClientRect();
      return {
        left: value.left,
        top: value.top,
        right: value.right,
        bottom: value.bottom,
        width: value.width,
        height: value.height,
      };
    };
    const resultRect = result.getBoundingClientRect();
    const center = {
      x: resultRect.left + resultRect.width / 2,
      y: resultRect.top + resultRect.height / 2,
    };
    const hit = document.elementFromPoint(center.x, center.y);
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      result: {
        rect: rect(result),
        center,
        centerClickable:
          hit === result || (hit instanceof Node && result.contains(hit)),
        hit: hit
          ? {
              tag: hit.tagName,
              classes: hit instanceof HTMLElement ? hit.className : undefined,
              text: hit.textContent?.trim() ?? "",
            }
          : null,
      },
      card: {
        rect: rect(card),
        insideConversation: conversation?.contains(card) ?? false,
        insideDock: dock.contains(card),
      },
      conversationPresent: conversation !== null,
      dock: rect(dock),
      overflow: {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      },
    };
  });
}

async function openPanel(page: Page) {
  await page.goto(`/projects/${projectId}/maria`);
  const entry = page.getByRole("button", { name: "Importações da Maria" });
  await expect(entry).toBeVisible();
  return entry;
}

for (const viewport of RECOVERY_GEOMETRY_VIEWPORTS) {
  test.describe(`Retomada de importações da Maria — geometria ${viewport.width}x${viewport.height}`, () => {
    test.beforeEach(({}, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "medição roda uma vez só");
    });
    test.use({ viewport });

    test("entrada autoritativa fica na conversa, separada do dock e clicável", async ({
      page,
    }, testInfo) => {
      await mockApi(page, { cancelRequests: [] });
      await openPanel(page);
      await expect(page.getByLabel("Cartão da fatura")).toBeVisible();

      const geometry = await recoveryGeometry(page);
      await testInfo.attach(
        `maria-import-recovery-geometry-${viewport.width}x${viewport.height}.json`,
        {
          body: Buffer.from(JSON.stringify(geometry, null, 2)),
          contentType: "application/json",
        },
      );

      expect
        .soft(
          geometry.card.insideConversation,
          "Cartão da fatura deve estar dentro da região Conversa com Maria",
        )
        .toBe(true);
      expect
        .soft(
          geometry.card.insideDock,
          "Cartão da fatura deve ficar fora de .pessoal-minimal-maria-dock",
        )
        .toBe(false);
      expect
        .soft(
          geometry.result.centerClickable,
          "Importações da Maria deve aceitar clique no centro",
        )
        .toBe(true);
      expect
        .soft(
          geometry.dock.top,
          "dock deve começar depois do botão de resultado",
        )
        .toBeGreaterThanOrEqual(geometry.result.rect.bottom);
      expect
        .soft(geometry.dock.height, "dock deve ter no máximo 220px")
        .toBeLessThanOrEqual(220);
      expect
        .soft(
          geometry.overflow.scrollWidth,
          "geometria de retomada não deve ter overflow horizontal",
        )
        .toBeLessThanOrEqual(geometry.overflow.innerWidth);
    });
  });
}

for (const width of WIDTHS) {
  test.describe(`Retomada de importações da Maria @${width}px`, () => {
    test.beforeEach(({}, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "medição roda uma vez só");
    });
    test.use({ viewport: { width, height: 900 } });

    test("alvos ≥44×44 sem cobertura, cancelar com um único request, comprovante com −6 dígitos nowrap", async ({
      page,
    }, testInfo) => {
      const stub: Stub = { cancelRequests: [], cancelDelayMs: 400 };
      await mockApi(page, stub);
      const entry = await openPanel(page);
      const metrics: Record<string, unknown> = { width };

      // O widget financeiro (md+) aberto por baixo não pode cobrir os CTAs do modal.
      const fab = page.getByRole("button", {
        name: "Abrir Copiloto Financeiro",
      });
      const widgetPresent = (await fab.count()) > 0 && (await fab.isVisible());
      metrics.widgetPresent = widgetPresent;
      if (widgetPresent) await fab.click();

      metrics.entry = await expectTarget(entry, "entrada Importações da Maria");
      await entry.click();
      const dialog = page.getByRole("dialog", { name: "Importações da Maria" });
      await expect(dialog).toBeVisible();
      // Cantos do diálogo (onde o painel do widget, z-50, sobreporia) devem pertencer ao diálogo.
      // O sheet anima a entrada: espera estabilizar em vez de medir no meio do slide.
      const corners = () =>
        dialog.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const owns = (x: number, y: number) => {
            const h = document.elementFromPoint(x, y);
            return h != null && el.contains(h);
          };
          return {
            bottomRight: owns(r.right - 12, r.bottom - 12),
            topRight: owns(r.right - 12, r.top + 12),
            bottom: r.bottom,
          };
        });
      await expect
        .poll(
          async () => {
            const c = await corners();
            return c.bottomRight && c.topRight;
          },
          {
            timeout: 5_000,
            message: "canto do diálogo coberto (widget z-50 sobre o modal?)",
          },
        )
        .toBe(true);
      metrics.dialogCorners = await corners();

      const row = page.getByTestId("import-session-row").first();
      await expect(row).toContainText("Cartão QA");
      metrics.row = await expectTarget(row, "linha da lista");
      await noOverflow(page, "lista");
      await page.screenshot({ path: `${SHOT_DIR}/${width}-lista.png` });

      await row.click();
      const cancel = page.getByRole("button", { name: "Cancelar importação" });
      metrics.cancel = await expectTarget(cancel, "Cancelar importação");
      await cancel.click();
      const confirm = page.getByRole("button", { name: "Sim, cancelar" });
      metrics.confirm = await expectTarget(confirm, "Sim, cancelar");
      await expectTarget(
        page.getByRole("button", { name: "Manter importação" }),
        "Manter importação",
      );
      await confirm.dblclick();
      await expect(page.getByText("Importação cancelada.")).toBeVisible();
      expect(
        stub.cancelRequests,
        "duplo toque deve enviar uma requisição",
      ).toHaveLength(1);
      expect(JSON.parse(stub.cancelRequests[0])).toEqual({
        expectedRevision: 3,
      });

      await page.getByRole("button", { name: "Voltar" }).first().click();
      await page.getByRole("tab", { name: "Concluídas" }).click();
      await page.getByTestId("import-session-row").first().click();
      const receipt = page.getByTestId("import-receipt");
      await expect(receipt).toBeVisible();
      metrics.receipt = await receipt.evaluate(
        (el) => el.getBoundingClientRect().width,
      );

      const bigMoney = receipt.getByText("R$ 123.456,78").first();
      const occurrenceMoney = receipt
        .getByTestId("receipt-occurrence")
        .getByText("R$ 61.728,39")
        .first();
      for (const [label, money] of [
        ["total 6 dígitos", bigMoney],
        ["parcela 6 dígitos", occurrenceMoney],
      ] as const) {
        await expect(money).toBeVisible();
        const style = await money.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return {
            whiteSpace: getComputedStyle(el).whiteSpace,
            height: r.height,
            lineHeight: parseFloat(getComputedStyle(el).lineHeight) || 0,
            right: r.right,
          };
        });
        expect(style.whiteSpace, `valor ${label} deve ser nowrap`).toBe(
          "nowrap",
        );
        expect(
          style.height,
          `valor ${label} quebrou em duas linhas`,
        ).toBeLessThan(style.lineHeight * 1.6 + 1);
        expect(
          style.right,
          `valor ${label} vaza da viewport`,
        ).toBeLessThanOrEqual(width);
      }
      // Caso P01: data nominal e ciclo explícito ficam separados; nada vira "vencimento".
      const exceptional = receipt
        .getByTestId("receipt-occurrence")
        .filter({ hasText: "Parcela 2/3" });
      await expect(exceptional).toContainText("14/07/2026");
      await expect(exceptional).toContainText("Fatura 11/2026");
      await expect(exceptional).toContainText("R$ 100,00");
      await expect(
        receipt
          .getByTestId("receipt-occurrence")
          .filter({ hasText: "Parcela 3/3" }),
      ).toContainText("R$ 60,00");
      await expect(receipt.getByText(/Primeira parcela em/)).toHaveCount(0);
      await noOverflow(page, "comprovante");
      await page.screenshot({ path: `${SHOT_DIR}/${width}-comprovante.png` });

      testInfo.annotations.push({
        type: "metrics",
        description: JSON.stringify(metrics),
      });
      // eslint-disable-next-line no-console
      console.log(`[maria-import-recovery] ${JSON.stringify(metrics)}`);
    });
  });
}

test.describe("Retomada de importações da Maria — offline", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "medição roda uma vez só");
  });
  test.use({ viewport: { width: 390, height: 844 } });

  test("erro de rede é visível com nova tentativa, sem virar lista vazia", async ({
    page,
  }) => {
    const stub: Stub = { cancelRequests: [], offline: true };
    await mockApi(page, stub);
    const entry = await openPanel(page);
    await entry.click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByText("Nenhuma importação para retomar")).toHaveCount(
      0,
    );
    const retry = page.getByRole("button", { name: "Tentar de novo" });
    await expectTarget(retry, "Tentar de novo");
    stub.offline = false;
    await retry.click();
    await expect(page.getByTestId("import-session-row").first()).toBeVisible();
  });
});

test.describe("Retomada de importações da Maria — cronograma longo (24 lançamentos)", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "medição roda uma vez só");
  });
  for (const width of [375, 1280] as const) {
    test.describe(`@${width}px`, () => {
      test.use({ viewport: { width, height: 900 } });
      test("dobra em <details> com summary ≥44px e mostra as 24 ocorrências sem overflow", async ({
        page,
      }) => {
        await mockApi(page, { cancelRequests: [], longSchedule: true });
        const entry = await openPanel(page);
        await entry.click();
        await page.getByRole("tab", { name: "Concluídas" }).click();
        await page.getByTestId("import-session-row").first().click();
        const long = page
          .getByTestId("receipt-line")
          .filter({ hasText: "Ar-condicionado" });
        const summary = long.locator("summary");
        await expect(summary).toContainText("24 lançamentos");
        await expectTarget(summary, "summary do cronograma");
        await expect(
          long.getByTestId("receipt-occurrence").first(),
        ).toBeHidden();
        await summary.click();
        await expect(long.getByTestId("receipt-occurrence")).toHaveCount(24);
        await expect(
          long.getByTestId("receipt-occurrence").last(),
        ).toContainText("Parcela 24/24");
        await long
          .getByTestId("receipt-occurrence")
          .last()
          .scrollIntoViewIfNeeded();
        await expect(
          long.getByTestId("receipt-occurrence").last(),
        ).toBeVisible();
        await noOverflow(page, "cronograma longo");
        await page.screenshot({
          path: `${SHOT_DIR}/${width}-cronograma-longo.png`,
        });
      });
    });
  }
});
