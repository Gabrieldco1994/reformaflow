# Estado Atual — Cockpit/Visão Conta (PESSOAL)

Atualizado em: **2026-07-15**

Histórico detalhado: `docs/archive/estado-atual-historico-2026.md`.

## 0) Placar das trilhas (estado vivo no main)

- ✅ Fases A–D + F/G (redesign UX + cockpit/mobile/web) concluídas em `main`.
- ✅ Fase E (motor único + caixa real §10) concluída e ativa; pendência operacional de validação em prod segue no issue #95.
- ✅ Skin Minimal mobile PESSOAL (PR #125) e Stage A cross-project (PR #136) em produção.
- ✅ Auditoria técnica abriu #94/#95/#96/#97/#98; continuam como trilhas de evolução (não regressão do entregue).
- ✅ PR #145 (spec review/arquivamento) mergeado em `main` em 2026-07-15.
- 🚀 Deploy web (Vercel) e API (Fly) continuam automáticos pelo `main`.

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
