# Estado Atual — Cockpit/Visão Conta (PESSOAL)

Atualizado em: **2026-07-20**

Histórico detalhado: `docs/archive/estado-atual-historico-2026.md`.

## 0) Placar das trilhas (estado vivo no main)

- ✅ UX v2 W1 estabilizado (`feat/ux-v2-w1-pendencias` / PR #220): fila "Precisa de você" com roteamento correto (vincular/quitar/pagar/editar), sem 404.
- 🚧 UX v2 W2 em execução (`feat/ux-v2-w2-categorias`): confirmar categoria com aprendizado de regra manual, proteção PIX PF, auto-aplicação no ingest para regra manual e gestão de regras atrás de engrenagem em Análises.
- ✅ Fases A–D + F/G (redesign UX + cockpit/mobile/web) concluídas em `main`.
- ✅ Fase E (motor único + caixa real §10) concluída e ativa; pendência operacional de validação em prod segue no issue #95.
- ✅ Skin Minimal mobile PESSOAL (PR #125) e Stage A cross-project (PR #136) em produção.
- ✅ Auditoria técnica abriu #94/#95/#96/#97/#98; continuam como trilhas de evolução (não regressão do entregue).
- ✅ PR #145 (spec review/arquivamento) mergeado em `main` em 2026-07-15.
- ✅ **PR-1 mobile row** (fix B1): layout legível em 375px, valor nowrap, status textual — mergeado via PR #202 em 2026-07-20.
- ✅ **PR-2 backend Carteira**: `getAccountView` emite `origem:{tipo:'carteira'}` para saídas sem cartão/conta; `saiuMes`/`faltaPagar` incluem carteira — mergeado via PR #202 em 2026-07-20.
- 🚀 **PR-2 frontend Carteira** (este PR, `feat/conta-pr2-carteira-fechamento`): chip "Sem conta", filtro, nota no card — pendente merge.
- 🔧 PR-3 (projeção unificada no Cockpit) e PR-4 (navegação/bottom nav) pendentes.
- 🚀 Deploy web (Vercel) e API (Fly) continuam automáticos pelo `main`.
- 🚧 PR-3 em execução (`feat/conta-pr3-projecao-unificada`): narrativa de projeção
  unificada entre Cockpit e Conta (Conta vira resumo com deep-link para Cockpit;
  Cockpit exibe o mesmo veredito de horizonte multi-mês).
- 🔧 PR #174 (draft, `feat/conta-unificada`): Visão Conta unificada (Lista + Por
  categoria/projeto, filtros com "Limpar filtros", expandir fatura inline) e
  lançamento mobile "+" em 3 modos (Escrito categoria-first / Voz / Foto).
  Backend read-only/aditivo (receipt persiste `descricao`; sem migration).
- ✅ PR-1 (linha mobile da Conta) e PR-2 (Carteira backend/frontend) entregues no
  ciclo Visão Conta Hub; fechamento frontend da Carteira consolidado no PR #204.
- ▶ PR-3 (`feat/conta-pr3-projecao-unificada`, PR #205) e PR-4 (`feat/conta-pr4-nav-actions`, PR #207)
  em revisão: narrativa única de projeção entre Conta/Cockpit e migração de navegação
  para Conta como hub.

## 2) Fontes de verdade

Antes de iniciar qualquer trabalho nessa área, ler:

1. `docs/cockpit-caixa-real.md` (contrato do caixa real §10).
2. `docs/visao-conta-faturas.md` (faturas, neutros, matching e quitação explícita).
3. `AGENTS.md` (regras operacionais e convenções de execução).

## 3) Checklist rápido para nova sessão (evitar diagnóstico errado)

```bash
git --no-pager branch -vv
git --no-pager log --oneline -20
git --no-pager log --oneline --all | grep -E "feat\\(cockpit\\): Fase [1-6]|feat\\(cockpit\\): caixa real"
```

Se houver divergência entre handoff/plano antigo e git, **o git é a verdade**.

## 4) Escopo aberto (não confundir com regressão)

- robustez/observabilidade do motor financeiro em produção;
- melhorias de orçamento/insights e automações de conciliação/importação;
- refinamentos de UX não bloqueantes.

## 5) Regra operacional

Se uma próxima sessão alterar status/escopo desta área, atualizar este arquivo no mesmo PR.
