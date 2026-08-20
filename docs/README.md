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
| `quitacao-parcela-cross-project.md` | Quitação de parcela cross-project (PESSOAL): bug-raiz do "sumiço", fluxo espelho+conciliar, invariantes P1–P7/E5/E8, UI e validação; §10 cobre o contrato read-only de origem exibida no alvo (`GET .../expenses/paid-origins`, O1–O12). |
| [`financeiro-projetos-por-tipo.md`](financeiro-projetos-por-tipo.md) | Financeiro por tipo de projeto (spec U6a #455): matriz capacidade/origem-finalidade/identidade/ACL/deep-link, as tres fontes distintas (`PROJECT_FEATURES`, `TYPE_MODULES`, `PROJECT_NAV`), divergencias codigo x doc e decisoes abertas do PO. **Proposta; nao normativo ate aprovacao.** |
| `manual-do-aplicativo.md` | Manual do usuário: comportamento observável por tela + conceitos-chave e glossário (não normativo para regras — estas vivem nos docs acima). |
| `despesa-recorrente.md` | Despesa recorrente (mensal/quinzenal): gera N despesas planejadas reais; modo cross-project (obra+espelho); canais UI/Copilot/voz; API e validação. |
| `politica-datas-timezone.md` | Política de datas e fronteira de timezone (BRT×UTC) nas telas financeiras. |
| [`experiencia-mobile-pwa.md`](experiencia-mobile-pwa.md) | Contrato transversal da experiência responsiva/PWA em `apps/web`: 375/390, toque, instalação, offline/update, permissões e fallback. |
| [`maria-ia.md`](maria-ia.md) | Promessa cross-channel da Maria, confirmação de escrita, tools, OCR/voz/TTS, privacidade e gates de eval. |
| [`landscape-agentes-skills-saas.md`](landscape-agentes-skills-saas.md) | Mapa canônico de agentes, skills e ownership das experiências; inclui prioridades e procedimento de revisão. |
| [`plano-centro-financeiro-sdd.md`](plano-centro-financeiro-sdd.md) | SDD canônico do programa #436: **planejamento aprovado; B0 (#447) entregue e CLOSED; B1a mergeado em `main`; #448 (B1b) e W1 (#214) abertos; B2 (#449) não iniciado; S0.3 test-only em andamento**; decisões, contratos, ondas E0–E6, dependências, riscos e changelog. |
| `archive/estado-atual-historico-2026.md` | Histórico detalhado movido do estado-atual do cockpit (incrementos/commits de 2026). |
| `archive/` | Notas históricas de sessões anteriores (não normativas) — ver `archive/README.md`. |

## Planejamento vigente e planos históricos

O SDD do Centro Financeiro é a fonte do planejamento futuro aprovado. Planos anteriores permanecem
versionados para contexto, mas seus ledgers congelados não representam o estado atual nem governam
novas execuções.

| Plano | Status | Assunto |
|---|---|---|
| [`plano-centro-financeiro-sdd.md`](plano-centro-financeiro-sdd.md) | 📋 **Aprovado; B0 entregue e CLOSED; B1a mergeado; B1b/W1 abertos; B2 não iniciado; S0.3 test-only em andamento** | Programa #436 — Centro Financeiro multi-tenant e base agent-first. |
| [`plano-visao-conta-hub-2026-07.md`](plano-visao-conta-hub-2026-07.md) | 🗃️ **Histórico (v1)** | Registro do ciclo Visão Conta Hub; conferir comportamento entregue nos docs vivos. |
| [`plano-ux-v2-2026-07.md`](plano-ux-v2-2026-07.md) | 🗃️ **Histórico (v2; ledger stale)** | Registro do ciclo de redução de trabalho; não é roadmap ativo. |

Ferramentas de apoio (não-app): `tools/financial-analysis/` (reconciliação de caixa via `reconcile.py`).

**Status E0/E1 em 2026-08-19:** **B0 (#447) foi entregue via PR #476 (produção) e o issue está
CLOSED.** E0/#437 permanece incompleta pelo seu próprio gate de inventário de produção (#445,
`NOT_COLLECTED`); isso não desfaz a entrega de B0. A produção de #445 nunca deve ser interpretada
como zero: código, histórico e as 63 migrations commitadas até `20260810234344` indicam somente
estado esperado, não dados de runtime ou migrations aplicadas. **B1a foi mergeado em `main`
(`5bbe5d69` #477, `720ff1fc` #478, `890b89b0` #479); #448 permanece OPEN pela fatia B1b, e W1 (#214)
segue aberto. B2 (#449) não foi iniciado.**
