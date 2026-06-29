# Plano — Cockpit Financeiro PESSOAL (handoff para agente)

> **Como usar este documento.** Ele é auto-contido: assume só o que está no repositório hoje.
> Execute por fases, na ordem. Cada fase tem objetivo, arquivos-alvo, contrato, critérios de
> aceite e riscos. **Respeite as invariantes da §0 — elas são o que protege os dados reais de
> produção.** Decisões de produto estão na §11 (todas já resolvidas em 2026-06-16).

---

## 0. Invariantes inegociáveis (ler antes de tocar em qualquer coisa)

Estas regras já estão validadas contra o banco real (ver `DIAGNOSTICO_CAIXA_INT_PM.md` e
`RELATORIO_RECONCILIACAO_PESSOAL.md`). Quebrá-las corrompe a reconciliação.

1. **§10 (caixa da conta) é conta-only e realizado.** `computeCaixaConta`
   (`apps/api/src/monthly-overview/monthly-overview.service.ts`) = saldo inicial + Σ lançamentos
   PAGO/EM_CAIXA com `bankLast4 != null`. Cartão (sem `bankLast4`) **nunca** entra aqui. Bate com
   o banco na vírgula. **Não alterar a fórmula.**
2. **Pagamento de fatura é neutro.** Categoria `PAGAMENTO_FATURA_CARTAO` fica fora do resultado.
   Toda nova visão de caixa **não pode** recontar isso (seria dupla contagem: gasto no cartão +
   pagamento da fatura).
3. **Não reescrever datas de cashflow gravadas.** Hoje o cashflow do cartão é gravado com
   `data = data da compra` (competência) e `status PAGO`; parcelas futuras em `addMonths(dataCompra, i)`.
   O eixo "caixa" (vencimento) deve ser **derivado em uma camada de view**, nunca via migration que
   mexe nas datas — senão o realizado e o §10 quebram.
4. **Regra de ouro nº 1 do `AGENTS.md`:** se mexer em `prisma/schema.prisma`, **backup obrigatório**
   (`cp prisma/dev.db prisma/dev.db.bak-$(date +%Y%m%d-%H%M%S)`) antes de `prisma migrate dev`.
   **NUNCA** `migrate reset` / `db push --force-reset` / `rm dev.db`.
5. **Espelho cross-project (`linkedExpenseId`) — a lógica CANÔNICA é a do Cockpit.** O PESSOAL é o
   controlador universal do caixa; o espelho conta no PESSOAL-only e é deduplicado no consolidado via
   flag `isEspelho`. Essa é a semântica **correta** (`monthly-overview.service.ts`/`derive.ts`/§10) —
   **não quebrá-la.** A correção da Fase 0 §2.0.3 é alinhar os OUTROS serviços a ela (que hoje
   excluem o espelho cegamente), **não** mexer no Cockpit nem "desvincular" dados.
6. **Restrições do `AGENTS.md`:** páginas ≤ 400 linhas / 20 KB (quebrar em `_components`/`_hooks`/`_types`);
   após mudar `packages/domain/src`, rodar `cd packages/domain && npm run build`; hook de pré-commit
   roda `tsc --noEmit` nos 3 pacotes.
7. **UM NÚMERO, UM DONO (fonte única).** "Saldo/caixa/sobra projetada" deve ter **uma** definição
   canônica, reusada em toda tela. Hoje o mesmo número é calculado em 4 lugares com regras diferentes
   (ver Fase 0) — isso causa valores divergentes entre telas. **Proibido** criar um 5º cálculo de
   saldo/caixa em qualquer Fase nova. Toda nova visão **consome** o cálculo canônico, não inventa o seu.
8. **NÃO multiplicar telas/views.** O Cockpit é o hub. Fases novas adicionam **seções/componentes
   dentro do Cockpit**, não rotas novas. Na página de despesas, que já tem views demais
   (`category | month | project` + hierárquica + compráveis), **não criar novas views** — só trocar o
   conteúdo do card dentro das existentes.

---

## 1. Estado atual (o que JÁ existe — não reconstruir)

| Capacidade | Onde | Estado |
|---|---|---|
| Modelo `CreditCard` com `closingDay`/`dueDay` | `prisma/schema.prisma` + `credit-cards/_components/CardFormModal.tsx` | ✅ schema + UI de edição |
| Parcelamento (campos + materialização) | `Expense.quantidadeParcela/dataInicioParcela/paidParcelas/seriesKey`; `CashFlowEntry.parcela`; `buildInstallments` em `packages/domain/src/calculations/expense-installments.ts` | ✅ parcelas viram entries de cashflow |
| Importação de fatura com settlement de parcela | `apps/api/src/credit-card/credit-card.service.ts` | ✅ atual PAGO + futuras PLANEJADO, com `seriesKey` |
| PESSOAL no `PROJECT_FEATURES` | `packages/domain/src/config/project-features.ts` → `[monthlyOverview, dashboard, expenses, receipts, cashFlow, creditCards, bankAccounts]` | ✅ |
| Cockpit mensal completo | `apps/web/src/app/projects/[projectId]/monthly/_cockpit/` (CockpitTop, CategoriasBarras, SaldoMesChart, YearView, EvolucaoPatrimonio, SaudeFinanceira, Recomendacoes, MonthView) | ✅ ~70% da visão |
| Endpoint consolidado | `monthly-overview.controller.ts` → `getOverview` retorna `meses`, `entries`, `caixa` (§10) | ✅ |
| Dashboard PESSOAL | `dashboard/page.tsx` **redireciona para `/monthly`** (PESSOAL não tem dashboard próprio) | ✅ unificação a nível de rota |

