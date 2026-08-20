"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  Compass,
  FolderKanban,
  Settings,
  LogOut,
  Users,
} from "lucide-react";
import { buildNavGroups, type ProjectType } from "@reformaflow/domain";
import { NotificationsBell } from "@/components/notifications/NotificationsBell";
import { FeedbackButton } from "@/components/feedback/FeedbackButton";
import { TypeIcon } from "../../_components/type-accent";
import { isPathActive } from "./mobile-nav";
import { buildNavHref } from "../_lib/nav-href";
import { navIcon } from "./nav-icons";
import { navHintText, SidebarNavHint, useSidebarNavHint } from "./sidebar-nav-hint";
import type { NavModule, ProjectInfo } from "../_types";

const SIDEBAR_STORAGE_KEY = "lifeone:sidebar:collapsed";

interface DesktopSidebarProps {
  project: ProjectInfo;
  basePath: string;
  pathname: string;
  visibleNav: NavModule[];
  isAdmin: boolean;
  /**
   * #504 — descoberta do histórico congelado de Alocação de Budget.
   *
   * Obrigatória (não opcional com default) de propósito: o defeito que esta
   * issue conserta foi um ponto de entrada que sumiu em silêncio. Sendo
   * obrigatória, esquecer de passá-la quebra o `tsc`, não a produção.
   * Vem pronta de `canSeeBudgetAllocationEntryPoint`; NÃO derive de `isAdmin`,
   * que não checa `isGuest`.
   */
  canSeeBudgetHistory: boolean;
  userName?: string;
  /** Query atual (sem `?`) p/ preservar o contexto compartilhado (`?mes`). */
  search?: string;
  onLogout: () => void;
}

/**
 * O agrupamento vive em `@reformaflow/domain` (`buildNavGroups`), não aqui.
 *
 * Antes existia neste arquivo uma `buildDesktopNavGroups` com um literal
 * `projectType !== "PESSOAL"` e listas fixas de slug. Ela DESCARTAVA EM
 * SILÊNCIO todo slug fora das listas: `expenses` e `receipts` estavam em
 * `PROJECT_NAV[PESSOAL]` e sumiram do menu desktop sem ninguém notar. A versão
 * do domínio faz partição TOTAL — um slug novo aparece em "Módulos" em vez de
 * evaporar — e é testável sem montar React.
 */
