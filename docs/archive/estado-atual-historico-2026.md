# Histórico — Estado Atual do Cockpit PESSOAL (2026)

> Contexto: este arquivo guarda o histórico movido de `docs/estado-atual-cockpit-pessoal.md` quando o documento vivo passou a conter só status operacional.  
> Snapshot-base movido em 2026-07-15 (estado anterior atualizado em 2026-07-14).

## Placar detalhado anterior (redesign UX 2026-07)

- ✅ **Fases A–D + F-parcial** — PRs #75, #77 (design system, despesas mobile, cockpit estrutural, conta/cartões, sidebar).
- ✅ **Trilha 1 — Fase C-visual** (cockpit inovador mobile, protótipo c3) — PR #81.
- ✅ **Trilha 2 — Web analítico D1** (cockpit desktop denso) — PR #82.
- ✅ **Trilha 3 — Fase G** (3 camadas nos módulos + Simulação) — PR #83.
- ✅ **Fidelidade ao protótipo c3** — PR #89 (remove aside duplicada e "valores canônicos", traz "Vai dar até dez?" ao mobile, reordena, Consumo fechado).
- ✅ **Legibilidade mobile pós-QA** — PR #90 (passe v3 de legibilidade no cockpit mobile).
- ✅ **Herói mobile c3 escuro (fidelidade final)** — gradiente `#1D1B17→#26231D`, glow por saúde do mês e narrativa em prosa, preservando números canônicos + toggle + slider + linhas Entrou/Saiu/Projeção em 1 linha (2026-07-13).
- ✅ **Trilha 4 — App mobile** — PR #84 (casca 3 abas + PWA + Lançar + Despesas) e #87 (Maria; o #86 foi mergeado na base errada e resgatado). **QA pós-merge achou 5 bugs — todos RESOLVIDOS no PR #91**: navegação até Despesas (link no Hoje + tab), pill "Maria sugeriu: <tipo>" sempre visível no Lançar (fim do OUTROS silencioso), origens só do projeto atual (conta vs cartão), carteira física de cartões e polish (FAB verde/formatos). Specs E2E reescritos contra a UI enviada.
- ✅ **Navegação contextual do projeto** — PR #93 (nav mobile por projeto).
- ✅ **Skin Minimal mobile PESSOAL** — PR #125: Hoje, Despesas, Maria, Lançar e Mais, sem alterar KPIs, dados ou contratos.
- ✅ **Skin Minimal cross-project — Stage A** (issue #128 / PR #136) — mergeado em `main` no commit `fa927308` e implantado em produção em 2026-07-14. Mudança exclusivamente visual, sem alterações em API, domínio, Prisma, dados ou regras financeiras. Tokens canônicos em `globals.css`; acentos em `type-accent.tsx`; shell `AppShell` com `DesktopSidebar`, `MobileHeader`, `MobileTabBar` e `MaisSheet`. Contrato responsivo: mobile `<768px`, sidebar desktop `>=768px` e copilot desktop `>=1024px`. O épico #127 permanece aberto para #129–#134.
- ✅ **Fase E — Motor único** — PR #88 conforme adendo: `getCaixaConta` público, tenant-financial e cash-flow lendo §10, `motor-unico-parity.spec.ts`, `scripts/validate-motores-prod.mjs`. §10 intocado. **PENDENTE no snapshot:** rodar o script contra prod (`RF_TOKEN=<jwt> node scripts/validate-motores-prod.mjs`, esperado R$ 63.427,35 nas 4 telas).
- ✅ **CI E2E do main** — resolvido no PR #91: os specs mobile (`monthly-mobile.spec.ts`, `expenses-mobile.spec.ts`) foram reescritos contra a UI das Trilhas 3/4; suíte verde (Domain 181 · API 455 · Web unit 473 · E2E 21 pass / 13 skip).
- 🔎 **Auditoria técnica 2026-07-13** (architect + QA, main @ a62d064f): baseline verde (1.130 testes, 0 falhas), mas ficaram abertas — **#94** (§10 elege conta primária por literal `3636`, CRITICAL), **#95** (paridade em prod não validada + validador fora do CI), **#96** (cash-flow não ancora no `openingBalance` do §10), **#97** (`motor-unico-parity.spec` com claim falso/tautológico) e **#98** (feature-gating em 4 mapas divergentes).
- Deploy: web (Vercel) e API (Fly, job `Deploy API to Fly` verde) acompanham o main automaticamente.
- Branches `feat/phase-e-*` antigas (month-aware top) são tentativa supersedida — conteúdo já está no main; não confundir com a Fase E do brief.
- Briefs concluídos arquivados em `docs/archive/redesign-2026-07/`.

## Situação consolidada (snapshot anterior)

O pacote principal do Cockpit PESSOAL estava concluído e em `main`:

- `1d94e777` — Fase 1: derivação de mês/data de caixa para cartão.
- `56226cf0` — Fase 2: toggle **Gastei / Vai sair**.
- `493e4f72` — Fase 3 + 5: comprometimento futuro + card pessoal.
- `84bb6cdc` — Fase 6: conciliação cross-project por parcela.
- `8129c857` (PR #14) — caixa real (§10) + redesign do topo.

Também havia evoluções posteriores da Visão Conta no `main` (filtros, gráficos anuais por origem/cartão, drill-down e ajustes de edição).

## Incrementos recentes (jul/2026)

- `59a10d90` — **INVESTIMENTOS como neutro-de-consumo.** Aporte (`INVESTIMENTOS`) sai do gasto/média/categorias/resultado (não é consumo), mas permanece no eixo de caixa; resgate (`RESGATE`) sai da receita, e rendimentos (`JUROS_RENDA_FIXA`) seguem como receita real.
- `52366139` — **Unificação de KPIs + UX (mês/ano) + Visão Conta "Todos".**
  - Dashboard do mês: `MovimentoMes` substitui `MonthKpis`.
  - Extrato de saídas: vira lista com toggle **Mês/Ano** e filtros de tipo/mês.
  - Categorias do ano: toggle **Realizado / Realizado+planejado** + pop-up por categoria.
  - Árvore de gastos do ano: resumo, **Expandir/Recolher tudo** e ordenação.
  - Visão Conta (ano): opção **Todos** com `origin-items-yearly?kind=all`.
- `262940a0` — **Projeção fim do mês usa caixa (§10), não competência.**
- `8ebb534d`–`42e25258` (#71) — topo canônico acompanha o mês selecionado (`mes` na URL, `month` na API).
- `de9f420d` / `94551610` — despesa recorrente mensal/quinzenal (inclui modo cross-project).
- `674c64a7` (PR #66) — quick wins de despesas, Fase A.
- `ac794937` (#67) — quick wins de despesas, Fase B mobile.

## Incremento recente (DRE pessoal)

- Endpoint: `GET /projects/:projectId/monthly-overview/dre-overview`.
- Tela web: `/projects/[projectId]/dre` (toggle mensal/anual).
- Visão mensal: cards de resultado + mini receita × despesa + DRE por eixo.
- Visão anual: cards de resumo + gráfico com breakpoint + barras mês a mês + totais anuais.
- Regras normativas desse bloco (neutros, mês de caixa de cartão, agrupamento de faturas por cartão) foram movidas para o CONTRATO de `docs/visao-conta-faturas.md`.
