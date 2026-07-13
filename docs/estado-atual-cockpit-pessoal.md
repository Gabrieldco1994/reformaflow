# Estado Atual — Cockpit/Visão Conta (PESSOAL)

Atualizado em: **2026-07-12**

## 0) Redesign UX 2026-07 — placar das trilhas

- ✅ **Fases A–D + F-parcial** — PRs #75, #77 (design system, despesas mobile, cockpit estrutural, conta/cartões, sidebar).
- ✅ **Trilha 1 — Fase C-visual** (cockpit inovador mobile, protótipo c3) — PR #81.
- ✅ **Trilha 2 — Web analítico D1** (cockpit desktop denso) — PR #82.
- ✅ **Trilha 3 — Fase G** (3 camadas nos módulos + Simulação) — PR #83.
- ✅ **Fidelidade ao protótipo c3** — PR #89 (remove aside duplicada e "valores canônicos", traz "Vai dar até dez?" ao mobile, reordena, Consumo fechado).
- ✅ **Trilha 4 — App mobile** — PR #84 (casca 3 abas + PWA + Lançar + Despesas) e #87 (Maria; o #86 foi mergeado na base errada e resgatado). **QA pós-merge achou 5 bugs pendentes** (Prompt E): navegação até Despesas inexistente, Lançar sem seletor de tipo (cai em OUTROS silencioso), origens de outros projetos no sheet, carteira de cartões ausente, polish (FAB/formatos).
- ✅ **Fase E — Motor único** — PR #88 conforme adendo: `getCaixaConta` público, tenant-financial e cash-flow lendo §10, `motor-unico-parity.spec.ts`, `scripts/validate-motores-prod.mjs`. §10 intocado. **PENDENTE: rodar o script contra prod** (`RF_TOKEN=<jwt> node scripts/validate-motores-prod.mjs`, esperado R$ 63.427,35 nas 4 telas).
- 🔴 **CI E2E vermelho no main**: `monthly-mobile.spec.ts:193` e `expenses-mobile.spec.ts:160` desatualizados pelos merges #84/#89 — merges entraram com CI failure (gate ignorado). Corrigir junto do Prompt E.
- Deploy: web (Vercel) e API (Fly, job `Deploy API to Fly` verde) acompanham o main automaticamente.
- Branches `feat/phase-e-*` antigas (month-aware top) são tentativa SUPERSEDIDA — conteúdo já está no main; não confundir com a Fase E do brief.
- Briefs concluídos arquivados em `docs/archive/redesign-2026-07/`.

## 1) Situação consolidada

O pacote principal do Cockpit PESSOAL está **concluído e em `main`**.