**O que NÃO existe (escopo deste plano):**
- ❌ Derivação de **mês de caixa por cartão** (closingDay/dueDay são gravados mas nenhuma lógica os consome).
- ❌ Toggle **"Gastei" (competência) vs "Vai sair" (caixa)** — a tela só tem `view: 'mes' | 'ano'`.
- ❌ Visão de **faturas projetadas por mês de vencimento**.
- ❌ **Trilha de comprometimento futuro** (parcelas em aberto agregadas por mês) — dado existe, falta viz.
- ❌ **`recurringBills` para PESSOAL** (bloqueado por `@RequireModule('recurringBills')`).
- ❌ Card de despesa adequado ao PESSOAL (hoje usa `LinkPreviewCard`, desenhado para REFORMA).
- ❌ **Orçamento por categoria** (budget vs realizado) — gap de mercado.

---

## 1b. Duplicidades a resolver ANTES de construir (o "mil visões")

Auditoria da IA atual do PESSOAL. Estes são os problemas que, se ignorados, fazem cada Fase nova
empilhar erro:

**(D1) Dois motores de consolidação paralelos, com regras diferentes.**
- `tenant-financial.service.ts` (alimenta `/financeiro`): `caixaTotal`, `saldoProjetado30d/90d`,
  breakdown por projeto, cashflow consolidado, por categoria.
- `monthly-overview.service.ts` (alimenta o Cockpit `/monthly`): `caixa` §10 + `derive.ts:deriveTotals`
  (`caixaAgora`, `saldoProjetado`).
- Ambos varrem todos os projetos do tenant. → o usuário pode ver "saldo projetado" **diferente** em
  `/financeiro` vs Cockpit. **Bug silencioso.**

**(D2) Quatro definições de "saldo".** §10 (`computeCaixaConta`) · `deriveTotals.caixaAgora` ·
`rollingBalance`/`rollingBalanceRealizado` (página `cash-flow`) · `totalPago`/`totalGeral` (página `expenses`).
**Causa-raiz parcial confirmada:** tratamento inconsistente do espelho `linkedExpenseId` — `cash-flow`
exclui o espelho e o Cockpit inclui, então a mesma conta PESSOAL mostra saldos diferentes. Detalhe e
correção na Fase 0 §2.0.3.

**(D3) Views de despesa sobrepostas.** A view "mês" de `expenses` duplica o `MonthView` do Cockpit;
o `LinkPreviewCard` (REFORMA) é reusado no PESSOAL.

**(D4) Navegação incoerente.** `sidebar.tsx:navItems` = Dashboard, Despesas, Recebimentos, Fluxo de
Caixa, Plantas, Simulação. **Cockpit, Cartões e Contas não têm item de menu** — o Cockpit (a peça
central) é alcançado só pelo redirect do item "Dashboard"; Cartões/Contas só por URL direta.

---

## 2. FASE 0 — Consolidar a fonte única e a IA (pré-requisito de tudo)

**Objetivo:** garantir que existe **um** número canônico e **um** hub, antes de adicionar visões novas.
Sem isto, as Fases 1–5 multiplicam divergência.

> **DECISÃO DO GABRIEL (2026-06-16): FUNDIR NO COCKPIT.** O Cockpit (`/monthly`) é a **única** visão
> consolidada. `/financeiro` é **descontinuado** (redirecionar para o Cockpit); o que for útil dele
> migra como **seção** do Cockpit. Não manter dois consolidados.

### 2.0.1 Fonte única de número (resolve D1, D2)
- **Motor canônico = `monthly-overview`** (já tem o §10 reconciliado com o banco). `tenant-financial`
  **não** é mais a fonte de nenhum número de tela — ou é aposentado junto com `/financeiro`, ou rebaixado
  a helper que reusa as funções puras do domínio. **Nenhuma regra própria de caixa/saldo sobrevive.**
- **Extrair as definições para o domínio** (`packages/domain/src/calculations/`) como funções puras
  únicas: `caixa` (§10), `saldoProjetado`, `resultadoMes`. Toda tela que exibir esses números importa
  daí. **Proibido** cálculo local novo (invariante §0.7).
- **`cash-flow` (`rollingBalance`) e `expenses` (`totalPago`):** rotular explicitamente como métricas
  diferentes ("saldo corrido do extrato", "total filtrado") — **não** competem com o "saldo" do Cockpit.
  Onde mostrarem saldo de fato, consumir o número canônico.
- **Critério de aceite:** existe exatamente **uma** definição de "saldo projetado" no código (no domínio);
  nenhuma tela recalcula. Teste cobrindo a função canônica.

### 2.0.2 IA enxuta — fusão no Cockpit (resolve D3, D4)
- **Papel de cada tela após a fusão:**
  - **Cockpit (`/monthly`)** = **o** hub financeiro. Absorve o que era útil do `/financeiro`.
  - **`/financeiro`** = **descontinuado** → redireciona para o Cockpit (mesmo padrão do `dashboard`
    do PESSOAL, que já redireciona para `/monthly`).
  - **`expenses`** = CRUD/listagem e edição de lançamentos (não um segundo dashboard).
  - **`cash-flow`** = extrato cru auditável (não um saldo concorrente).
