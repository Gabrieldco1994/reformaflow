# Plano Mestre — Visão Conta como Hub Financeiro do PESSOAL

**Data:** 2026-07-19 · **Status:** aprovado pelo product owner (Gabriel) · **Origem:** análise de UX ao vivo em produção (desktop 1280px + mobile 375px, usuário real)
**Documento-alvo para:** agentes de arquitetura, dev (backend/frontend), QA e documentação.

---

## 0. Contexto e decisões de produto (não renegociar sem o PO)

A análise de UX confirmou a tese de unificação: a **Visão Conta** (`/conta`) é a linha do tempo única de entradas/saídas e deve se tornar o hub do dia a dia, seguindo o modelo mental do usuário ("o que entrou e saiu da minha conta"), como fazem Nubank, Organizze, Mobills e Copilot Money. As telas **Despesas** e **Recebimentos** não morrem: viram **drill-downs analíticos** acessados de dentro da Conta, e saem da navegação primária.

Decisões fechadas:

| # | Decisão |
|---|---------|
| D1 | Visão Conta é o hub de movimentações. Despesas/Recebimentos viram drill-downs (rotas continuam existindo). |
| D2 | Bottom nav mobile alvo: **Cockpit · Conta · [+] · Maria · Cartões** ("Conta" substitui "Despesas"). |
| D3 | "Conta" e "Cartões" na navegação são **visões de dados** (`/conta`, `/credit-cards`), nunca cadastro. Cadastro (conta bancária/cartão) fica atrás de "gerenciar"/engrenagem dentro da tela de dados + empty-state com CTA. |
| D4 | A projeção multi-mês ("Vai dar até dez?") **mora no Cockpit** — mobile E desktop (hoje só existe na Conta; o Cockpit desktop não a tem). Na Conta fica uma linha-resumo com link. Narrativa única: Cockpit e Conta nunca podem se contradizer sobre a saúde do mês/horizonte. |
| D5 | Movimentos sem cartão/conta corrente entram na Conta via pseudo-conta **"Carteira" (sem conta)**: chip discreto e clicável na linha ("de onde saiu esse pagamento?" → conciliação), opção "Sem conta/Carteira" no filtro de origens, e **inclusão nos totais** dos cards de cima ("Saiu no mês", "Ainda falta pagar"). Sem isso, a Conta conta uma história incompleta e "some dinheiro" para quem vinha de Despesas. |
| D6 | Ações do topo da Conta: "Vincular em massa" e "Planejar recebimentos" saem do topo (menu ⋯ / FAB). "Nova Despesa" + "Nova Receita" viram um único **"+ Lançar"** com o tipo escolhido dentro do fluxo. |
| D7 | Rótulos caixa × competência sempre explícitos: "Saiu no mês" (caixa, Conta) ≠ "Gasto no mês" (competência, Despesas/DRE). Toda tela por competência ganha rótulo/tooltip dizendo isso. |
| D8 | Menu desktop alvo (~5 grupos): **Cockpit · Conta · Cartões · Planejamento** (Metas + Planning + Alocação Budget) **· Análises** (DRE + Fluxo de Caixa + Neutros). |

Bugs confirmados na inspeção (entram no escopo):

- **B1 (mobile 375px, Conta):** linhas de movimentação truncam a descrição para ~6 caracteres ("Infra…", "PIX TR…"); o badge circular "Paga" é gigante e **sobrepõe o chip de projeto**; o valor divide a largura da linha com elementos variáveis — viola a Regra de Ouro nº 13 do `CLAUDE.md`.
- **B2 (narrativa contraditória):** Cockpit diz "No caminho / Mês protegido — julho fecha em R$ 68 mil" enquanto a Conta, no mesmo mês, diz "saldo fica negativo em setembro, pior ponto -R$ 77 mil em dezembro".
- **B3 (nav mobile):** a Visão Conta não está na bottom nav; "Despesas" (tela a rebaixar) está.

---

## 1. Fatiamento em 4 entregas (1 PR cada, nesta ordem)

A ordem é deliberada: a Conta só pode assumir o lugar de Despesas na navegação (PR-4) depois de mostrar 100% do dinheiro (PR-2) e de estar impecável no mobile (PR-1).