- `1d94e777` — Fase 1: derivação de mês/data de caixa para cartão.
- `56226cf0` — Fase 2: toggle **Gastei / Vai sair**.
- `493e4f72` — Fase 3 + 5: comprometimento futuro + card pessoal.
- `84bb6cdc` — Fase 6: conciliação cross-project por parcela.
- `8129c857` (PR #14) — caixa real (§10) + redesign do topo.

Também há evoluções posteriores da Visão Conta no `main` (filtros, gráficos anuais por origem/cartão, drill-down e ajustes de edição).

### Incremento recente (jul/2026)

- `59a10d90` — **INVESTIMENTOS como neutro-de-consumo.** Aporte (`INVESTIMENTOS`)
  sai do gasto/média/categorias/resultado (não é consumo) mas **permanece no eixo
  de caixa**; resgate (`RESGATE`) sai da receita, mas rendimentos
  (`JUROS_RENDA_FIXA`) seguem como receita real. **Invariante I1 preservado:** o
  "Caixa hoje" da Visão Conta NÃO muda. Ver `docs/visao-conta-faturas.md §10`.
- `52366139` — **Unificação de KPIs + UX (mês/ano) + Visão Conta "Todos".**
  - **Dashboard do mês:** faixa `MovimentoMes` (Entrou · Saiu · Total de saídas +
    ticket) substitui o antigo `MonthKpis` duplicado (ver `docs/cockpit-caixa-real.md §8`).
  - **Extrato de saídas:** vira só a lista, com toggle **Mês/Ano** e filtros de
    **tipo de despesa** e **mês**.
  - **Categorias do ano:** toggle **Realizado / Realizado+planejado** + clique na
    categoria abre pop-up com as despesas consideradas (mesma base das barras).
  - **Árvore de gastos do ano:** resumo no topo, **Expandir/Recolher tudo** e
    ordenação (valor/nome); "Destaques do ano" removido.
  - **Visão Conta (ano):** opção **Todos** lista todas as despesas de todas as
    origens com filtros de tipo e mês (`origin-items-yearly?kind=all`, mesmas
    regras de neutro/mês por origem; total bate com o `totalAno` do gráfico).
- `262940a0` — **Projeção fim do mês usa caixa (§10), não competência.** O card
  "Projeção" mostrava R$ 72 mil (inflado) porque calculava "a pagar" por competência
  sobre as entries — que ignoram planejados sem `cashFlowEntry` (R$ 17.4k em jul).
  Agora vem de `getAccountView` (mesma fonte da Visão Conta): projeção R$ 56.652,82.
  Ver `docs/cockpit-caixa-real.md §9`.
- `8ebb534d`–`42e25258` (#71) — **Topo canônico acompanha o mês selecionado.** A rota
  do navegador conserva `mes=YYYY-MM`, enquanto a consulta ao overview envia
  `month=YYYY-MM`. Os valores rotulados pelo mês usam essa seleção; **Caixa hoje**
  continua sendo o saldo corrente da §10. `projecao` identifica `mes` e `status`
  (`canonical`/`degraded`), e o fallback por competência aparece como estimativa.
- `de9f420d` / `94551610` — **Despesa recorrente (mensal/quinzenal).** Novo botão
  no modal de lançamento gera N despesas planejadas reais (uma por ocorrência),
  entrando em todos os KPIs sem lógica nova. Modo **cross-project** (obra paga pelo
  pessoal) gera par canônica+espelho por ocorrência. Cobre UI, Copilot e voz (tool
  `create_recurring_expense`). Ver `docs/despesa-recorrente.md`.
- `674c64a7` (PR #66) — **Quick wins de despesas — Fase A.** Sugestão de
  categoria por IA no lançamento e ação **Vincular em massa** para despesas
  cross-project no PESSOAL.
- `ac794937` (#67) — **Quick wins de despesas — Fase B mobile.** A tela de despesas
  ganhou resumo compacto **No cartão / À vista** no PESSOAL, filtros e seleção de
  visão em sheet, chips dos filtros ativos, estado refletido na URL e botão flutuante
  para criar despesa.

### Incremento recente (DRE pessoal)

- Endpoint: `GET /projects/:projectId/monthly-overview/dre-overview`
- Tela web: `/projects/[projectId]/dre` (toggle **mensal/anual**)
- Visão mensal: cards de resultado + mini receita × despesa + DRE por eixo (**Competência / Conta Corrente**)
- Visão anual: cards de resumo + gráfico com breakpoint + barras mês a mês + totais anuais
- Invariantes mantidas:
  - neutros (`PAGAMENTO_FATURA_CARTAO`, `MOVIMENTACAO_INTERNA`) fora de despesa/cashflow;
  - compra no cartão projetada para mês de conta via `caixaMonthForCardPurchase`;
  - fatura na Conta Corrente agrupada em linha única por cartão.

## 2) Fontes de verdade

Antes de iniciar qualquer trabalho nessa área, ler:

1. `docs/cockpit-caixa-real.md` (regra §10 e contrato do caixa).
2. `docs/visao-conta-faturas.md` (faturas, neutros, matching, cartão paga cartão).
3. `AGENTS.md` (invariantes, segurança de migration e convenções).

## 3) Checklist rápido para nova sessão (evitar diagnóstico errado)

Executar sempre estes comandos antes de afirmar que algo "falta implementar":

```bash
git --no-pager branch -vv
git --no-pager log --oneline -20
git --no-pager log --oneline --all | grep -E "feat\\(cockpit\\): Fase [1-6]|feat\\(cockpit\\): caixa real"
```

Se houver divergência entre plano antigo/handoff e o git, **o git é a verdade**.

## 4) Escopo aberto (não confundir com regressão)

Itens abaixo podem existir como evolução futura, não como bug do cockpit já entregue:

- melhorias de orçamento/insights;
- automações adicionais de conciliação/importação;
- refinamentos de UX.

## 5) Regra operacional

Se uma próxima sessão alterar status/escopo desta área, atualizar este arquivo no mesmo PR.