- **Migrar do `/financeiro` para o Cockpit** (como seções, reusando o número canônico — sem recalcular):
  avaliar `CategoryDonut`, `TopSuppliers`, `UpcomingTable`, `CashFlowCharts`, `ProjectsBreakdown`.
  Trazer só o que agrega ao PESSOAL; descartar o resto. **Não** criar rota nova para nenhum deles.
- **Corrigir a navegação (`sidebar.tsx`)**: o item de menu do PESSOAL aponta para o **Cockpit**
  (renomear "Dashboard"→"Cockpit" ou apontar o href para `/monthly`); **adicionar Cartões e Contas**
  ao menu (gateados por `module` via `hasModule`, features `creditCards`/`bankAccounts` já existem);
  remover/realocar a entrada de `/financeiro`.
- **Critério de aceite:** um usuário PESSOAL tem **um** hub (Cockpit) no menu, mais Cartões e Contas;
  `/financeiro` não aparece como destino separado; nenhuma tela mostra "saldo" que contradiz o Cockpit.

### 2.0.3 Consistência de vínculos / espelhos (`linkedExpenseId`) — CORREÇÃO confirmada
**Bug real encontrado** (auditoria 2026-06-16). O espelho cross-project é tratado de **5 formas
diferentes** entre serviços:
- `monthly-overview` (Cockpit) e `computeCaixaConta` (§10): **incluem** o espelho (deduplicam via
  `isEspelho`) → o débito real conta no caixa PESSOAL. **Correto** (bate com o banco).
- `cash-flow.service.ts`, `dashboard.service.ts`, `simulation.service.ts`, `budget-allocation.service.ts`:
  filtram `linkedExpenseId: null` → **excluem** o espelho.

**Impacto:** para um projeto **PESSOAL**, a página `cash-flow` descarta débitos reais que têm
`bankLast4` mas estão vinculados (ex.: INT/PM −R$ 25.950) → `rollingBalance` **inflado** vs §10/Cockpit.
Mesmo projeto, dois saldos diferentes. É a raiz concreta de D2.

**Correção (parte da fonte única) — ESCOPO CIRÚRGICO:**
- **Só `cash-flow.service.ts` muda, com guard `projectType === 'PESSOAL'`.** Raio de impacto auditado
  (2026-06-16): dos 4 serviços que filtram o espelho, **só `cash-flow` é consumido pelo PESSOAL.**
  - `dashboard.service` → PESSOAL **não usa** (a página `dashboard` redireciona p/ `/monthly` e retorna
    `null`). **NÃO tocar** (mexer afetaria REFORMA/COMPRA).
  - `simulation.service` → PESSOAL **não tem** a feature `simulation`. **NÃO tocar.**
  - `budget-allocation.service` → fluxo REFORMA-cêntrico (alocar budget p/ obra); não alimenta número
    do Cockpit. **NÃO tocar.**
- A regra de espelho passa a ser **PESSOAL-aware e centralizada** (um predicado no domínio que **recebe
  o `projectType`** — NUNCA flipar global, senão os 4 callers mudam juntos). Semântica canônica =
  §10/Cockpit: no PESSOAL o espelho **conta**; em projeto não-PESSOAL é excluído (evita recontar
  artefato cross-project); no consolidado deduplica via `isEspelho` (já implementado).
- **NÃO "desvincular" lançamentos** (o §7 do `RELATORIO_RECONCILIACAO_PESSOAL.md` sugere isso e está
  **errado**): o §10 já conta o lançamento corretamente *com* o vínculo. Corrige-se a regra de consumo,
  não o dado.
- **Impacto visível (só na página Fluxo de Caixa do PESSOAL):** saldo sobe p/ bater com o Cockpit/§10;
  as linhas vinculadas (ex.: INT/PM −25.950) passam a aparecer; `rollingBalance` recalcula. Nenhum
  outro projeto muda. Sem dupla contagem (cash-flow é por-projeto; o alvo da obra não entra na query
  do PESSOAL).
- **Critério de aceite:** o saldo da página `cash-flow` de um projeto PESSOAL é **idêntico** ao caixa
  do Cockpit (§10); REFORMA/COMPRA/CASA/CARRO ficam byte-idênticos; teste com um expense espelhado
  (bankLast4 + linkedExpenseId) garantindo que conta no PESSOAL e que um projeto não-PESSOAL não mudou.

> **⚠️ NOTA DE RISCO — vincular é destrutivo e irreversível (aresta do mecanismo, NÃO bloqueia a correção acima).**
> A criação do vínculo está bem blindada (guard cross-project idêntico nos 3 caminhos: manual
> `expense.service.ts:74`, import cartão `credit-card.service.ts:463`, import banco
> `bank-account.service.ts:758` — nunca vincula dentro do mesmo projeto; e é sugestão→confirmação do
> usuário, nunca auto-link cego). **O risco está no que o link FAZ:** `linkToExpense`
> **sobrescreve a despesa alvo** (`bank-account.service.ts:762-781` / `credit-card.service.ts:467-485`)
> — força `status=PAGO` e substitui `valor/quantidade/valorTotal/quantidadeParcela/dataInicioParcela/dataPagamento`
> pelos da fonte, e regenera o cashflow da alvo. Implicações: (1) confirmar uma **sugestão errada**
> (dentro da tolerância ±5%/±10d) sobrescreve silenciosamente uma despesa legítima da obra;
> (2) **`unlinkExpense` NÃO reverte** os valores/status da alvo (`credit-card.service.ts:535` avisa
> explicitamente). O link é mutação de mão única. **Não confundir com a correção do espelho** (que é
> só regra de consumo no `cash-flow`); isto é uma aresta separada do fluxo de importação. Melhoria
> futura sugerida: snapshot do alvo antes do overwrite para permitir unlink reversível, ou exigir
> confirmação explícita quando a sugestão não for casamento exato.

