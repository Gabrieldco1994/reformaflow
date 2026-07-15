# docs — índice

Fonte de verdade do projeto. Leitura obrigatória no início de sessão está em `AGENTS.md` (raiz).

## Formato padrão dos docs normativos

Para docs de regra (ex.: caixa, faturas, quitação, recorrência), usar sempre:

1. `## CONTRATO (normativo — o que nunca pode quebrar)` — definições, fórmulas, invariantes, tabelas de decisão.
2. `## Referência de implementação` — arquivos, funções, endpoints e testes que blindam o contrato.
3. `## Apêndice histórico` — contexto da evolução, incidentes, commits e validações datadas.

Regra: o CONTRATO é atemporal e não carrega narrativa de "antes/depois". Histórico vai para o apêndice.

| Doc | Assunto |
|---|---|
| `estado-atual-cockpit-pessoal.md` | Status/escopo real do Cockpit PESSOAL (fonte de verdade de status). |
| `cockpit-caixa-real.md` | Regras do caixa real (§10) e do consolidado. |
| `visao-conta-faturas.md` | Visão Conta, faturas de cartão, neutros, casamento pagamento→fatura, "cartão paga cartão". |
| `saas-onboarding.md` | Autocadastro SaaS, objetivos, permissões, papéis e criação do primeiro projeto. |
| `quitacao-parcela-cross-project.md` | Quitação de parcela cross-project (PESSOAL): bug-raiz do "sumiço", fluxo espelho+conciliar, invariantes P1–P7/E5/E8, UI e validação. |
| `manual-do-aplicativo.md` | Manual do usuário: comportamento observável por tela + conceitos-chave e glossário (não normativo para regras — estas vivem nos docs acima). |
| `despesa-recorrente.md` | Despesa recorrente (mensal/quinzenal): gera N despesas planejadas reais; modo cross-project (obra+espelho); canais UI/Copilot/voz; API e validação. |
| `archive/estado-atual-historico-2026.md` | Histórico detalhado movido do estado-atual do cockpit (incrementos/commits de 2026). |
| `archive/` | Notas históricas de sessões anteriores (não normativas) — ver `archive/README.md`. |

Ferramentas de apoio (não-app): `tools/financial-analysis/` (reconciliação de caixa via `reconcile.py`).