```
PR-1  Lista mobile da Conta (fix B1)          — só frontend
PR-2  "Sem conta / Carteira" na Conta (D5)    — backend + frontend
PR-3  Projeção unificada no Cockpit (D4, B2)  — backend leve + frontend
PR-4  Navegação + ações (D1,D2,D3,D6,D8, B3)  — frontend + docs pesada
```

D7 (rótulos) é transversal: cada PR ajusta os rótulos das telas que tocar.

---

## 2. PR-1 — Lista de movimentações legível no mobile

**Objetivo:** nenhuma informação da linha ilegível/sobreposta em 375px.

**Arquivos:**
- `apps/web/src/app/projects/[projectId]/conta/_components/MovimentacaoRow.tsx` (+ `MovimentacaoRow.test.tsx`)
- `apps/web/src/app/projects/[projectId]/conta/_components/MovimentacoesSection.tsx`

**Especificação de layout (por linha, mobile-first):**
- Linha 1: descrição (1 linha, `truncate` tardio — ocupa toda a largura restante) + **valor `nowrap` à direita** (≥15px), nada mais na linha do valor.
- Linha 2: metadados `data · categoria · conta` (≥11px, cor secundária) + chip de projeto quando cross-project.
- Status ("Paga" / "A pagar" / "Previsto" / "Recebido"): texto pequeno colorido **sob o valor**, alinhado à direita — elimina o badge circular gigante.
- Alvos de toque ≥44px; o menu "⋯" permanece.
- Desktop mantém densidade atual (o componente vira responsivo, não fork).

**Critérios de aceite:**
1. Em 375px, descrição exibe ≥20 caracteres antes do ellipsis em linhas típicas.
2. Nenhuma sobreposição chip×badge em nenhuma combinação (com/sem projeto, com/sem categoria, valores de 7 dígitos).
3. Piso tipográfico: nada <11px; valor ≥15px; toque ≥44px.
4. Testes de `MovimentacaoRow.test.tsx` atualizados cobrindo as 4 variantes de status e a variante cross-project.

**Agentes:** `frontend-expert` (implementa) → `qa-engineer` (testes + revisão) → **QA visual obrigatória** (§7). `architect` dispensado (mudança local, sem contrato novo). `pessoal-lens` Phase 2 no diff.

---

## 3. PR-2 — Pseudo-conta "Carteira" (sem conta) na Visão Conta

**Objetivo:** todo movimento do mês aparece na Conta e nos totais, mesmo sem vínculo com cartão/conta corrente. É o pré-requisito da unificação (D5).

### 3.1 Backend

**Arquivos:**
- `apps/api/src/monthly-overview/monthly-overview.service.ts` — `getAccountView` (a partir da linha ~240). Ponto crítico: hoje o "foreign sem espelho" com `origem: 'none'` (~linha 816) é descartado ou tratado à parte — é exatamente o buraco a fechar.
- `apps/api/src/monthly-overview/monthly-overview.account-view.spec.ts` (+ `caixa-conta.spec.ts`, `get-caixa-conta.spec.ts` se os totais mudarem).

**Contrato (proposta para o architect validar):**
- `AccountViewResponse.movimentacoes[]` ganha origem `{ tipo: 'carteira' }` além de `card`/`bank`; nenhuma movimentação do mês fica fora da lista.
- `origens[]`/filtros ganham a entrada sintética `carteira` (label "Sem conta"), sem criar registro em `BankAccount` — **é agregação, não modelo novo** (zero migration; se o architect concluir que precisa de modelo, parar e reavaliar com o PO).
- Totais (`saiu`, `aindaFaltaPagar`, `sobraPrevista`) passam a incluir os itens carteira. **Atenção dupla-contagem:** um planejado sem conta que depois for conciliado a uma fatura/conta não pode ser somado duas vezes — reaproveitar a mesma disciplina de dedupe do espelho/parcela já existente no serviço.

**Invariantes que NÃO podem quebrar (validar com specs existentes):**
- Regras de neutros e casamento pagamento→fatura (`docs/visao-conta-faturas.md`), "cartão paga cartão" (`settlesInvoiceKey`/`computePaidInvoiceKeys`).
- Rateio: allocations continuam somando o `valorTotal` da fonte (`conciliacao.service.ts`).
- §10 do caixa real (`docs/cockpit-caixa-real.md`): os alvos do master de consolidação não podem se mover por dupla contagem — rodar a suíte `motor-unico-parity.spec.ts` e os specs de monthly-overview inteiros.
- Espelho cross-project (`linkedExpenseId`): item de CASA/CARRO/REFORMA sem espelho aparece como carteira **uma vez só**.