### 2.0.4 Assimetria resgate/aplicação infla o resultado — ⏸️ DEFERIDO (NÃO implementar agora)
> **DECISÃO Gabriel (2026-06-16): deixar pra depois.** O bug está documentado abaixo para registro,
> mas **não faz parte da Fase 0 executável** — não corrigir agora. Decidir junto com o modelo de conta
> de investimento/patrimônio (nível 2, guardado na memória).

**Bug real encontrado** (auditoria 2026-06-16). `fastClassify` classifica **aplicação e resgate** como
`MOVIMENTACAO_INTERNA` (mesma regex, `bank-account.service.ts:58`), mas os lados são tratados
assimetricamente na importação:
- **Aplicação** (saída, `amountCents>0`): `MOVIMENTACAO_INTERNA` → neutro → **sem cashflow**
  (`bank-account.service.ts:1184`). Não conta como despesa.
- **Resgate** (entrada, `amountCents<0`): vira `Receipt RESGATE` + **cashFlowEntry RECEBIMENTO**
  (`bank-account.service.ts:1066`). **Conta** como recebimento.

**Impacto:** `buildMonthlyOverview` soma o resgate em `totalRecebimentos` mas não soma a aplicação em
`totalDespesas` → `saldoMes`, `resultadoMes` (card "Resultado"), **taxa de poupança** e **patrimônio
acumulado** (`deriveYear`, usa `sobra = rec − desp`) ficam **inflados pelo valor dos resgates** (~R$ 113k
nos dados reais). O **§10/banco continua correto** (lê Expense/Receipt por `bankLast4`, conta os dois
lados) — por isso a reconciliação não pegou. Só a métrica de **resultado** está assimétrica.

Obs.: o comentário em `bank-account.service.ts:1042-1043` ("vira Expense neutra sem cashflow") está
**desatualizado** — o código cria Receipt COM cashflow.

**Correção (decisão de produto — ver §11.6, DEFERIDA):**
- **(a, recomendada)** tornar o resgate **simétrico com a aplicação**: criar o `Receipt RESGATE` (para
  o §10/banco) mas **NÃO** criar o cashFlowEntry → resgate deixa de inflar o resultado. Mantém o §10
  intacto e alinha com o padrão de mercado (transferência para investimento não é renda).
- **(b)** contar os dois lados: aplicação vira `INVESTIMENTOS` (despesa, com cashflow) e resgate
  permanece recebimento. Resultado reflete o caixa mas "investir" aparece como resultado negativo.
- **Critério de aceite:** num mês com aplicação X e resgate Y, o `resultadoMes`/`saldoMes` não muda por
  causa da movimentação interna (opção a), ou muda de forma simétrica (opção b). Teste cobrindo os dois
  lados a partir do mesmo merchant `MOVIMENTACAO_INTERNA`.

### 2.0.5 Auditoria da aritmética do resultado — resultado (NÃO requer ação, exceto §2.0.4)
Verificado (2026-06-16) que `Σ despesa − Σ recebimento` está correto nas três complicações, **exceto**
a assimetria resgate/aplicação (§2.0.4, deferida):
- ✅ **Neutros** (fatura/mov.interna): não geram cashflow → fora do resultado; têm `bankLast4` → contam no §10.
- ✅ **Parcelas:** `buildInstallments` fatia o total em N que somam o total; sem entry cheia extra.
- ✅ **Espelho:** consolidado deduplica via `isEspelho` (bug só de consumo no `cash-flow`, §2.0.3).
- ✅ **Estornos/créditos:** estorno de cartão = **despesa negativa** (`credit-card.service.ts:596`) →
  reduz `totalDespesas` e a categoria, aumenta o saldo, **não infla renda**. Linha "PAGAMENTO EFETUADO"
  é ignorada (não duplica). Estorno no banco vira `Receipt` — **neutro no resultado** (anula a compra
  original já contada), com leve imperfeição cosmética (não reduz a categoria). **Nenhuma ação.**
- ⏸️ **Resgate/aplicação:** único assimétrico (infla o resultado) — ver §2.0.4 (deferido).

> **Esta fase não adiciona features — ela remove divergência e funde telas.** É barata e destrava as
> demais com segurança.

---

## 3. FASE 1 — Derivação de mês de caixa por cartão (o linchpin)

**Objetivo:** dado uma compra de cartão e o `closingDay`/`dueDay` do cartão, calcular em qual
**mês de caixa** (vencimento da fatura) ela sai. Função pura, testável, no domínio.

### 3.1 Função de domínio
- **Arquivo novo:** `packages/domain/src/calculations/card-cash-month.ts`
- **Assinatura:**
  ```ts
  export function caixaMonthForCardPurchase(
    purchaseDate: Date,
    closingDay: number,
    dueDay: number,
  ): string // 'YYYY-MM' (mês de vencimento)
  ```
