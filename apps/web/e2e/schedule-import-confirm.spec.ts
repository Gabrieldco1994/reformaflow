import { expect, test, type Page } from '@playwright/test';

/**
 * #607 — "Importar Modelo de Obra" faz hard-delete das etapas/tarefas do
 * cronograma antes de criar o modelo. O modal precisa, quando JÁ HÁ
 * cronograma: avisar da substituição, mostrar as contagens e exigir uma
 * confirmação explícita (2º passo, botão destrutivo). Sem cronograma o fluxo
 * atual é inalterado.
 *
 * #647 — a entrada do modal com cronograma existente vivia SÓ no header desktop
 * (`hidden md:flex`); em 375/390px o usuário com cronograma ficava sem ponto de
 * entrada. O header mobile editorial (`div.md:hidden`) passa a expor "Importar"
 * quando `hasData`, abrindo o MESMO `ImportModal`. O bloco `#647` abaixo cobre
 * os viewports mobile; o bloco `#607` segue rodando só no desktop.
 *
 * API mockada via `page.route` (mesmo padrão de `u4-nav-redirect.spec.ts` /
 * `rateio-detalhe.spec.ts`) — nenhum backend real necessário.
 */

const PROJECT_ID = 'schedule-607';
const MODAL = 'div.fixed.inset-0.z-50';

function json(body: unknown) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) };
}

const CONFIG = {
  id: 'cfg-1',
  dataInicio: '2026-01-06T12:00:00.000Z',
  trabalhaDiasUteis: true,
  trabalhaSabados: false,
};

const KPIS = {
  totalOrcado: 0,
  totalReal: 0,
  totalDesvio: 0,
  percentualTotal: 0,
  terminoPrevisto: null,
};

function task(id: string, numero: number, nome: string) {
  return {
    id,
    stageId: 'stage-pintura',
    numero,
    nome,
    duracao: 3,
    dataInicio: '2026-01-06T12:00:00.000Z',
    dataTermino: '2026-01-09T12:00:00.000Z',
    predecessoras: null,
    valorOrcado: null,
    custoReal: null,
    percentualConcluido: 0,
    ordem: numero,
  };
}

/** Cronograma manual: 1 etapa, 2 tarefas. */
const GANTT_WITH_SCHEDULE = {
  config: CONFIG,
  holidays: [],
  kpis: KPIS,
  stages: [
    {
      id: 'stage-pintura',
      nome: 'PINTURA MANUAL',
      ordem: 1,
      tasks: [
        task('task-1', 1, 'Textura cimento queimado'),
        task('task-2', 2, 'Massa corrida no teto'),
      ],
    },
  ],
};

const GANTT_EMPTY = {
  config: CONFIG,
  holidays: [],
  kpis: KPIS,
  stages: [],
};

async function mockApi(
  page: Page,
  baseURL: string,
  gantt: unknown,
  importPosts: string[],
) {
  await page.clock.setFixedTime(new Date('2026-02-10T12:00:00.000Z'));
  await page.context().addCookies([{ name: 'rf_token', value: 'schedule-607', url: baseURL }]);
  await page.route('http://localhost:3001/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (request.method() === 'POST' && path === `/projects/${PROJECT_ID}/schedule/import`) {
      importPosts.push(request.postData() ?? '');
      return route.fulfill(json({ ok: true }));
    }

    if (path === '/auth/me') {
      return route.fulfill(
        json({
          id: 'u-607',
          username: 'schedule-607',
          name: 'QA 607',
          role: 'ADMIN',
          isGuest: false,
          tenantId: 't-607',
          allowedModules: ['dashboard', 'schedule'],
          allowedProjects: [PROJECT_ID],
          allowedProjectTypes: ['REFORMA'],
        }),
      );
    }
    if (path === '/auth/config') {
      return route.fulfill(json({ registerEnabled: false, guestEnabled: false }));
    }
    if (path === '/projects') {
      return route.fulfill(json([{ id: PROJECT_ID, name: 'Reforma 607', type: 'REFORMA' }]));
    }
    if (path === `/projects/${PROJECT_ID}`) {
      return route.fulfill(
        json({
          id: PROJECT_ID,
          name: 'Reforma 607',
          type: 'REFORMA',
          onboardedAt: '2026-01-01T00:00:00.000Z',
        }),
      );
    }
    if (path === `/projects/${PROJECT_ID}/schedule/gantt`) {
      return route.fulfill(json(gantt));
    }
    return route.fulfill(json([]));
  });
}