export function DesktopSidebar({
  project,
  basePath,
  pathname,
  visibleNav,
  isAdmin,
  canSeeBudgetHistory,
  userName,
  search = "",
  onLogout,
}: DesktopSidebarProps) {
  const [collapsed, setCollapsed] = useState(true);
  const { hint, hintProps } = useSidebarNavHint();

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
      if (stored === "true" || stored === "false")
        setCollapsed(stored === "true");
    } catch {
      // The default collapsed state remains usable without storage.
    }
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
      } catch {}
      return next;
    });
  };
  const labelClass = collapsed ? "sr-only" : "whitespace-nowrap truncate";
  const itemClass = `minimal-sidebar-item flex min-h-11 items-center rounded-[14px] text-sm font-medium transition-colors ${collapsed ? "justify-center px-2" : "gap-3 px-3"}`;
  const adminHref = "/admin/users";
  const isAdminActive = isPathActive(pathname, adminHref);
  const settingsHref = "/settings";
  const apoioHref = `${basePath}/apoio`;
  const isApoioActive = isPathActive(pathname, apoioHref);
  const budgetHistoryHref = `${basePath}/budget-allocation`;
  const isBudgetHistoryActive = isPathActive(pathname, budgetHistoryHref);
  const navGroups = useMemo(
    () => buildNavGroups(project.type as ProjectType, visibleNav),
    [project.type, visibleNav],
  );

  return (
    <aside
      className={`minimal-sidebar relative hidden flex-col border-r transition-[width] duration-200 md:flex ${collapsed ? "w-16" : "w-56"}`}
    >
      <div className="minimal-sidebar-header border-b p-2">
        <div
          className={`flex items-center ${collapsed ? "flex-col" : "justify-between"}`}
        >
          {/*
            U1 (#450) — "Projetos" é DESTINO ANCORADO, não o quarto item da
            lista de módulos (saída (i) do PO).

            Hoje/Movimentações/Planejamento são lugares DENTRO do projeto;
            Projetos SAI dele — níveis diferentes de navegação. O próprio
            código já reconhecia isso ao chamar este link de "Voltar para
            projetos". Criar o item na lista produziria DUAS entradas para o
            mesmo destino, e o medido é que ele cairia ~279px abaixo da dobra
            num rail de 64px, sem rótulo. A ordem do contrato continua
            Hoje → Movimentações → Planejamento → Projetos; o que muda é a
            leitura espacial.

            Ícone: `FolderKanban` é o glifo que o próprio app já usa para a
            noção genérica de "Projeto" (`_components/type-accent.tsx`,
            FALLBACK com label 'Projeto') — reuso de vocabulário, não invenção.
            Ele não é direcional (o ponto todo é parar de ler como "voltar") e
            não colide com `LayoutDashboard`, o glifo do módulo Dashboard que
            aparece poucas linhas abaixo no mesmo rail em REFORMA/COMPRA/
            CASA/CARRO — `LayoutGrid` colidiria.
          */}
          <Link
            href="/projects"
            aria-label="Projetos"
            data-nav-group="projetos"
            data-nav-tier="primary"
            className="minimal-sidebar-control flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-[14px] transition-colors"
            {...hintProps("projetos", navHintText("Projetos", "Projetos"))}
          >
            <FolderKanban className="h-5 w-5 shrink-0" />
            <span className={labelClass}>Projetos</span>
          </Link>
          <NotificationsBell
            variant="light"
            className="minimal-sidebar-control min-h-11 min-w-11 rounded-[14px]"
          />
          <FeedbackButton
            variant="light"
            className="minimal-sidebar-control min-h-11 min-w-11 rounded-[14px]"
          />
        </div>
        <div
          className={`mt-1 flex min-h-11 items-center ${collapsed ? "justify-center" : "gap-2 px-2"}`}
          title={project.name}
        >
          <span className="minimal-sidebar-project-mark flex h-9 w-9 shrink-0 items-center justify-center rounded-[14px]">
            <TypeIcon type={project.type} className="h-5 w-5" />
          </span>
          <span
            className={`font-geist text-[15px] font-semibold ${labelClass}`}
          >
            {project.name}
          </span>
        </div>
      </div>

      {/*
        #504 — a `<nav>` inteira era `flex-1 overflow-y-auto`, então os itens
        utilitários/administrativos do fim (Apoio, Configurações, Usuários)
        rolavam junto com os módulos. Medido em runtime a 1440x900 num PESSOAL
        de ADMIN (nav scrollHeight 769 > clientHeight 659): "Usuários" caía em
        y=826 com a nav terminando em 768 — `elementFromPoint` no centro dele
        devolvia o rodapé, ou seja, o link JÁ existia sem ser clicável.

        Agora a nav é uma coluna: só a lista de módulos rola; o cluster
        utilitário fica ancorado e sempre alcançável. Sem isso, devolver o
        ponto de entrada do histórico de budget seria devolvê-lo para debaixo
        do tapete — e ainda empurraria "Usuários" para ainda mais longe.
      */}
      <nav className="flex min-h-0 flex-1 flex-col p-2">
        {/*
          U1 (#450) — recolhido, a régua de 1px SUBSTITUI o respiro entre
          grupos em vez de somar a ele: `space-y-1` (4+1+4 = 9px por fronteira)
          contra os 8px de hoje sem régua nenhuma. Assim o agrupamento não
          custa altura — e altura é exatamente o recurso que falta aqui
          (medido: 672px de conteúdo contra 297–377px de recorte). Manter
          `space-y-2` daria 17px por fronteira, +36px no total, e empurraria
          "Planejamento" para baixo da dobra em mais um caso medido.
          Expandido, o rótulo do grupo já separa e o respiro maior volta.
        */}
        <div
          className={`min-h-0 flex-1 overflow-y-auto ${collapsed ? "space-y-1" : "space-y-2"}`}
        >
          {navGroups.map((group, index) => (
            <Fragment key={group.id}>
              {/*
                U1 (#450), opção (B) do PO — o rail continua NASCENDO
                RECOLHIDO, então os grupos precisam ser distinguíveis sem
                expandir. `h-px`: uma linha grossa comeria orçamento vertical
                que este rail não tem (medido: cada régua custa ~9px com o gap,
                ~36px no total em PESSOAL). Fica ENTRE grupos (n-1): antes do
                primeiro seria linha órfã colada no cabeçalho e depois do
                último desenharia um segundo rodapé falso. Expandido, o rótulo
                do grupo já faz a separação e a régua vira ruído.
                `aria-hidden` porque o nome do grupo já é exposto pelo
                `role="group"` abaixo — a régua é decoração para quem enxerga.
              */}
              {collapsed && index > 0 && (
                <hr
                  data-nav-separator="true"
                  aria-hidden="true"
                  className="minimal-sidebar-group-rule mx-auto h-px w-6 border-0"
                />
              )}
              <div
                role="group"
                aria-label={group.label}
                data-nav-group={group.id}
                data-nav-tier={group.tier}
                className="space-y-1"
              >
                {!collapsed && navGroups.length > 1 && (
                  <p className="px-3 pb-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-lifeone-ink-4">
                    {group.label}
                  </p>
                )}
                {group.items.map((item) => {
                  const pathHref = `${basePath}/${item.slug}`;
                  const isActive = isPathActive(pathname, pathHref);
                  const Icon = navIcon(item.iconName);
                  return (
                    <Link
                      key={item.slug}
                      // pathHref (sem query) governa o ativo; linkHref carrega `?mes`.
                      href={buildNavHref(pathHref, search)}
                      // Sem `title`: a dica própria (elemento no DOM, com o
                      // nome do grupo) substitui a nativa. Manter as duas faria
                      // o navegador pintar a nativa atrasada por cima.
                      aria-label={item.label}
                      aria-current={isActive ? "page" : undefined}
                      className={itemClass}
                      {...hintProps(item.slug, navHintText(group.label, item.label))}
                    >
                      <Icon className="minimal-sidebar-icon h-5 w-5 shrink-0" />
                      <span className={labelClass}>{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </Fragment>
          ))}
        </div>
        <div className="minimal-sidebar-footer mt-1 shrink-0 space-y-1 border-t pt-1">
          <Link
            href={buildNavHref(apoioHref, search)}
            title="Apoio"
            aria-label="Apoio"
            aria-current={isApoioActive ? "page" : undefined}
            className={itemClass}
          >
            <Compass className="minimal-sidebar-icon h-5 w-5 shrink-0" />
            <span className={labelClass}>Apoio</span>
          </Link>
          {!isAdmin && (
            <Link
              href={settingsHref}
              title="Configurações"
              aria-label="Configurações"
              className={`${itemClass} text-lifeone-ink-2 hover:bg-white/70`}
            >
              <Settings className="h-5 w-5 shrink-0 text-lifeone-ink-3" />
              <span className={labelClass}>Configurações</span>
            </Link>
          )}
          {canSeeBudgetHistory && (
            <Link
              href={buildNavHref(budgetHistoryHref, search)}
              title="Histórico de Budget"
              aria-label="Histórico de Budget"
              aria-current={isBudgetHistoryActive ? "page" : undefined}
              data-testid="sidebar-budget-history"
              className={itemClass}
            >
              <Archive className="minimal-sidebar-icon h-5 w-5 shrink-0" />
              <span className={labelClass}>Histórico de Budget</span>
            </Link>
          )}
          {isAdmin && (
            <Link
              href={adminHref}
              title="Usuários"
              aria-label="Usuários"
              aria-current={isAdminActive ? "page" : undefined}
              className={itemClass}
            >
              <Users className="minimal-sidebar-icon h-5 w-5 shrink-0" />
              <span className={labelClass}>Usuários</span>
            </Link>
          )}
        </div>
      </nav>

      <div className="minimal-sidebar-footer space-y-1 border-t p-2">
        {userName && (
          <button
            type="button"
            onClick={onLogout}
            title={`Sair (${userName})`}
            aria-label={`Sair (${userName})`}
            className={`minimal-sidebar-control w-full ${itemClass}`}
          >
            <LogOut className="h-5 w-5 shrink-0" />
            <span className={labelClass}>Sair ({userName})</span>
          </button>
        )}
        {!collapsed && (
          <div className="px-3 pt-1 text-[10px] uppercase tracking-[0.2em] text-lifeone-ink-4">
            v0.2.0
          </div>
        )}
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={
            collapsed ? "Expandir menu lateral" : "Recolher menu lateral"
          }
          title={collapsed ? "Expandir menu lateral" : "Recolher menu lateral"}
          className={`minimal-sidebar-control flex min-h-11 w-full items-center rounded-[14px] transition-colors ${collapsed ? "justify-center" : "gap-3 px-3"}`}
        >
          {collapsed ? (
            <ChevronRight className="h-5 w-5" />
          ) : (
            <ChevronLeft className="h-5 w-5" />
          )}
          <span className={labelClass}>
            {collapsed ? "Expandir" : "Recolher"}
          </span>
        </button>
      </div>

      <SidebarNavHint hint={hint} />
    </aside>
  );
}