- **Regra (convenção padrão de cartão BR) — DECISÃO Gabriel: compra NO dia do fechamento vai p/ a PRÓXIMA fatura:**
  - A compra entra na fatura que fecha no próximo `closingDay` **estritamente depois** do dia da compra.
    Ou seja: `dia da compra < closingDay` → fecha **este mês**; `dia da compra >= closingDay` → fecha
    no **mês seguinte** (compra exatamente no dia do fechamento cai na próxima fatura).
  - Essa fatura **vence** no `dueDay`. Se `dueDay < closingDay`, o vencimento é no **mês seguinte**
    ao fechamento (ex.: fecha dia 28, vence dia 7 → vence no mês seguinte). Se `dueDay >= closingDay`,
    vence no mesmo mês do fechamento.
  - O **mês de caixa = ano-mês da data de vencimento.**
  - Tudo em **UTC** (espelhar `buildInstallments`, que opera em UTC para consistência cliente/servidor).
  - Edge cases: `closingDay`/`dueDay` nulos → fallback para o mês da própria compra (degrada para
    competência, sem quebrar). Clamp de dia para o último dia do mês (ex.: fechamento 31 em fevereiro).
- **Exportar no barrel** `packages/domain/src/index.ts`.
- **Testes:** `packages/domain/__tests__/card-cash-month.test.ts` cobrindo:
  compra antes/depois do fechamento; **compra exatamente no `closingDay` → próxima fatura** (caso de
  borda da decisão); `dueDay < closingDay` (vencimento mês seguinte); `dueDay >= closingDay`;
  viradas de ano (dez→jan); dias nulos (fallback); clamp de fevereiro.

### 3.2 Enriquecer o endpoint para permitir a derivação
- **Arquivo:** `monthly-overview.service.ts` (`getOverview` / `enrich`).
- Hoje cada entry tem `subcategoria = card.nickname` mas **não tem `cardLast4` nem closing/due**.
  Para derivar caixa no front/domínio, o endpoint precisa expor o vínculo entry→cartão.
- **Adicionar:** carregar `creditCard` do tenant/projeto (`closingDay`, `dueDay`, `last4`, `nickname`)
  e incluir no payload (`cards: [...]`). Em `enrich`, incluir `cardLast4` da Expense de origem
  (a Expense já tem `cardLast4`; juntar via `expenseId`). Assim o front casa entry→cartão por `cardLast4`.
- Atualizar `monthly/_types.ts` (`MonthlyOverviewResponse`) com `cards` e `MonthlyEntry.cardLast4`.
- **Não** mudar nada do cálculo de `meses`/`caixa` existente — só **acrescentar** dados.

### 3.3 Builder do eixo de caixa (domínio)
- **Arquivo novo:** `packages/domain/src/calculations/cash-axis.ts`
- **Função:** recebe as entries + a lista de cartões e produz, por mês de caixa:
  - **fatura projetada** = Σ das compras de cartão (entries com `cardLast4`, tipo DESPESA) remapeadas
    pelo `caixaMonthForCardPurchase`.
  - **débitos de conta** = entries com forma de débito/conta: caixa = competência (não remapear).
  - **Guardrail (invariante §0.2):** ao montar o caixa, **excluir** as entries de categoria
    `PAGAMENTO_FATURA_CARTAO` (a fatura projetada já representa essa saída; contar as duas dobra).
- Saída: `Record<'YYYY-MM', { faturaCartao: number; debitos: number; total: number }>` + detalhamento
  por cartão (para o tooltip "qual fatura").
- **Testes:** `__tests__/cash-axis.test.ts` — garantir que (a) compra de cartão cai no mês de
  vencimento, não da compra; (b) pagamento de fatura neutro não é contado; (c) débito de conta
  permanece na competência.

**Critério de aceite da Fase 1:** com dados reais, o total de "fatura que vai sair" em um mês futuro
bate com a soma das parcelas/compras daquele ciclo; nenhuma dupla contagem com o §10; testes verdes.

---

## 4. FASE 2 — Toggle "Gastei / Vai sair" no cockpit

**Objetivo:** um segmented control no topo do cockpit que reprojeta a tela inteira entre
**competência** (o que já existe) e **caixa** (eixo da Fase 1).

- **Arquivo:** `monthly/page.tsx` + novo `_cockpit/EixoToggle.tsx`.
- Estado novo: `eixo: 'competencia' | 'caixa'` — **default `competencia` (DECISÃO Gabriel: abrir em
  "Gastei").** Persistir em `localStorage` (decisão menor).
- **Competência** = comportamento atual (entries por `data` da compra). **Não mexer.**
- **Caixa** = alimenta os mesmos componentes (`CockpitTop`, `CategoriasBarras`, `SaldoMesChart`,
  `MonthView`) a partir do builder `cash-axis.ts`:
  - Passado: usa o realizado §10 (já reconciliado) — fatura já paga.
  - Futuro: usa a fatura projetada da Fase 1 + PLANEJADO conhecido.
- **`derive.ts`:** generalizar `deriveMonth`/`deriveCockpitTop` para aceitar o eixo escolhido
  (parâmetro `eixo`), reaproveitando ao máximo. Quando `eixo='caixa'`, o "Gastou/Vai sair" do mês
  e a projeção usam os valores remapeados.
- **UX (decisões já acordadas — ver memória `pessoal-visao-financeira-produto`):**
  - Rótulos: **"Gastei"** (competência) / **"Vai sair"** (caixa).
  - O número herói (Caixa·Resultado·Projeção do `CockpitTop`) responde ao toggle.
  - Mostrar memória de cálculo da projeção em letra pequena (auditável).

**Critério de aceite:** alternar o toggle muda categorias, headline e projeção de forma coerente;
no eixo caixa, uma compra parcelada de cartão aparece distribuída pelos meses de **vencimento**,
não no mês da compra.

---

## 5. FASE 3 — Comprometimento futuro (trilha de barras)

**Objetivo:** visão das parcelas em aberto somadas por mês futuro (o "quanto já está reservado").

