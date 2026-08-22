import { expect, test, type Page } from "@playwright/test";

/**
 * OCLUSÃO DE SHELL, não de componente.
 *
 * O painel de jornada (`[data-journey-panel]`, `fixed inset-x-3 bottom-3
 * z-[70]`) nasce ancorado na MESMA borda que o dock mobile (`.minimal-dock`,
 * `fixed inset-x-0 bottom-0 z-30`). Com z-index 70 contra 30, o painel ganha o
 * hit-test de tudo que o dock oferece: as 4 abas do PESSOAL e o "Lançar" — o
 * único caminho até a primeira despesa no mobile. A jornada manda lançar e
 * tapa o botão que lança.
 *
 * Por que runtime e não jsdom: `elementFromPoint` exige LAYOUT. jsdom não
 * posiciona nada, devolve `null` para qualquer ponto e um teste ali passaria
 * verde com o bug ativo — foi exatamente o que aconteceu com
 * `ExpenseMobileFab.test.tsx`, que assere a `className` de um componente que
 * o PESSOAL nem monta (`ExpensesView.tsx`: `{!isPersonal && <ExpenseMobileFab/>}`).
 * Classe certa não é prova; quem decide o toque é o hit-test.
 *
 * O que este arquivo assere é o hit-test, nunca a classe: para cada alvo,
 * `document.elementFromPoint(centro)` tem que devolver o próprio alvo (ou um
 * descendente dele — o ponto costuma cair no `<svg>`/`<span>` interno), e
 * nunca algo dentro de `[data-journey-panel]`.
 */

const projectId = "journey-occlusion-test";

/**
 * CENSO, não lista fixa.
 *
 * A propriedade que interessa é "todo alvo do shell mobile que está visível
 * continua tocável", não "estas 5 abas específicas continuam tocáveis". Uma
 * lista fixa quebraria por DRIFT no dia em que o dock ganhasse ou perdesse uma
 * aba (o #528 remove `credit-cards` do PESSOAL) — vermelho sem regressão, que
 * treina todo mundo a ignorar o teste. O censo sobrevive a isso e ainda cobre
 * de graça qualquer slot futuro, que é justamente o modo de falha O(N) que
 * gerou este bug: a correção anterior foi aplicada FAB a FAB e não alcançou o
 * elemento que o usuário realmente vê.
 */
const SHELL_TARGET_SELECTOR = "[data-dock-slot], [data-launcher]";

/**
 * Piso do censo. Sem ele, o dia em que o seletor deixasse de casar com
 * qualquer coisa (renome de atributo, dock não montado) o teste passaria
 * VERDE por vacuidade — "nenhum alvo coberto" porque não há alvo nenhum.
 * O dock do PESSOAL tem hoje 4 abas + "Lançar"; o #528 tira uma. Três é o
 * piso que acusa desmonte sem engessar a composição.
 */
const MIN_CENSUS = 3;

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 390, height: 844 },
];

