import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import {
  buildNavGroups,
  getProjectNavModules,
  NAV_GROUPS,
  ProjectType,
} from "@reformaflow/domain";
import { DesktopSidebar } from "./DesktopSidebar";

/**
 * ─── CONVENÇÃO DE MARCAÇÃO (leia antes de acrescentar teste) ────────────────
 *
 *   [RED]   = falhava ANTES desta implementação (U1 / #450). Prova que o
 *             código novo faz o que promete.
 *   [TRAVA] = já passava antes. NÃO prova nada sobre a implementação nova;
 *             existe só para quebrar se alguém desfizer um invariante já
 *             conquistado.
 *
 * ─── ONDE CADA ASSERÇÃO VIVE (normativo) ───────────────────────────────────
 *
 * jsdom NÃO TEM LAYOUT: `getBoundingClientRect()` devolve zeros e `0 >= 0`
 * passa. Nenhuma asserção de GEOMETRIA ou de ALCANÇABILIDADE pode viver neste
 * arquivo — ela seria verde por construção. Aqui se asserta ESTRUTURA (o
 * separador existe, o grupo tem role/aria-label, a dica é elemento no DOM e
 * carrega o nome do grupo). Caixa medida, hit-test e "cabe sem rolar" vivem em
 * `e2e/desktop-nav-groups.spec.ts`.
 */

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: any) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

// NotificationsBell pulls in data/hooks; stub it for a focused smoke test.
vi.mock("@/components/notifications/NotificationsBell", () => ({
  NotificationsBell: () => <div data-testid="notifications-bell" />,
}));

const basePath = "/projects/p1";

const props = {
  project: { id: "p1", name: "Casa Nova", type: "REFORMA" as const },
  basePath,
  pathname: `${basePath}/dashboard`,
  visibleNav: getProjectNavModules(ProjectType.REFORMA),
  isAdmin: false,
  canSeeBudgetHistory: false,
  userName: "Ana",
  onLogout: vi.fn(),
};