- **Dado já existe:** parcelas futuras são `CashFlowEntry` PLANEJADO com `parcela` ("3/10") e,
  no eixo caixa, já caem no mês de vencimento.
- **Arquivo novo:** `_cockpit/ComprometimentoFuturo.tsx` (componente de barras dos próximos N meses,
  ex.: 12). Builder no domínio ou em `derive.ts`: somar entries PLANEJADO de cartão por mês de caixa.
- **UX acordada:**
  - **Cor âmbar** (reservado/atenção), **não vermelho** (vermelho = erro).
  - **Uma cor só** — a informação está na **altura** da barra, não na cor. Mês corrente alto,
    decrescendo nos seguintes.
  - Tooltip por mês: lista das parcelas que compõem (merchant + "k/n" + valor).
- Encaixar como seção do `MonthView`/cockpit (respeitar limite de 400 linhas — extrair componente).

**Critério de aceite:** a soma da trilha = total de parcelas em aberto; clicar/hover detalha a composição.

---

## 6. FASE 4 — Aporte / recorrências (recurringBills no PESSOAL)

> **DECISÃO Gabriel (2026-06-16): APORTE FORA DO ESCOPO ("pode tirar").** O aporte/poupança como
> conceito (e o modelo de conta de investimento/patrimônio relacionado) fica **deferido** — não atuar
> agora. Esta fase reduz-se ao **opcional** abaixo (assinaturas), só se houver vontade; não é prioridade.

**Objetivo (reduzido):** habilitar recorrências para o PESSOAL cobrir **assinaturas/contas fixas**
(Netflix, academia, etc.) na projeção. **Aporte de investimento NÃO entra agora** (deferido).

- **(Opcional) Habilitar feature:** adicionar `'recurringBills'` à lista de `PESSOAL` em
  `packages/domain/src/config/project-features.ts` (módulo backend já existe, gateado por
  `@RequireModule('recurringBills')`). Rodar `npm run build` no domínio. Verificar se a UI de
  recurring-bills (hoje CASA/CARRO) aparece coerente no PESSOAL.
- **Aporte de poupança/investimento:** deferido (ver memória `pessoal-visao-financeira-produto` — modelo
  de conta de investimento/patrimônio guardado para decidir depois).

**Critério de aceite (se feito):** uma assinatura recorrente cadastrada aparece nos próximos meses na
projeção e reduz a sobra projetada.

---

## 7. FASE 5 — Correção dos cards de dados da despesa

**Problema:** o card de cada despesa no PESSOAL reusa `LinkPreviewCard`
(`expenses/_components/LinkPreviewCard.tsx`), que foi desenhado para **REFORMA**:
imagem de produto, botões "Comparar preços" e "Abrir link", `quantidade × valor unitário`, badge de
ambiente. Para uma despesa pessoal (Pix, restaurante, fatura) isso é ruído e **omite o que importa**:
forma de pagamento, **parcela X/N**, **cartão de origem** (`cardLast4`/nickname), **data**, e — com a
Fase 1 — o **mês de caixa/vencimento**.

- **Criar** `expenses/_components/PersonalExpenseCard.tsx` (ou ajustar a renderização condicional por
  `projectType === 'PESSOAL'` em `SortableCard`/views que listam despesas — ex.: `PersonalHierarchicalView`,
  `MonthlyExpenseView`, `MobileExpenseList`).
- **Mostrar no card PESSOAL:**
  - título/fornecedor + categoria (sem styling laranja de REFORMA);
  - valor + **parcela "k/n"** quando parcelado (e quantas faltam);
  - **forma de pagamento** + **cartão** (nickname/last4) ou conta;
  - **data da compra** (competência) e, quando cartão, **"vence em MM/AA"** (Fase 1);
  - `StatusBadge` (PLANEJADO/PAGO) — manter;
  - **remover** "Comparar preços" e "Abrir link" no contexto PESSOAL (não há link de produto).
- **Auditar** os campos do tipo `Expense` em `@/types` que hoje não chegam ao card (`cardLast4`,
  `formaPagamento`, `quantidadeParcela`, `dataPagamento`) e garantir que a API os retorna na listagem.
- **Cuidado AGENTS.md nº 2:** Tailwind é frágil; não fazer swaps em massa de classe — criar componente
  novo em vez de mutilar o `LinkPreviewCard` (que REFORMA ainda usa).

**Critério de aceite:** no PESSOAL, o card mostra parcela, cartão e vencimento; REFORMA continua
idêntico (regressão zero no `LinkPreviewCard`).

---

## 8. FASE 6 — Vínculo cross-project bilateral e por parcela (conciliação)

**Problema relatado** (Gabriel, 2026-06-16) e confirmado no código. Ao conciliar uma despesa do
PESSOAL (ex.: cartão `PgConta STUDIO EMME DUE (1/3)`, Revestimento, 14/05) com uma despesa **planejada**
na REFORMA (ex.: `Ceramica + Material`): no PESSOAL fica unificado, **mas na REFORMA não** — o alvo
continua com o valor planejado velho e sem tratar parcela.

**Causa-raiz: existem 2 caminhos de vínculo com comportamentos inconsistentes, e nenhum é por parcela:**
1. **Vínculo manual** (`VinculosFields`/`CreateLinkedExpenseModal` → `expense.service.create` com
   `linkedExpenseId`): **unilateral** — grava o link só no lado PESSOAL; **NÃO toca no alvo** (REFORMA
   fica PLANEJADO, valor original, sem liquidação). É o caminho que o Gabriel usou. (Não é cache — o
   modal invalida `['expenses', targetProjectId]`; o dado nunca é escrito no alvo.)