function json(body: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

/**
 * Jornada ativa semeada direto no `sessionStorage`, na chave que o
 * `JourneyRuntimeProvider` hidrata (`readStored`). É o mesmo estado que o
 * usuário novo tem depois do cadastro, sem depender do encadeamento de
 * elegibilidade da API — o defeito é de layout do painel, não de elegibilidade.
 *
 * A primeira etapa é `FULL` com `slug: "conta"`: é o efeito de navegação do
 * runtime que leva o usuário para `/projects/<id>/conta`, a primeira tela que
 * uma conta nova vê. Duas etapas para o rodapé dizer "Continuar" (com uma só,
 * diria "Concluir") — o mesmo botão que o QA achou por cima do "Lançar".
 */
const ACTIVE_JOURNEY = {
  journey: {
    journeyId: "journey-onboarding-pessoal",
    key: "onboarding-pessoal",
    name: "Primeiros passos",
    triggerId: "trigger-signup",
    repeatPolicy: "ONCE",
    dismissPolicy: "SESSION",
    crossProject: false,
    active: true,
    targetScope: "PROJECT_TYPE",
    targetProjectType: "PESSOAL",
    plan: { steps: [] },
    steps: [
      {
        stepKey: "funding",
        order: 1,
        experience: "FULL",
        label: "Cadastre onde o dinheiro entra e sai",
        subtitle:
          "Comece pela conta e pelo cartão que você mais usa. Depois lance seu primeiro gasto para o cockpit sair do zero.",
        skippable: true,
        slug: "conta",
      },
      {
        stepKey: "expense.first",
        order: 2,
        experience: "FULL",
        label: "Lance seu primeiro gasto",
        subtitle: "Use o botão Lançar para registrar a primeira despesa.",
        skippable: true,
      },
    ],
  },
  stepIndex: 0,
  projectId,
  projectType: "PESSOAL",
};

/**
 * Variante com o passo mais alto que o catálogo permite: rótulo e subtítulo
 * longos, para que o conteúdo do painel exceda a altura útil e force a
 * rolagem. É o pior caso do painel — se as ações continuam alcançáveis aqui,
 * continuam em qualquer passo real.
 */
const TALL_JOURNEY = {
  ...ACTIVE_JOURNEY,
  journey: {
    ...ACTIVE_JOURNEY.journey,
    steps: [
      {
        ...ACTIVE_JOURNEY.journey.steps[0],
        label:
          "Cadastre onde o dinheiro entra e onde ele sai, começando pela conta corrente que recebe o salário e pelo cartão de crédito que concentra as compras do dia a dia",
        subtitle:
          "Comece pela conta e pelo cartão que você mais usa no dia a dia. " +
          "Depois lance seu primeiro gasto para o cockpit sair do zero e as projeções passarem a valer alguma coisa. " +
          "Sem pelo menos um lançamento o mês fica vazio, os gráficos ficam chapados e a Maria não tem material " +
          "para gerar nenhum insight útil sobre o seu comportamento financeiro ao longo do mês. " +
          "Cadastre também os cartões que você usa com frequência, porque a fatura só fecha corretamente quando " +
          "o ciclo de cada cartão está configurado com o dia de fechamento e o dia de vencimento certos. " +
          "Se você tem renda variável, registre as entradas previstas para que o saldo projetado não fique otimista demais. " +
          "Quanto mais completo o cadastro inicial, menos retrabalho depois — e o cockpit passa a responder perguntas " +
          "de verdade sobre para onde o seu dinheiro está indo todo mês, em vez de mostrar uma tela vazia sem utilidade." +
          "Revise as categorias sugeridas e ajuste o que não fizer sentido para a sua rotina, porque elas alimentam os relatórios. " +
          "Marque quais gastos são fixos e quais são variáveis: essa separação é o que permite prever o mês seguinte com alguma confiança. " +
          "Se você divide contas com outra pessoa, registre isso agora para não ter que reconciliar tudo manualmente depois. " +
          "Por fim, confira o dia de fechamento de cada cartão, que é o detalhe que mais causa divergência entre o previsto e o realizado. " +
          "Tudo isso leva poucos minutos e evita que o cockpit mostre números que não correspondem à sua realidade financeira.",
      },
      ACTIVE_JOURNEY.journey.steps[1],
    ],
  },
};

async function openContaWithJourney(
  page: Page,
  viewport: { width: number; height: number },
  journey: typeof ACTIVE_JOURNEY = ACTIVE_JOURNEY,
) {
  await page.clock.setFixedTime(new Date("2026-07-15T12:00:00.000Z"));
  await page.setViewportSize(viewport);
  await page
    .context()
    .addCookies([
      { name: "rf_token", value: "test", url: "http://localhost:3013" },
    ]);

  await page.addInitScript((active) => {
    window.sessionStorage.setItem(
      "lifeone:journey-runtime",
      JSON.stringify(active),
    );
  }, journey);

  await page.route("http://localhost:3001/**", async (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/auth/me")
      return route.fulfill(
        json({
          id: "user-test",
          username: "test",
          name: "Usuário Teste",
          role: "ADMIN",
          tenantId: "tenant-test",
          allowedModules: [],
          allowedProjects: [],
          allowedProjectTypes: [],
        }),
      );
    if (path === "/auth/config")
      return route.fulfill(
        json({ registerEnabled: false, guestEnabled: false }),
      );
    if (path === `/projects/${projectId}`)
      return route.fulfill(
        json({
          id: projectId,
          name: "Pessoal Teste",
          type: "PESSOAL",
          onboardedAt: "2026-01-01T00:00:00.000Z",
          rooms: [],
        }),
      );
    if (path === "/projects")
      return route.fulfill(
        json([{ id: projectId, name: "Pessoal Teste", type: "PESSOAL" }]),
      );
    if (path === `/projects/${projectId}/bank-accounts`)
      return route.fulfill(json([]));
    if (path === `/projects/${projectId}/monthly-overview/account-view`)
      return route.fulfill(
        json({
          mesSelecionado: "2026-07",
          caixaHoje: 0,
          carteiraHoje: 0,
          entrouMes: 0,
          saiuMes: 0,
          faltaPagarMes: 0,
          recebimentosPrevistosMes: 0,
          sobraPrevista: 0,
          devoCartaoTotal: 0,
          cartoes: [],
          contas: [],
          saidas: [],
          comprasCartao: [],
          entradas: [],
          ticketMedio: {
            valor: 0,
            nCompras: 0,
            totalCompras: 0,
            serie6m: [],
            media6m: 0,
            deltaVsMediaPct: null,
          },
        }),
      );
    if (path === `/projects/${projectId}/monthly-overview/dre-overview`)
      return route.fulfill(
        json({ anual: { saldoAcumuladoSerie: [] } }),
      );
    return route.fulfill(json([]));
  });

  await page.goto(`/projects/${projectId}/conta`);

  // O painel PRECISA estar aberto — sem ele o teste não mede nada e passaria
  // verde por ausência do que deveria estar atrapalhando.
  await expect(page.locator("[data-journey-panel]")).toBeVisible();
  if (viewport.width < 768) {
    await expect(page.locator('[data-dock="minimal"]')).toBeVisible();
  }
}

/**
 * Hit-test real de TODOS os alvos que casam com o seletor: `elementFromPoint`
 * no CENTRO de cada um. Devolve o que o browser entregaria a um toque naquele
 * ponto — classe certa não é prova, quem decide o toque é o hit-test.
 *
 * Roda inteiro dentro da página: enumerar e medir no mesmo turno evita que o
 * layout mude entre a medição da caixa e o hit-test.
 */
async function censusHitTest(page: Page, selector: string) {
  return page.evaluate((selector) => {
    const describe = (el: Element | null) => {
      if (!el) return "null";
      const label =
        el.getAttribute("aria-label") ??
        (el.textContent ?? "").trim().slice(0, 24);
      return `${el.tagName} "${label}"`;
    };

    return Array.from(document.querySelectorAll(selector))
      .map((target) => {
        const box = target.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return null; // invisível não é alvo
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        const hit = document.elementFromPoint(x, y);
        const hitsTarget = !!hit && target.contains(hit);
        const blockedByPanel = !!hit && !!hit.closest("[data-journey-panel]");
        return {
          name: describe(target),
          hitsTarget,
          report:
            `${describe(target)} centro (${Math.round(x)}, ${Math.round(y)}) → ` +
            `${describe(hit)}${blockedByPanel ? " [PAINEL DA JORNADA]" : ""}`,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  }, selector);
}

test.describe("Jornada aberta não pode tapar a navegação mobile", () => {
  for (const viewport of VIEWPORTS) {
    test(`shell mobile permanece tocável a ${viewport.width}px`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "desktop",
        "os viewports são explicitamente donos deste spec",
      );
      await openContaWithJourney(page, viewport);

      const census = await censusHitTest(page, SHELL_TARGET_SELECTOR);

      expect(
        census.length,
        `Censo vazio/curto (${census.length}) — o seletor "${SHELL_TARGET_SELECTOR}" ` +
          `parou de casar com o dock. Sem isso o teste passa verde sem medir nada.`,
      ).toBeGreaterThanOrEqual(MIN_CENSUS);

      const blocked = census.filter((entry) => !entry.hitsTarget);

      expect(
        blocked.map((entry) => entry.report),
        `Alvos do shell interceptados com a jornada aberta a ${viewport.width}px ` +
          `(censo de ${census.length}):\n  ${blocked.map((entry) => entry.report).join("\n  ")}`,
      ).toEqual([]);
    });
  }
});

/**
 * O painel não pode tapar o próprio botão dele.
 *
 * Ao ceder espaço para o dock o painel perde altura útil e passa a rolar. Se a
 * linha de ações rolar junto, trocamos "painel tapa o botão do app" por
 * "painel esconde o próprio botão" — mesma família de defeito, culpa nova. As
 * ações têm que estar FORA da área rolável, e isso se prova por hit-test, não
 * por leitura de CSS.
 */
test.describe("Painel da jornada não esconde as próprias ações", () => {
  for (const viewport of VIEWPORTS) {
    test(`ações do painel alcançáveis sem rolagem a ${viewport.width}px`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "desktop",
        "os viewports são explicitamente donos deste spec",
      );
      await openContaWithJourney(page, viewport, TALL_JOURNEY);

      const census = await censusHitTest(
        page,
        "[data-journey-panel] [data-journey-panel-action]",
      );

      expect(
        census.length,
        "A linha de ações do painel sumiu do DOM — sem ela o teste não mede nada.",
      ).toBeGreaterThanOrEqual(1);

      const blocked = census.filter((entry) => !entry.hitsTarget);
      expect(
        blocked.map((entry) => entry.report),
        `Ações do painel inalcançáveis a ${viewport.width}px:\n  ${blocked.map((entry) => entry.report).join("\n  ")}`,
      ).toEqual([]);
    });
  }
});