describe("DesktopSidebar", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });
  it("preserves supplied row order and marks only the owning route current", () => {
    const canonical = getProjectNavModules(ProjectType.REFORMA);
    const visibleNav = [canonical[3], canonical[0], canonical[1]];
    render(
      <DesktopSidebar
        project={{ id: "p1", name: "Casa Nova", type: "REFORMA" }}
        basePath={basePath}
        pathname={`${basePath}/dashboard/detail`}
        visibleNav={visibleNav}
        isAdmin={false}
        canSeeBudgetHistory={false}
        userName="Ana"
        onLogout={vi.fn()}
      />,
    );

    const links = within(screen.getByRole("navigation")).getAllByRole("link");
    expect(
      links.map((link) => [
        link.getAttribute("aria-label"),
        link.getAttribute("href"),
      ]),
    ).toEqual([
      ["Fluxo de Caixa", `${basePath}/cash-flow`],
      ["Dashboard", `${basePath}/dashboard`],
      ["Despesas", `${basePath}/expenses`],
      ["Apoio", `${basePath}/apoio`],
      ["Configurações", "/settings"],
    ]);
    expect(
      links
        .filter((link) => link.getAttribute("aria-current") === "page")
        .map((link) => link.getAttribute("aria-label")),
    ).toEqual(["Dashboard"]);
    expect(screen.getByText("Casa Nova")).toBeInTheDocument();
  });

  it("renders the admin Usuários link when isAdmin", () => {
    render(
      <DesktopSidebar
        project={{ id: "p1", name: "Casa Nova", type: "REFORMA" }}
        basePath={basePath}
        pathname={`${basePath}/dashboard`}
        visibleNav={getProjectNavModules(ProjectType.REFORMA)}
        isAdmin
        canSeeBudgetHistory={false}
        userName="Ana"
        onLogout={vi.fn()}
      />,
    );
    expect(screen.getByText("Usuários")).toBeInTheDocument();
  });

  /**
   * U1 (#450) — este teste é a REESCRITA do antigo
   * "groups PESSOAL sidebar into cockpit/conta/cartoes/planejamento/analises
   * and removes despesas from primary menu".
   *
   * Ele NÃO foi apagado: foi invertido. O antigo travava exatamente o defeito —
   * exigia que "Despesas" e "Recebimentos" NÃO aparecessem no desktop. Elas não
   * apareciam porque a `buildDesktopNavGroups` local montava os grupos a partir
   * de listas fixas de slug e descartava em silêncio o que sobrasse; os dois
   * módulos existem em `PROJECT_NAV[PESSOAL]` e sumiram do menu desktop sem
   * ninguém notar. Agora o agrupamento é partição TOTAL vinda do domínio, e o
   * teste prova o oposto: os dois estão lá, sob "Movimentações".
   */
  it("U1-V01 [RED] PESSOAL: os grupos e a ordem vêm do domínio, não de listas fixas na view", () => {
    const visibleNav = getProjectNavModules(ProjectType.PESSOAL);
    const { container } = render(
      <DesktopSidebar
        {...props}
        project={{ id: "p1", name: "Finanças", type: ProjectType.PESSOAL }}
        pathname={`${basePath}/conta`}
        visibleNav={visibleNav}
      />,
    );

    const expected = buildNavGroups(ProjectType.PESSOAL, visibleNav);
    const rendered = Array.from(
      container.querySelectorAll<HTMLElement>("nav [data-nav-group]"),
    );

    // A view renderiza EXATAMENTE o que `buildNavGroups` devolve — ids, ordem e
    // tier. Se algum dia alguém reintroduzir uma tabela local, isto quebra.
    expect(rendered.map((el) => el.dataset.navGroup)).toEqual(expected.map((g) => g.id));
    expect(rendered.map((el) => el.dataset.navTier)).toEqual(expected.map((g) => g.tier));
    expect(rendered.map((el) => el.dataset.navGroup)).toEqual([
      "hoje",
      "movimentacoes",
      "planejamento",
      "resultado",
      "auditoria",
    ]);

    // Partição TOTAL na tela: nenhum slug visível é descartado no caminho.
    const renderedHrefs = rendered.flatMap((el) =>
      Array.from(el.querySelectorAll("a")).map((a) => a.getAttribute("href")),
    );
    expect(renderedHrefs).toEqual(
      expected.flatMap((g) => g.items.map((i) => `${basePath}/${i.slug}`)),
    );
    expect(renderedHrefs).toHaveLength(visibleNav.length);
  });

  it("U1-V02 [RED] Despesas e Recebimentos VOLTAM ao desktop, dentro de Movimentações", () => {
    const { container } = render(
      <DesktopSidebar
        {...props}
        project={{ id: "p1", name: "Finanças", type: ProjectType.PESSOAL }}
        pathname={`${basePath}/conta`}
        visibleNav={getProjectNavModules(ProjectType.PESSOAL)}
      />,
    );

    const movimentacoes = container.querySelector<HTMLElement>(
      '[data-nav-group="movimentacoes"]',
    );
    expect(movimentacoes).not.toBeNull();
    expect(
      Array.from(movimentacoes!.querySelectorAll("a")).map((a) => a.getAttribute("href")),
    ).toEqual([
      `${basePath}/conta`,
      `${basePath}/expenses`,
      `${basePath}/receipts`,
      `${basePath}/credit-cards`,
      `${basePath}/bank-accounts`,
    ]);
    expect(screen.getByRole("link", { name: "Despesas" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Recebimentos" })).toBeInTheDocument();
  });

  it("U1-V03 [RED] cada grupo é um `role=group` nomeado — o nome existe mesmo recolhido", () => {
    render(
      <DesktopSidebar
        {...props}
        project={{ id: "p1", name: "Finanças", type: ProjectType.PESSOAL }}
        visibleNav={getProjectNavModules(ProjectType.PESSOAL)}
      />,
    );

    // Recolhido é o estado PADRÃO. É justamente aí que o rótulo do grupo some
    // da tela; sem `aria-label` no contêiner, "Movimentações" deixaria de
    // existir para o leitor de tela — que é o objetivo inteiro da opção (B).
    expect(
      screen.getAllByRole("group").map((el) => el.getAttribute("aria-label")),
    ).toEqual(["Hoje", "Movimentações", "Planejamento", "Resultado", "Auditoria"]);

    // O rótulo textual continua escondido enquanto recolhido (não há <p>).
    expect(screen.queryByText("Movimentações", { selector: "p" })).not.toBeInTheDocument();
  });

  it("U1-V03b [RED] expandido: o `role=group` continua nomeado E o rótulo textual aparece", () => {
    render(
      <DesktopSidebar
        {...props}
        project={{ id: "p1", name: "Finanças", type: ProjectType.PESSOAL }}
        visibleNav={getProjectNavModules(ProjectType.PESSOAL)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /expandir menu lateral/i }));

    expect(
      screen.getAllByRole("group").map((el) => el.getAttribute("aria-label")),
    ).toEqual(["Hoje", "Movimentações", "Planejamento", "Resultado", "Auditoria"]);
    for (const label of ["Hoje", "Movimentações", "Planejamento", "Resultado", "Auditoria"]) {
      expect(screen.getByText(label, { selector: "p" })).toBeInTheDocument();
    }
  });

  it("U1-V04 [RED] recolhido: régua de 1px ENTRE grupos (n-1), some ao expandir", () => {
    const { container } = render(
      <DesktopSidebar
        {...props}
        project={{ id: "p1", name: "Finanças", type: ProjectType.PESSOAL }}
        visibleNav={getProjectNavModules(ProjectType.PESSOAL)}
      />,
    );
    const rules = () => container.querySelectorAll("[data-nav-separator]");
    const groupCount = container.querySelectorAll("nav [data-nav-group]").length;

    // n-1: separador ANTES do primeiro grupo é linha órfã encostada no
    // cabeçalho, e depois do último desenha um segundo rodapé falso.
    expect(rules()).toHaveLength(groupCount - 1);
    // `h-px`: uma linha grossa come orçamento vertical que este rail não tem.
    for (const rule of Array.from(rules())) expect(rule).toHaveClass("h-px");

    fireEvent.click(screen.getByRole("button", { name: /expandir menu lateral/i }));
    // Expandido o rótulo do grupo já faz a separação; a régua vira ruído.
    expect(rules()).toHaveLength(0);
  });

  it("U1-V05 [RED] a dica é ELEMENTO no DOM e carrega `{Grupo} · {Item}`", () => {
    render(
      <DesktopSidebar
        {...props}
        project={{ id: "p1", name: "Finanças", type: ProjectType.PESSOAL }}
        visibleNav={getProjectNavModules(ProjectType.PESSOAL)}
      />,
    );

    // A dica NATIVA do navegador (`title`) não é mensurável: ela é pintada pelo
    // navegador e não vive no DOM — `getBoundingClientRect` não a alcança,
    // `elementFromPoint` não a acha, o Playwright não a vê. Se a dica fosse a
    // nativa, não haveria como provar entrega. Daí ser elemento próprio.
    const cartoes = screen.getByRole("link", { name: "Cartões" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    fireEvent.mouseOver(cartoes);
    const hint = screen.getByRole("tooltip");
    expect(hint).toHaveTextContent("Movimentações · Cartões");
    expect(cartoes).toHaveAttribute("aria-describedby", hint.id);

    fireEvent.mouseOut(cartoes);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    // Teclado tem que chegar na mesma dica; senão só o mouse vê o grupo.
    fireEvent.focus(screen.getByRole("link", { name: "Neutros" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Auditoria · Neutros");
    fireEvent.blur(screen.getByRole("link", { name: "Neutros" }));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("U1-V05b [RED] a dica não duplica a nativa: os itens de módulo perdem `title`", () => {
    const { container } = render(
      <DesktopSidebar
        {...props}
        project={{ id: "p1", name: "Finanças", type: ProjectType.PESSOAL }}
        visibleNav={getProjectNavModules(ProjectType.PESSOAL)}
      />,
    );
    // Manter `title` junto da dica própria faria o navegador pintar DUAS dicas,
    // a nativa atrasada por cima da nossa.
    const links = Array.from(container.querySelectorAll("nav [data-nav-group] a"));
    // Sem esta contagem o `for` abaixo passaria VAZIO — verde por não iterar
    // nada, que é exatamente o falso positivo que este arquivo combate.
    expect(links).toHaveLength(getProjectNavModules(ProjectType.PESSOAL).length);
    for (const link of links) {
      expect(link).not.toHaveAttribute("title");
      expect(link.getAttribute("aria-label")).toBeTruthy();
    }
  });

  it("U1-V05c [RED] a dica sobrevive ao rail expandido (mesma mecânica, os dois estados)", () => {
    render(
      <DesktopSidebar
        {...props}
        project={{ id: "p1", name: "Finanças", type: ProjectType.PESSOAL }}
        visibleNav={getProjectNavModules(ProjectType.PESSOAL)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /expandir menu lateral/i }));
    fireEvent.mouseOver(screen.getByRole("link", { name: "Recorrentes" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Planejamento · Recorrentes");
  });

  it("U1-V06 [RED] Projetos: destino ancorado no cabeçalho, UMA entrada só, sem 'voltar'", () => {
    const { container } = render(
      <DesktopSidebar
        {...props}
        project={{ id: "p1", name: "Finanças", type: ProjectType.PESSOAL }}
        visibleNav={getProjectNavModules(ProjectType.PESSOAL)}
      />,
    );

    const projetos = container.querySelector<HTMLAnchorElement>('a[data-nav-group="projetos"]');
    expect(projetos).not.toBeNull();
    expect(projetos).toHaveAttribute("href", "/projects");
    expect(projetos).toHaveAttribute("aria-label", "Projetos");
    expect(projetos).toHaveAttribute("data-nav-tier", "primary");
    expect(projetos!.getAttribute("aria-label")).not.toMatch(/voltar/i);

    // Decisão (i) do PO: NÃO existe um quarto item na lista de módulos. Duas
    // entradas para o mesmo destino é pior que uma bem colocada — e a da lista
    // cairia ~279px abaixo da dobra, num rail de 64px, sem rótulo.
    expect(container.querySelectorAll('a[href="/projects"]')).toHaveLength(1);
    expect(container.querySelectorAll('nav a[href="/projects"]')).toHaveLength(0);

    // O ícone deixou de ser direcional: "voltar" é outro nível de navegação.
    // Asserção NEGATIVA de propósito — trava o defeito sem congelar a escolha
    // estética exata.
    const icon = projetos!.querySelector("svg");
    expect(icon?.getAttribute("class") ?? "").not.toMatch(/arrow-left/);
  });

  it("U1-V06b [RED] a dica do Projetos ancorado não vira 'Projetos · Projetos'", () => {
    const { container } = render(
      <DesktopSidebar
        {...props}
        project={{ id: "p1", name: "Finanças", type: ProjectType.PESSOAL }}
        visibleNav={getProjectNavModules(ProjectType.PESSOAL)}
      />,
    );
    fireEvent.mouseOver(container.querySelector('a[data-nav-group="projetos"]')!);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Projetos");
    expect(screen.getByRole("tooltip").textContent).not.toContain("·");
  });

  it("U1-V07 [RED] tipo de lista única (REFORMA): um grupo `modulos`, tier secundário, zero régua", () => {
    const visibleNav = getProjectNavModules(ProjectType.REFORMA);
    const { container } = render(<DesktopSidebar {...props} visibleNav={visibleNav} />);

    const groups = Array.from(container.querySelectorAll<HTMLElement>("nav [data-nav-group]"));
    expect(groups.map((el) => el.dataset.navGroup)).toEqual(["modulos"]);
    expect(groups[0].dataset.navTier).toBe("secondary");
    expect(groups[0]).toHaveAttribute("aria-label", "Módulos");
    expect(
      Array.from(groups[0].querySelectorAll("a")).map((a) => a.getAttribute("href")),
    ).toEqual(visibleNav.map((m) => `${basePath}/${m.slug}`));
    // Um único grupo não tem "entre grupos".
    expect(container.querySelectorAll("[data-nav-separator]")).toHaveLength(0);

    fireEvent.mouseOver(screen.getByRole("link", { name: "Despesas" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Módulos · Despesas");
  });

  it("U1-V08 [RED] `NAV_GROUPS` é a única tabela: a view não reinventa rótulo nem tier", () => {
    const visibleNav = getProjectNavModules(ProjectType.PESSOAL);
    const { container } = render(
      <DesktopSidebar
        {...props}
        project={{ id: "p1", name: "Finanças", type: ProjectType.PESSOAL }}
        visibleNav={visibleNav}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /expandir menu lateral/i }));

    for (const el of Array.from(
      container.querySelectorAll<HTMLElement>("nav [data-nav-group]"),
    )) {
      const definition = NAV_GROUPS.find((g) => g.id === el.dataset.navGroup);
      expect(definition).toBeDefined();
      expect(el.getAttribute("aria-label")).toBe(definition!.label);
      expect(el.dataset.navTier).toBe(definition!.tier);
      expect(within(el).getByText(definition!.label, { selector: "p" })).toBeInTheDocument();
    }
    // Guarda anti-verde-vazio: sem isto o `for` acima passaria não iterando.
    expect(container.querySelectorAll("nav [data-nav-group]")).toHaveLength(
      buildNavGroups(ProjectType.PESSOAL, visibleNav).length,
    );
  });

  /**
   * `buildNavGroups` NÃO emite grupo vazio. Logo o número de seções — e de
   * réguas — VARIA com a permissão do usuário: um PESSOAL sem `monthlyOverview`
   * perde "Hoje", "Resultado" e "Auditoria" INTEIROS. Qualquer contagem fixa na
   * view (ou num teste) erra. Estes dois casos existem para quebrar se alguém
   * reintroduzir número mágico.
   */
  const allowOnly = (modules: string[]) =>
    getProjectNavModules(ProjectType.PESSOAL).filter((m) =>
      modules.includes(m.module),
    );

  it("U1-V09 [RED] permissão reduzida: grupos e réguas ACOMPANHAM a permissão (nada de contagem fixa)", () => {
    // Sem `monthlyOverview`: caem Hoje, Resultado e Auditoria por inteiro.
    const visibleNav = allowOnly([
      "expenses",
      "receipts",
      "creditCards",
      "bankAccounts",
    ]);
    const { container } = render(
      <DesktopSidebar
        {...props}
        project={{ id: "p1", name: "Finanças", type: ProjectType.PESSOAL }}
        visibleNav={visibleNav}
      />,
    );

    const expected = buildNavGroups(ProjectType.PESSOAL, visibleNav);
    // Contrato, não número: se o domínio mudar a partição, este teste segue.
    expect(expected.map((g) => g.id)).toEqual(["movimentacoes", "planejamento"]);

    const rendered = Array.from(
      container.querySelectorAll<HTMLElement>("nav [data-nav-group]"),
    );
    expect(rendered.map((el) => el.dataset.navGroup)).toEqual(
      expected.map((g) => g.id),
    );
    // n-1 DERIVADO, nunca literal.
    expect(container.querySelectorAll("[data-nav-separator]")).toHaveLength(
      expected.length - 1,
    );
    // Grupo vazio não deixa cabeçalho órfão nem `role=group` fantasma.
    for (const gone of ["hoje", "resultado", "auditoria"]) {
      expect(container.querySelector(`[data-nav-group="${gone}"]`)).toBeNull();
    }
    expect(screen.queryByRole("group", { name: "Hoje" })).toBeNull();
    // ...e o destino ANCORADO Projetos sobrevive a qualquer permissão, porque
    // não vem do PROJECT_NAV.
    expect(container.querySelector('a[data-nav-group="projetos"]')).not.toBeNull();
  });

  it("U1-V10 [RED] um único grupo autorizado: zero régua, zero cabeçalho, grupo ainda nomeado", () => {
    const visibleNav = allowOnly(["creditCards"]);
    const { container } = render(
      <DesktopSidebar
        {...props}
        project={{ id: "p1", name: "Finanças", type: ProjectType.PESSOAL }}
        visibleNav={visibleNav}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /expandir menu lateral/i }));

    expect(container.querySelectorAll("nav [data-nav-group]")).toHaveLength(1);
    // n-1 = 0: régua solta seria um rodapé falso.
    expect(container.querySelectorAll("[data-nav-separator]")).toHaveLength(0);
    // Com uma seção só não há o que separar: o cabeçalho textual some...
    expect(screen.queryByText("Movimentações", { selector: "p" })).toBeNull();
    // ...mas o nome do grupo continua existindo para leitor de tela e para a dica.
    expect(screen.getByRole("group", { name: "Movimentações" })).toBeInTheDocument();
  });

  it("REG-02 [TRAVA — já passa] Budget fica FORA dos grupos e DENTRO do bloco administrativo", () => {
    render(
      <DesktopSidebar
        {...props}
        project={{ id: "p1", name: "Finanças", type: ProjectType.PESSOAL }}
        visibleNav={getProjectNavModules(ProjectType.PESSOAL)}
        isAdmin
        canSeeBudgetHistory
      />,
    );
    // (a) nunca na navegação de módulos que o U1 governa
    expect(document.querySelectorAll('[data-nav-group] a[href*="budget-allocation"]')).toHaveLength(0);
    // (b) mas presente onde a #504 o colocou — falhar aqui = U1 comeu a entrada
    //
    // DESVIO DELIBERADO do enunciado, que pedia
    // `toHaveAttribute('href', /budget-allocation/)`: o matcher `toHaveAttribute`
    // do jest-dom compara por IGUALDADE de string — ele serializa a RegExp e
    // compara com o href literal. A forma com regex falha contra um href
    // PERFEITAMENTE CORRETO (`href="/projects/p1/budget-allocation"` !==
    // "/budget-allocation/"), ou seja, seria um vermelho que nunca fica verde.
    // A intenção (o destino é a tela de budget) fica preservada, checada
    // exatamente.
    expect(screen.getByTestId('sidebar-budget-history')).toHaveAttribute(
      'href',
      `${basePath}/budget-allocation`,
    );
  });

  it("REG-03 [TRAVA — já passa] o cluster utilitário continua ANCORADO fora do contêiner rolável", () => {
    const { container } = render(
      <DesktopSidebar
        {...props}
        project={{ id: "p1", name: "Finanças", type: ProjectType.PESSOAL }}
        visibleNav={getProjectNavModules(ProjectType.PESSOAL)}
        isAdmin
        canSeeBudgetHistory
      />,
    );
    // #507 ancorou o cluster porque "Usuários" era inalcançável com a <nav>
    // inteira rolando. O U1 mexe na lista de módulos — e só nela.
    const scroller = container.querySelector<HTMLElement>("nav > .overflow-y-auto");
    expect(scroller).not.toBeNull();
    for (const label of ["Apoio", "Histórico de Budget", "Usuários"]) {
      const link = screen.getByRole("link", { name: label });
      expect(scroller!.contains(link)).toBe(false);
    }
    // ...e a lista de módulos continua sendo a única coisa que rola.
    expect(scroller!.contains(screen.getByRole("link", { name: "Cartões" }))).toBe(true);
  });


  /**
   * #504 — o ponto de entrada do histórico congelado de Alocação de Budget.
   *
   * Fica FORA de `PROJECT_NAV` de propósito (aquela lista filtra por módulo; o
   * gate desta tela é papel) e ao lado do item administrativo "Usuários", que
   * já segue exatamente esse padrão. O #449 tirou o item do menu e, sem querer,
   * tirou a tela do mundo: só sobrou a URL digitada à mão.
   */
  it("#504 renders the frozen budget history entry when the gate allows it", () => {
    render(
      <DesktopSidebar
        {...props}
        project={{ id: "p1", name: "Finanças", type: ProjectType.PESSOAL }}
        visibleNav={getProjectNavModules(ProjectType.PESSOAL)}
        isAdmin
        canSeeBudgetHistory
      />,
    );

    const link = screen.getByRole("link", { name: "Histórico de Budget" });
    expect(link).toHaveAttribute("href", `${basePath}/budget-allocation`);
  });

  it("#504 marks the budget history entry current while on its own route", () => {
    render(
      <DesktopSidebar
        {...props}
        project={{ id: "p1", name: "Finanças", type: ProjectType.PESSOAL }}
        visibleNav={getProjectNavModules(ProjectType.PESSOAL)}
        pathname={`${basePath}/budget-allocation`}
        isAdmin
        canSeeBudgetHistory
      />,
    );

    expect(
      screen.getByRole("link", { name: "Histórico de Budget" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("#504 hides the budget history entry whenever the gate denies it", () => {
    const { rerender } = render(
      <DesktopSidebar
        {...props}
        project={{ id: "p1", name: "Finanças", type: ProjectType.PESSOAL }}
        visibleNav={getProjectNavModules(ProjectType.PESSOAL)}
        isAdmin
        canSeeBudgetHistory={false}
      />,
    );
    expect(
      screen.queryByRole("link", { name: "Histórico de Budget" }),
    ).not.toBeInTheDocument();

    // `isAdmin` sozinho NÃO pode revelar a tela: o convidado de demo nasce
    // role ADMIN (#497) e `isAdmin` do auth-context não checa `isGuest`.
    rerender(
      <DesktopSidebar
        {...props}
        project={{ id: "p1", name: "Casa Nova", type: "REFORMA" }}
        isAdmin
        canSeeBudgetHistory={false}
      />,
    );
    expect(
      screen.queryByRole("link", { name: "Histórico de Budget" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Usuários")).toBeInTheDocument();
  });

  it("uses exact route segments for PLANTAS active state", () => {
    const visibleNav = getProjectNavModules(ProjectType.PLANTAS);
    const plantProps = {
      ...props,
      project: { id: "p1", name: "Minhas plantas", type: ProjectType.PLANTAS },
      visibleNav,
    };
    const activeLabels = () =>
      screen
        .getAllByRole("link")
        .filter((link) => link.getAttribute("aria-current") === "page")
        .map((link) => link.getAttribute("aria-label"));
    const { rerender } = render(
      <DesktopSidebar {...plantProps} pathname={`${basePath}/plants-ai`} />,
    );

    expect(
      screen.getByRole("link", { name: "Diagnóstico IA" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("link", { name: "Minhas Plantas" }),
    ).not.toHaveAttribute("aria-current");
    expect(activeLabels()).toEqual(["Diagnóstico IA"]);

    rerender(
      <DesktopSidebar
        {...plantProps}
        pathname={`${basePath}/plants/plant-1`}
      />,
    );

    expect(
      screen.getByRole("link", { name: "Diagnóstico IA" }),
    ).not.toHaveAttribute("aria-current");
    expect(
      screen.getByRole("link", { name: "Minhas Plantas" }),
    ).toHaveAttribute("aria-current", "page");
    expect(activeLabels()).toEqual(["Minhas Plantas"]);
  });

  it("is collapsed by default and expands only through its explicit accessible toggle", () => {
    const { container } = render(<DesktopSidebar {...props} />);
    const sidebar = container.querySelector("aside");
    const toggle = screen.getByRole("button", {
      name: /expandir menu lateral/i,
    });

    expect(sidebar).not.toHaveClass("hover:w-56");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: /projetos/i })).toHaveAttribute(
      "href",
      "/projects",
    );
    fireEvent.click(screen.getByRole("button", { name: /sair/i }));
    expect(props.onLogout).toHaveBeenCalledTimes(1);
  });

  it("persists toggles and restores the sidebar state", () => {
    const first = render(<DesktopSidebar {...props} />);
    fireEvent.click(
      screen.getByRole("button", { name: /expandir menu lateral/i }),
    );
    expect(localStorage.getItem("lifeone:sidebar:collapsed")).toBe("false");
    first.unmount();

    render(<DesktopSidebar {...props} />);
    expect(
      screen.getByRole("button", { name: /recolher menu lateral/i }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it.each(["not-json", "{"])(
    "falls back to collapsed for malformed storage value %s",
    (value) => {
      localStorage.setItem("lifeone:sidebar:collapsed", value);
      expect(() => render(<DesktopSidebar {...props} />)).not.toThrow();
      expect(
        screen.getByRole("button", { name: /expandir menu lateral/i }),
      ).toHaveAttribute("aria-expanded", "false");
    },
  );

  it("remains usable when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage denied");
    });

    expect(() => render(<DesktopSidebar {...props} />)).not.toThrow();
    const toggle = screen.getByRole("button", {
      name: /expandir menu lateral/i,
    });
    expect(() => fireEvent.click(toggle)).not.toThrow();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });
});