2. **Vínculo via importação** (`linkToExpense`, sugestões do cartão/banco): **sobrescreve** o alvo, mas
   com o valor de **uma parcela só** (card import grava `valorTotal` = valor da parcela) e regenera o
   cashflow via `buildInstallments` → racha a parcela em N → valor errado por outro motivo. Além do
   risco de overwrite destrutivo/irreversível (ver nota em §2.0.3).

**Objetivo:** uma **única** conciliação cross-project, **bilateral** (os dois lados refletem) e
**por parcela**, reusando peças que já existem: `plannedExpenseId`/`settledByExpenseId` (ponteiros de
liquidação), `seriesKey` (série de parcelas), `paidParcelas` (parcelas pagas) — hoje só funcionam
**dentro** de um projeto (settlement do card import). Estender para cross-project.

**Comportamento desejado:**
- A despesa planejada da REFORMA pode ser **parcelada** (ex.: 3×). Cada parcela do cartão pessoal
  (1/3, 2/3, 3/3, conforme as faturas chegam) **liquida a parcela correspondente** da REFORMA.
- A REFORMA passa a mostrar **conciliado / "pago via cartão pessoal"**, com **valor correto** (total da
  série, não de uma parcela) e **progresso de parcela** (1/3 paga, 2 em aberto).
- **DECISÃO Gabriel — não-destrutivo + valor real sempre vence:** usar `settledByExpenseId` (o alvo
  aponta para quem o liquidou; vínculo **reversível**), MAS, quando o valor real do cartão diverge do
  planejado, **o real SEMPRE substitui o planejado** na exibição/uso (a REFORMA mostra o valor real,
  nunca o planejado velho). Para manter reversível, **guardar um snapshot do planejado original** (campo
  ou no próprio registro de liquidação) para o `unlink` conseguir restaurar. Resumo: estrutura
  reversível, valor exibido = real, planejado preservado só como backup de unlink.
- **NÃO** mostrar planejado×pago lado a lado (decisão: real vence sempre).
- **DECISÃO Gabriel (reforço): o valor real do PESSOAL propaga para TODOS os indicadores, inclusive os
  do projeto REFORMA.** Não basta atualizar a exibição da despesa — o dashboard, os KPIs, os totais e o
  cash-flow da REFORMA devem refletir o valor real (vindo da liquidação do PESSOAL), não o planejado
  velho. Implicação técnica: a liquidação precisa sincronizar o **valor efetivo do alvo** (o que as
  queries de indicador da REFORMA leem), com o planejado guardado só como snapshot de unlink.

**Arquivos prováveis:** `expense.service.ts` (criação/edição de vínculo manual — passar a liquidar o
alvo), `credit-card.service.ts`/`bank-account.service.ts` (`linkToExpense` — unificar com o manual e
tornar parcela-aware; trocar overwrite por liquidação reversível com snapshot), UI:
`VinculosFields`/`CreateLinkedExpenseModal`/`LinkSuggestionsPanel` + a exibição da despesa na REFORMA
(mostrar estado de conciliação/parcela + valor real).

**Critério de aceite:** vincular `PgConta STUDIO 1/3` do PESSOAL à `Ceramica + Material` planejada
(3×) na REFORMA → a REFORMA mostra parcela 1/3 liquidada, 2 em aberto, valor total correto, marcada
como paga via cartão pessoal; **os indicadores da REFORMA (dashboard, KPIs, totais, cash-flow) passam
a exibir o valor real**, não o planejado; conciliar 2/3 e 3/3 nas faturas seguintes fecha a despesa;
unlink restaura o planejado original (snapshot). Sem dupla contagem no consolidado (o espelho continua
deduplicado via `isEspelho`).

---

## 9. Unificação cockpit ⇆ dashboard (IA centralizada)

> **A unificação estrutural foi movida para a Fase 0 (§2.0.2 IA enxuta)** — papel de cada tela,
> fonte única de número e correção da navegação. Esta seção fica só com o resíduo de conteúdo a
> avaliar **depois** que a Fase 0 alinhou a base.

- **Auditar o que o dashboard financeiro (REFORMA/COMPRA) tem e o cockpit não:** ver
  `dashboard/_components/DashboardCharts.tsx`. Migrar para o cockpit como **seção** apenas o que for
  útil ao PESSOAL — sem criar rota nova.
- **Quebra por projeto (`ExpenseKpiCards`):** decidir (com a fonte única da Fase 0) se vira uma seção
  do cockpit ou permanece só no portfólio `/financeiro`. **Não** duplicar o cálculo.
- **Princípio (reforço da §0.8):** uma única entrada ("Cockpit"), navegação **Mês / Ano** + toggle
  **Gastei / Vai sair**. Estender o cockpit, nunca telas paralelas.

---

## 10. Gaps de mercado (controle financeiro pessoal) — backlog priorizado

Referência: YNAB, Mobills, Organizze, Mint. O que falta para o cockpit ficar competitivo, em ordem
de valor/esforço:

1. **Orçamento por categoria (budget vs realizado)** — *alto valor, ausente hoje.* Definir teto
   mensal por categoria e mostrar progresso/estouro. Casa com `CategoriasBarras` (já existe a base de
   gasto por categoria). Requer modelo de budget por categoria/mês (nova tabela) — fase própria.