### 3.2 Frontend

**Arquivos:**
- `conta/_components/MovimentacaoRow.tsx` — chip discreto "sem conta" (cinza, clicável).
- `conta/_components/MovimentacoesSection.tsx` — opção "Sem conta/Carteira" no filtro de origens.
- `conta/_components/ResumoCards.tsx` (+ `.test.tsx`) — cards incluem carteira; microcopy do card "Saiu no mês" ganha nota quando houver itens sem conta (ex.: "inclui R$ X sem conta vinculada").
- Clique no chip → diálogo "De onde saiu esse pagamento?" com as contas/cartões existentes → chama o fluxo de vínculo/conciliação **já existente** (mesmo endpoint do vínculo atual de despesas; não criar fluxo paralelo).

**Critérios de aceite:**
1. Dado um mês com N despesas sem cartão/conta, a soma dos cards da Conta bate com a tela Despesas (mesma base caixa) — zero "dinheiro sumido".
2. Filtro "Sem conta/Carteira" lista exatamente esses N itens.
3. Chip clicável abre o fluxo de vínculo; ao vincular, o item migra de origem e os totais não mudam (era e continua contado 1×).
4. Specs de paridade e de account-view verdes; nenhum alvo do §10 alterado.

**Agentes (pipeline completo — é a entrega de maior risco):**
1. `architect` — mapeia `getAccountView`, decide o tratamento do `origem:'none'`, escreve a spec RED (casos: sem conta puro, foreign sem espelho, planejado→conciliado, rateio parcial, mês fechado vs corrente).
2. `pessoal-lens` **Phase 1** sobre a spec (permutações de caixa/espelho) + `casa-lens`/`carro-lens`/`reforma-lens` Phase 1 (as despesas "sem conta" nascem majoritariamente nesses projetos).
3. `backend-expert` e `frontend-expert` em paralelo sobre a spec RED.
4. `qa-engineer` — coverage + mutation mindset nos totais.
5. `pessoal-lens` **Phase 2** no diff, antes do PR.

---

## 4. PR-3 — Projeção unificada no Cockpit (narrativa única)

**Objetivo:** uma única fonte de verdade narrativa sobre a saúde financeira; fim do B2.

**Arquivos:**
- `apps/web/src/app/projects/[projectId]/monthly/_cockpit/` (ex.: `CockpitTop.tsx` e componente novo de projeção) — o card "Vai dar até dez?" entra no Cockpit **desktop e mobile**, abaixo do "Caixa hoje".
- `conta/_components/ProjecaoSaldo.tsx` — degrada para linha-resumo com link ("No ritmo atual, setembro fica negativo → ver projeção no Cockpit").
- Backend: reutilizar a projeção existente do account-view (o Cockpit já chama `getAccountView` para projeção — linha ~199 do service); **não criar segundo motor de projeção**.

**Regra de coerência (o coração do PR):** o status textual do Cockpit ("No caminho"/"Mês protegido"/alerta) e o alerta da projeção derivam do **mesmo cálculo e mesmo threshold**. Se o horizonte fica negativo, o Cockpit não pode dizer "no caminho" sem qualificar (ex.: "Julho no caminho · atenção: setembro projeta negativo"). O architect define a tabela de estados (mês OK+horizonte OK / mês OK+horizonte negativo / mês estourado+…) e os textos de cada célula — os textos vão para o `doc-librarian` documentar no manual.

**Critérios de aceite:**
1. Mesmo mês/dados → Cockpit e Conta exibem o mesmo status (teste de contrato comparando as duas derivações).
2. Projeção visível no Cockpit desktop (hoje inexistente) e mobile.
3. Conta mantém o aviso como resumo de 1 linha com link.
4. QA visual nos dois viewports.

**Agentes:** `architect` (tabela de estados + spec RED do status unificado) → `frontend-expert` (+ `backend-expert` só se o shape do endpoint precisar expor o status calculado — preferível calcular 1× no backend e os dois fronts consumirem) → `qa-engineer` → `pessoal-lens` Phase 2.

---

## 5. PR-4 — Navegação, ações e rebaixamento de Despesas/Recebimentos

**Objetivo:** D1, D2, D3, D6, D8, B3. Só entra depois de PR-1..3 mergeados.

