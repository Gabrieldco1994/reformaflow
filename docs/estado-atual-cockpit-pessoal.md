# Estado Atual — Cockpit/Visão Conta (PESSOAL)

Atualizado em: **2026-06-25**

## 1) Situação consolidada

O pacote principal do Cockpit PESSOAL está **concluído e em `main`**.

- `1d94e777` — Fase 1: derivação de mês/data de caixa para cartão.
- `56226cf0` — Fase 2: toggle **Gastei / Vai sair**.
- `493e4f72` — Fase 3 + 5: comprometimento futuro + card pessoal.
- `84bb6cdc` — Fase 6: conciliação cross-project por parcela.
- `8129c857` (PR #14) — caixa real (§10) + redesign do topo.

Também há evoluções posteriores da Visão Conta no `main` (filtros, gráficos anuais por origem/cartão, drill-down e ajustes de edição).

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