test.describe('#607 — confirmação antes da importação destrutiva de cronograma', () => {
  test('COM cronograma: avisa, mostra contagens, "Cancelar" não importa; reabrir e confirmar importa', async ({
    page,
    baseURL,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'entrada de import com cronograma existente só existe no header desktop',
    );
    const importPosts: string[] = [];
    await mockApi(page, baseURL!, GANTT_WITH_SCHEDULE, importPosts);
    await page.goto(`/projects/${PROJECT_ID}/schedule`);

    // etapa manual visível no gantt desktop (a lista mobile é md:hidden)
    await expect(page.getByText('PINTURA MANUAL').first()).toBeVisible();

    // 1) abre o modal
    await page.getByRole('button', { name: 'Importar', exact: true }).click();
    const modal = page.locator(MODAL);
    await expect(modal.getByRole('heading', { name: 'Importar Cronograma' })).toBeVisible();

    // aviso de substituição + contagens do estado carregado (1 etapa, 2 tarefas)
    await expect(modal.getByText('Isto vai substituir o cronograma atual.')).toBeVisible();
    await expect(modal.getByText(/1 etapa e 2 tarefas/)).toBeVisible();
    // o passo 1 não expõe o botão de importação atual
    await expect(
      modal.getByRole('button', { name: 'Importar Modelo de Obra' }),
    ).toHaveCount(0);

    // 2) "Cancelar" fecha sem importar
    await modal.getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.locator(MODAL)).toHaveCount(0);
    expect(importPosts).toEqual([]);

    // cronograma intacto
    // etapa manual visível no gantt desktop (a lista mobile é md:hidden)
    await expect(page.getByText('PINTURA MANUAL').first()).toBeVisible();

    // 3) reabre, avança para a confirmação e confirma
    await page.getByRole('button', { name: 'Importar', exact: true }).click();
    await page.locator(MODAL).getByRole('button', { name: 'Substituir cronograma' }).click();

    const confirmBtn = page.locator(MODAL).getByRole('button', { name: 'Apagar e importar modelo' });
    await expect(confirmBtn).toBeVisible();
    await expect(page.locator(MODAL).getByText('Esta ação não pode ser desfeita.')).toBeVisible();
    // ainda nada importado antes do clique destrutivo
    expect(importPosts).toEqual([]);

    await confirmBtn.click();
    await expect.poll(() => importPosts.length).toBe(1);
    await expect(page.locator(MODAL)).toHaveCount(0);
  });

  test('SEM cronograma: "Importar Modelo de Obra" importa direto, sem passo de confirmação', async ({
    page,
    baseURL,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'basta um viewport — o fluxo sem cronograma é o mesmo',
    );
    const importPosts: string[] = [];
    await mockApi(page, baseURL!, GANTT_EMPTY, importPosts);
    await page.goto(`/projects/${PROJECT_ID}/schedule`);

    await expect(page.getByText('Nenhum cronograma configurado')).toBeVisible();

    // antes de abrir o modal, só o empty-state tem esse botão
    await page.getByRole('button', { name: 'Importar Modelo de Obra' }).click();

    const modal = page.locator(MODAL);
    await expect(modal.getByRole('heading', { name: 'Importar Cronograma' })).toBeVisible();

    // sem aviso de substituição e sem 2º passo
    await expect(modal.getByText('Isto vai substituir o cronograma atual.')).toHaveCount(0);
    await expect(modal.getByRole('button', { name: 'Substituir cronograma' })).toHaveCount(0);

    await modal.getByRole('button', { name: 'Importar Modelo de Obra' }).click();
    await expect.poll(() => importPosts.length).toBe(1);
  });
});

test.describe('#647 — importação alcançável no mobile quando já há cronograma', () => {
  for (const width of [375, 390]) {
    test(`${width}px: "Importar" no header mobile, hitável, sem overflow; confirma em 2 passos e "Cancelar" não importa`, async ({
      page,
      baseURL,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== 'mobile',
        'o gap é mobile-only — roda no viewport mobile (Pixel 5), variando a largura',
      );
      await page.setViewportSize({ width, height: 780 });

      const importPosts: string[] = [];
      await mockApi(page, baseURL!, GANTT_WITH_SCHEDULE, importPosts);
      await page.goto(`/projects/${PROJECT_ID}/schedule`);

      // header mobile editorial renderizado (o header desktop é display:none aqui)
      await expect(page.getByRole('heading', { name: 'Cronograma', exact: true })).toBeVisible();

      const importBtn = page.getByRole('button', { name: 'Importar', exact: true });
      await expect(importBtn).toBeVisible();

      // alvo de toque: bounding box não-zero, altura >= 44, e elementFromPoint no
      // centro devolve o próprio botão (cicatriz #21: caixa não gerada / coberta).
      const box = await importBtn.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThan(0);
      expect(box!.height).toBeGreaterThanOrEqual(44);
      const hitLabel = await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.textContent?.trim() ?? null,
        { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
      );
      expect(hitLabel).toContain('Importar');

      const noHorizontalScroll = () =>
        page.evaluate(() => {
          const de = document.documentElement;
          return de.scrollWidth <= de.clientWidth && document.body.scrollWidth <= de.clientWidth;
        });

      // sem scroll horizontal na tela do cronograma
      expect(await noHorizontalScroll()).toBe(true);

      // 1) abre o modal no passo 1 (aviso âmbar + contagens do estado carregado)
      await importBtn.click();
      const modal = page.locator(MODAL);
      await expect(modal.getByRole('heading', { name: 'Importar Cronograma' })).toBeVisible();
      await expect(modal.getByText('Isto vai substituir o cronograma atual.')).toBeVisible();
      await expect(modal.getByText(/1 etapa e 2 tarefas/)).toBeVisible();

      // sem scroll horizontal com o modal aberto
      expect(await noHorizontalScroll()).toBe(true);

      // 2) "Cancelar" no passo 1 → 0 POST /schedule/import
      await modal.getByRole('button', { name: 'Cancelar' }).click();
      await expect(page.locator(MODAL)).toHaveCount(0);
      expect(importPosts).toEqual([]);

      // 3) reabre, avança para o passo 2, "Cancelar" → ainda 0 POST
      await importBtn.click();
      await modal.getByRole('button', { name: 'Substituir cronograma' }).click();
      await expect(modal.getByRole('button', { name: 'Apagar e importar modelo' })).toBeVisible();
      await modal.getByRole('button', { name: 'Cancelar' }).click();
      await expect(page.locator(MODAL)).toHaveCount(0);
      expect(importPosts).toEqual([]);

      // 4) reabre e confirma os DOIS passos → exatamente 1 POST /schedule/import
      await importBtn.click();
      await modal.getByRole('button', { name: 'Substituir cronograma' }).click();
      await modal.getByRole('button', { name: 'Apagar e importar modelo' }).click();
      await expect.poll(() => importPosts.length).toBe(1);
      await expect(page.locator(MODAL)).toHaveCount(0);
    });
  }
});