**Arquivos:**
- `apps/web/src/app/projects/[projectId]/_components/mobile-nav.ts` (+ `mobile-nav.test.ts`) e `MobileTabBar.tsx` — bottom nav vira **Cockpit · Conta · [+] · Maria · Cartões** (gate por `hasFeature`, nunca por tipo hard-coded; para tipos sem `monthlyOverview` a tab bar atual permanece).
- `DesktopSidebar.tsx` (+ `.test.tsx`) e `MaisSheet.tsx` — sidebar em 5 grupos (D8); Despesas/Recebimentos saem do menu primário e passam a ser alcançados via Conta (e via "Mais"/busca, para não órfãos).
- `conta/_components/ContaQuickActions.tsx` — topo fica com **"+ Lançar"** único (abre `NovaDespesaLauncher`/wizard com escolha do tipo, reusar `expenses/_components/NovaDespesaWizard.tsx` e `ReceitaModal.tsx`); "Vincular em massa" e "Planejar recebimentos" migram para menu ⋯.
- `conta/_components/MovimentacoesSection.tsx` — links de drill-down: filtro "Saídas" ganha "ver análise completa →" (`/expenses`); "Entradas" ganha "planejar recebimentos →" (`/receipts`).
- Telas `/expenses` e `/receipts`: ganham breadcrumb/voltar para a Conta e o rótulo de competência (D7).
- Cadastros (D3): `AccountFormModal.tsx` e telas de `bank-accounts`/`credit-cards` — garantir engrenagem "gerenciar" dentro das visões de dados + empty-state com CTA de cadastro.

**Critérios de aceite:**
1. Nenhuma rota removida; deep-links antigos continuam funcionando.
2. Bottom nav: Conta presente, Despesas ausente, FAB "+" abre o Lançar unificado; tudo gateado por `hasFeature('monthlyOverview')` / features corretas por tipo (REFORMA/COMPRA/CASA/CARRO/PLANTAS **não regridem** — suas navs não têm Conta).
3. Sidebar desktop com 5 grupos; contagem de cliques para Despesas ≤2 a partir da Conta.
4. Usuário novo (zero contas/cartões) consegue cadastrar a partir do empty-state das visões de dados.
5. QA visual completa (§7) em PESSOAL **e** em um projeto de cada outro tipo (regressão de nav).

**Agentes:** `architect` (mapa de navegação final + spec dos gates por feature) → `frontend-expert` → `qa-engineer` → **todas as lenses Phase 2** (`pessoal-lens`, `reforma-lens`, `casa-lens`, `carro-lens`, `compra-lens`) porque navegação é superfície compartilhada → `doc-librarian` (a carga de docs deste PR é a maior, ver §6).

---

## 6. Documentação — atualização obrigatória e substituições (doc-librarian em TODO PR)

Disciplina: **mesma PR que muda comportamento atualiza o doc** (regra já vigente para `docs/manual-do-aplicativo.md` e `docs/estado-atual-cockpit-pessoal.md`).

| Doc | O que muda | PR |
|---|---|---|
| `docs/manual-do-aplicativo.md` | Seções da Conta (linha de movimentação nova; chip sem conta; filtro Carteira; "+ Lançar"; drill-downs), do Cockpit (projeção + tabela de estados/textos) e navegação (bottom nav e sidebar novas) | 1–4 |
| `docs/estado-atual-cockpit-pessoal.md` | Status de cada fase entregue; registrar a decisão "Conta = hub" e o estado da narrativa única | 2–4 |
| `docs/visao-conta-faturas.md` | **Nova seção "Carteira / sem conta"**: definição da pseudo-origem, regra de inclusão nos totais, dedupe na conciliação posterior, interação com neutros e espelho | 2 |
| `docs/cockpit-caixa-real.md` | § projeção: fonte única de cálculo, tabela de estados mês×horizonte | 3 |
| `CLAUDE.md` (Regras de ouro + Notas técnicas) | Ver §6.1 | 2 e 4 |
| `docs/plano-visao-conta-hub-2026-07.md` (este) | Marcar entregas concluídas; ao final, mover para o padrão de arquivamento de planos do repo | todos |

### 6.1 Mudanças no `CLAUDE.md` (substituir/acrescentar — não deixar regra obsoleta viva)