2. **Faturas de cartão por vencimento** — coberto pelas Fases 1–2.
3. **Comprometimento futuro / parcelas** — coberto pela Fase 3.
4. **Recorrências & aportes** — coberto pela Fase 4.
5. **Reserva de emergência / metas** — parcial (`reservaMeses` em `derive.ts`); evoluir para meta
   configurável com barra de progresso.
6. **Alertas proativos** — `Recomendacoes.tsx` existe; expandir para: estouro de orçamento, fatura
   acima da média, saldo projetado negativo no fim do mês.
7. **Patrimônio / net worth consolidado** — `EvolucaoPatrimonioChart` existe; avaliar somar contas +
   investimentos como patrimônio líquido.

> **Sugestão de corte:** Fases 1–3 entregam o coração da visão (competência/caixa + comprometimento).
> Fase 4 (aporte) e o item 1 de mercado (orçamento) são os próximos maiores saltos. Os demais são
> incrementais.

---

## 11. Decisões de produto — RESOLVIDAS em 2026-06-16 (Gabriel)

1. ✅ **Fonte única / `/financeiro`:** **fundir no Cockpit.** `monthly-overview` é o motor canônico;
   `/financeiro` descontinuado (redireciona p/ Cockpit); peças úteis migram como seção. Ver Fase 0 §2.0.
2. ✅ **Eixo padrão do cockpit:** **Competência ("Gastei").** Ver Fase 2 (§5).
3. ✅ **Convenção de fechamento:** compra **no dia do fechamento → PRÓXIMA fatura** (`dia >= closingDay`
   → mês seguinte). Ver Fase 1 §3.1.
4. ✅ **Aporte:** **fora do escopo ("pode tirar")** — deferido junto com o modelo de investimento/
   patrimônio. Fase 4 reduzida ao opcional de assinaturas. Ver Fase 4 (§7).
5. ⏸️ **Orçamento por categoria:** **deferido (visão futuro).** Distinção: hoje há gasto-por-categoria
   (`CategoriasBarras`, descritivo); orçamento = teto/meta por categoria com alerta de estouro
   (prescritivo) — **não existe**. Decidir depois.
6. ⏸️ **Resgate/aplicação (§2.0.4):** **deferido (decidir depois).** A assimetria está documentada;
   correção não será aplicada agora.
7. ✅ **Conciliação cross-project (Fase 6):** **não-destrutiva** (`settledByExpenseId`, reversível) +
   **valor real SEMPRE substitui o planejado** quando diverge (planejado guardado só como snapshot de
   unlink). Sem exibição planejado×pago lado a lado. Ver Fase 6 (§8).

> **Deferidos (visão futuro, não atuar agora):** orçamento por categoria (#5), assimetria resgate/
> aplicação (#6), aporte + conta de investimento/patrimônio (#4 / nível 2 da memória).

---

## 12. Ordem de execução e dependências

```
Fase 0 (FONTE ÚNICA + IA) ──► obrigatória antes de qualquer Fase nova
        │
        ▼
Fase 1 (derivação caixa) ──► Fase 2 (toggle) ──► Fase 3 (comprometimento)
        │
        └──► Fase 5 (card de despesa: "vence em")
Fase 4 (recurring/aporte) — independente, pode ir em paralelo (após Fase 0)
Fase 6 (conciliação cross-project por parcela) — independente (após Fase 0); reusa seriesKey/paidParcelas
Gap de mercado #1 (orçamento) — fase própria, depois das Fases 1–4
```

- **Fase 0 é pré-requisito de TUDO** — sem fonte única, as visões novas divergem.
- **Fase 1 é pré-requisito** de 2, 3 e do "vence em" da 5.
- **Fase 4 e Fase 6** não dependem das visões novas (só da Fase 0); podem ir em paralelo.
- Cada fase: TDD nas funções puras de domínio primeiro (já há padrão de `.spec.ts`/`__tests__`),
  depois fiação de API e UI. Rodar `npm run build` no domínio após mexer em `packages/domain`.

---

## 13. Higiene paralela (não bloqueia, mas anotar) — vinda dos relatórios

Dos relatórios de reconciliação existentes (`DIAGNOSTICO_CAIXA_INT_PM.md` /
`RELATORIO_RECONCILIACAO_PESSOAL.md`) — **não são da visão, mas estão em aberto:**

- **`reconcile.py`** (`tools/financial-analysis/`) tem filtro `linked_expense_id IS NULL` que diverge
  da regra real do §10 (que NÃO filtra vinculados). Falso positivo de "caixa inflado". Corrigir só a
  §10 da ferramenta para espelhar `computeCaixaConta`.
- **Lixo de teste E2E em prod:** expense `[E2E test bug2] NT /PM SAO PAU` (soft-deleted) no projeto
  "Minha Casa" — investigar por que um E2E escreveu em prod.
- **`RELATORIO_RECONCILIACAO_PESSOAL.md` se autocontradiz:** §1 corrigido ("app correto") vs §7 com a
  conclusão velha ("bug de dados"). Colapsar num só relatório ou marcar o §7 como superado, para a
  próxima sessão não ler a conclusão errada. O `DIAGNOSTICO` é a versão autoritativa.
- **A recomendação do §7 de "desvincular o INT/PM" está ERRADA** e não deve ser executada: o §10 já
  conta o lançamento corretamente *com* o vínculo (ver auditoria de vínculos na Fase 0 §2.0.3). A
  divergência da página `cash-flow` é bug de regra de consumo (filtro cego `linkedExpenseId: null`),
  corrigido na Fase 0 — não mexendo no dado.