test.describe("Overlays de conta e lançamento afastam o painel da jornada", () => {
  for (const viewport of [
    { width: 375, height: 812 },
    { width: 390, height: 844 },
    { width: 1280, height: 800 },
  ]) {
    test(`conta bancária continua tocável a ${viewport.width}px`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "desktop",
        "os viewports são explicitamente donos deste spec",
      );
      await openContaWithJourney(page, viewport);

      await page
        .getByRole("button", { name: "Nova conta", exact: true })
        .filter({ visible: true })
        .evaluate((button: HTMLButtonElement) => button.click());

      await expect(
        page.getByRole("heading", { name: "Nova conta bancária" }),
      ).toBeVisible();
      await expect(page.locator("body")).toHaveAttribute(
        "data-overlay-open",
        "true",
      );
      await expect(page.locator("[data-journey-panel]")).toBeHidden();

      for (const action of ["Cancelar", "Salvar"]) {
        const target = page.getByRole("button", { name: action, exact: true });
        await target.scrollIntoViewIfNeeded();
        await expect
          .poll(() =>
            target.evaluate((element) => {
              const box = element.getBoundingClientRect();
              const hit = document.elementFromPoint(
                box.x + box.width / 2,
                box.y + box.height / 2,
              );
              return !!hit && element.contains(hit);
            }),
          )
          .toBe(true);
      }

      await page.getByRole("button", { name: "Cancelar", exact: true }).click();
      await expect(page.locator("body")).not.toHaveAttribute(
        "data-overlay-open",
        "true",
      );
      await expect(page.locator("[data-journey-panel]")).toBeVisible();
    });
  }

  for (const viewport of VIEWPORTS) {
    test(`folhas de lançamento continuam tocáveis a ${viewport.width}px`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "desktop",
        "os viewports são explicitamente donos deste spec",
      );
      await openContaWithJourney(page, viewport);

      await page.locator("[data-launcher]").click();
      const expenseMode = page.locator(
        '[data-mobile-sheet="launch-mode"] [data-journey-action="expense.new"]',
      );
      await expect(expenseMode).toBeVisible();
      await expect(page.locator("[data-journey-panel]")).toBeHidden();

      await expenseMode.click();
      const keypadFive = page
        .locator('[data-mobile-sheet="launch"]')
        .getByRole("button", { name: "5", exact: true });
      await expect(keypadFive).toBeVisible();
      await expect
        .poll(() =>
          keypadFive.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const hit = document.elementFromPoint(
              box.x + box.width / 2,
              box.y + box.height / 2,
            );
            return !!hit && element.contains(hit);
          }),
        )
        .toBe(true);

      await page.getByRole("button", { name: "Fechar lançar" }).click();
      await expect(page.locator("[data-journey-panel]")).toBeVisible();
    });
  }
});