1. **Nova regra de ouro (após PR-2):** "Toda movimentação do PESSOAL sem cartão/conta pertence à pseudo-origem **Carteira** e DEVE aparecer na Visão Conta e nos totais (`getAccountView`). Nunca filtrar `origem:'none'` para fora silenciosamente — item invisível = dinheiro sumido no consolidado."
2. **Complementar a regra 13 (após PR-1):** referenciar `MovimentacaoRow.tsx` como layout canônico de linha de lista financeira (descrição linha 1 + valor nowrap à direita, metadados linha 2, status textual sob o valor) — novas listas copiam esse padrão.
3. **Nota técnica de navegação (após PR-4):** substituir qualquer menção à nav antiga; registrar que bottom nav vive em `mobile-nav.ts`/`MobileTabBar.tsx`, sidebar em `DesktopSidebar.tsx`, sempre gateadas por `hasFeature`, e que **Despesas/Recebimentos são drill-downs da Conta no PESSOAL** (não itens primários).
4. Revisar o §"Leitura obrigatória" — `estado-atual-cockpit-pessoal.md` segue fonte de verdade; este plano entra na lista enquanto estiver ativo.

---

## 7. QA visual obrigatória (gate de merge de TODOS os PRs)

Conforme regra de ouro 13 e memória `feedback-qa-visual-obrigatorio`:

- Login real em produção-like com dados reais (usuário de teste), **não** só tsc/jest.
- Viewports: 375px, 390px e desktop 1280px.
- Screenshots no corpo do PR (antes/depois para PR-1 e PR-4).
- Checklist tipográfico: nada <11px; valores de lista ≥15px; toque ≥44px; valor monetário nunca divide a linha com elemento variável.
- PR-4: repetir o smoke de navegação em 1 projeto de cada tipo (REFORMA, COMPRA, CASA, CARRO, PESSOAL, PLANTAS).

## 8. Processo, tracking e ordem de dispatch

- `issue-maintainer`: criar 1 épico "Visão Conta como hub" + 4 sub-issues (uma por PR) com os critérios de aceite deste doc como checkboxes; fechar via ledger no merge.
- Cada PR: branch própria a partir de `origin/main` em worktree próprio (regra 12), `--base main` no `gh pr create` (regra 11), hook de pré-commit cuida do tsc.
- Pipeline por PR: `architect` (quando indicado) → lenses Phase 1 → experts → `qa-engineer` → lenses Phase 2 → `doc-librarian` → QA visual → PR.
- Testes mínimos por PR: `cd apps/api && npx jest` (PR-2/3), suites `monthly-overview.*.spec.ts` + `motor-unico-parity.spec.ts` obrigatórias no PR-2; `cd apps/web && npx tsc --noEmit` + testes dos componentes tocados em todos.
- Fora de escopo declarado (não deixar escopo vazar): redesign do DRE/Neutros, gamificação, WhatsApp, mudanças de schema Prisma (PR-2 é agregação, sem migration).

---

## 9. Status de execução (atualizado em 2026-07-20)

| Entrega | Status | PR | Notas |
|---|---|---|---|
| PR-1 mobile row (fix B1) | ✅ Mergeado | #202 | Junto com PR-2 backend — bundling indevido (ver §10) |
| PR-2 backend Carteira | ✅ Mergeado | #202 | `getAccountView` emite `origem:{tipo:'carteira'}`; T1–T5 verdes |
| PR-2 frontend Carteira | 🚀 Em PR | `feat/conta-pr2-carteira-fechamento` | Chip "Sem conta", filtro, nota no card; 27 testes verdes |
| PR-3 projeção unificada | ⏳ Pendente | — | Depende de PR-2 mergeado |
| PR-4 navegação/bottom nav | ⏳ Pendente | — | Depende de PR-3 mergeado |

### §10 Desvios de processo registrados

1. **PR #202 foi bundling indevido** — levou PR-1 mobile row + PR-2 backend + 2 migrations + testes vermelhos F1 num único PR. Fatias do plano mestre devem ser PRs limpos e atômicos a partir daqui.
2. **PR #201 (`feat/conta-pr1-mobile-row`)** foi aberto separado mas o conteúdo chegou ao main via #202 — fechado com nota explicativa.
3. **PR #203 (`feat/pr2-carteira`)** usa prefixo do plano mas é PR de admin/telemetria — não usar prefixos do plano em branches fora do roadmap.
4. **3 commits diretos no main** (b2230d40, 8d7ab3d7, 275ed563) sem PR — reforçar: sempre PR, sem exceção.
