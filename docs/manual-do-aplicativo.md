# Manual do Aplicativo — LifeOne

> Documento funcional completo, tela por tela. Descreve o **propósito** de cada
> tela, o que cada **KPI** representa, o que cada **botão** faz, o que cada
> **filtro/toggle** realiza, os **campos e validações** dos formulários, os
> **estados** (carregando/vazio/erro) e o **processo de negócio** por trás.
>
> Público: qualquer pessoa que precise entender o que o app faz, sem ler código.
> Base: comportamento real do código em `apps/web` e `apps/api`.

---

## Índice

1. [Visão geral do produto](#1-visão-geral-do-produto)
2. [Conceitos-chave (ler antes)](#2-conceitos-chave-ler-antes)
3. [Telas globais e navegação](#3-telas-globais-e-navegação)
4. [Projeto PESSOAL](#4-projeto-pessoal)
5. [Projeto REFORMA](#5-projeto-reforma)
6. [Projeto CASA](#6-projeto-casa)
7. [Projeto CARRO](#7-projeto-carro)
8. [Projeto COMPRA](#8-projeto-compra)
9. [Glossário](#9-glossário)

---

## 1. Visão geral do produto

O **LifeOne** é um app de gestão financeira e de projetos de vida. Tudo é
organizado em **Projetos**, e cada projeto tem um **tipo** que define quais
módulos (abas) ficam disponíveis:

| Tipo | Para quê serve | Módulos disponíveis |
|---|---|---|
| **PESSOAL** | Controle do dinheiro pessoal (o "cockpit" da sua vida financeira) | Cockpit, Visão Conta, DRE, Despesas, Recebimentos, Fluxo de Caixa, Cartões, Contas, Metas, Planning, Budget |
| **REFORMA** | Controle financeiro e visual de uma obra/reforma | Dashboard, Despesas, Recebimentos, Fluxo de Caixa, Cômodos, Plantas, Simulação, Cronograma, Comparar Preço, Pendências |
| **CASA** | Gestão da casa (contas fixas, manutenções, lembretes) | Dashboard, Contas recorrentes, Manutenção, Lembretes, Despesas |
| **CARRO** | Gestão do carro | Dashboard, Carro (dados), Contas recorrentes, Manutenção, Lembretes, Despesas |
| **COMPRA** | Acompanhar uma compra grande (casa, carro etc.) | Dashboard, Despesas, Recebimentos, Fluxo de Caixa |

> Os módulos e sua ordem de navegação por tipo vivem em
> `packages/domain/src/config/module-navigator.ts`.
> No celular, os módulos autorizados que não ficam na barra inferior são abertos
> pelo botão **"Mais"** do cabeçalho — nunca somem.

Um projeto **PESSOAL** é o **controlador universal do caixa**: é dele que se pode
alocar orçamento para os outros projetos (Budget) e vincular despesas de outros
projetos (espelho/rateio).

---

## 2. Conceitos-chave (ler antes)

Estes conceitos aparecem em várias telas. Entendê-los evita confusão nos números.

### 2.1 Competência × Caixa (os dois "eixos de tempo")
- **Competência** = pela **data do fato** (quando a compra foi feita / a receita
  foi lançada), independentemente de quando o dinheiro entra ou sai.
- **Caixa (Conta Corrente)** = pela **data do dinheiro** (quando efetivamente sai
  da conta ou entra nela). Uma compra no cartão em julho, com fatura que vence em
  agosto, conta em **julho** por competência e em **agosto** por caixa.

Vários módulos (Cockpit, DRE) têm um **toggle** para alternar entre os dois.

### 2.2 Caixa real (§10) — "o dinheiro de verdade na conta"
O **Caixa** mostrado no app não é um saldo estimado: é reconciliado com o banco.

```
saldo hoje = saldo inicial da conta (numa data de referência)
           + todos os lançamentos REALIZADOS da conta corrente
```

- "Lançamento da conta" = qualquer despesa/recebimento com **conta bancária**
  preenchida (`bankLast4`) e já efetivado.
- **Compras no cartão NÃO entram no caixa** enquanto a fatura não é paga — elas
  estão na fatura, não na conta.
- Lançamentos futuros (ainda não pagos) não entram no caixa.

### 2.3 Neutros — movimentos que **não são consumo**
Alguns lançamentos movem dinheiro mas não são "gasto de verdade": pagamento de
fatura de cartão, transferência interna, "Pix no crédito", cartão que paga a
fatura de outro cartão. São os **neutros**. Eles:
- **não** entram no "quanto gastei" (para não inflar o gasto),
- **não** aparecem no DRE como despesa,
- podem afetar o caixa (se saíram de uma conta) ou compor a fatura (se foram
  cobrados no cartão), conforme onde a cobrança caiu.

Há **dois graus** de neutro (não confundir):
- **Neutro de liquidação** (os exemplos acima): o dinheiro só troca de lugar —
  fora do gasto **e** fora do eixo de caixa (a saída real já está contada em
  outro lançamento).
- **Neutro de consumo**: **aporte em investimento** (saída) e **resgate**
  (entrada). Não são gasto nem renda — mas o dinheiro **realmente** saiu/entrou
  na conta, então **continuam no caixa**. No app, o aporte aparece como
  "**Guardado**" (informação, não despesa); rendimentos (juros) são receita real
  e contam normalmente.

### 2.4 Faturas de cartão
Uma **fatura** é a soma das compras de um cartão com vencimento num certo mês. O
app agrupa as compras por cartão + mês de vencimento (calculado a partir do dia de
fechamento e vencimento do cartão) para **espelhar exatamente** o que o banco
cobra. **Pagar a fatura** é um lançamento **neutro** que reduz o caixa (o dinheiro
sai da conta) mas não é um novo gasto (o gasto já foi contado quando a compra foi
feita).

### 2.5 Espelho / Rateio (vínculo entre projetos)
A partir do PESSOAL, é possível **vincular** uma despesa a outro projeto (ex.: um
material comprado que pertence à Reforma). Isso cria um **espelho**: o dinheiro
saiu do caixa pessoal, mas o gasto é atribuído ao projeto de destino. O app
**deduplica** espelhos para não contar o mesmo valor duas vezes no consolidado.
O **rateio** permite dividir uma despesa entre vários destinos.

### 2.6 Status dos lançamentos
- Despesa: **Planejado** (previsto, ainda não pago) ou **Pago** (já saiu).
- Recebimento: **Previsto** (ainda não caiu) ou **Em Caixa/Recebido** (já caiu).

---

## 3. Telas globais e navegação

### 3.1 Login (`/login`)
- **Propósito:** autenticar o usuário.
- **Campos:** usuário e senha.
- **Ação "Entrar":** valida as credenciais; em sucesso, leva para o Hub (Meus
  Projetos); em erro, mostra mensagem de credencial inválida.

### 3.1b Registro (`/register`)
- **Propósito:** criar uma nova conta (tenant + usuário).
- **Campos:** nome do espaço, nome do usuário, usuário (login), senha,
  confirmação de senha, objetivos (seletor de tipos de projeto).
- **Ação "Criar conta e continuar":**
  - Se PESSOAL está entre os objetivos: redireciona para o **fluxo de setup guiado** (`/onboarding/pessoal-setup`).
  - Caso contrário: redireciona para o Hub com modal de criar projeto aberto.

### 3.1c Onboarding "do zero" (`/onboarding/pessoal-setup`)
Fluxo guiado para novos usuários que escolheram PESSOAL. Stepper de 4 passos:

1. **Projeto:** cria automaticamente o projeto PESSOAL (nome editável, padrão "Minha vida financeira").
2. **Conta bancária:** banco, apelido, últimos 4 dígitos, e o campo-herói **"Quanto você tem na conta hoje?"** (saldo inicial + data=hoje). É a base do Caixa Real no cockpit. **Pular é possível**, mas exibe aviso explícito: "sem isso, o Caixa mostrado não será o saldo do banco".
3. **Cartão de crédito (opcional):** banco, bandeira, últimos 4, dia de fechamento e dia de vencimento. Microcopy explica por quê ("é o que permite prever sua fatura").
4. **Pronto:** redirect automático para o Cockpit do PESSOAL.

O critério central: quem segue o caminho feliz vê, no primeiro minuto, um Caixa que é o saldo real digitado.

### 3.2 Hub — Meus Projetos (`/projects`)
Ponto de entrada depois do login. Lista todos os projetos que o usuário pode ver.

- **Eyebrow "LIFEONE" + título "Meus Projetos":** identidade da marca.
- **Campo de busca ("Buscar projeto…"):** filtra a lista em tempo real por
  **nome**, **descrição** ou **tipo** do projeto. Sem resultado → mensagem
  "Nenhum projeto encontrado para '…'".
- **Card "Saúde financeira consolidada":** atalho para `/financeiro` (visão de
  todos os projetos juntos). Só aparece se o usuário tem o módulo
  `financialDashboard` liberado.
- **Lista/grade de projetos:** cada card mostra o **ícone e a cor** do tipo, o
  **nome**, e uma **pílula com o tipo** (Pessoal/Reforma/Casa/Carro/Compra).
  Clicar abre o projeto (vai para o Dashboard/Cockpit dele).
- **Botão "Novo Projeto" / FAB "+":** abre o modal de criação. Só habilitado se o
  usuário tem permissão para criar ao menos um tipo (`canCreateProjectType`).
  - Modal de criação: **Nome**, **Tipo** (apenas os tipos permitidos ao usuário) e
    **Descrição**. Ao criar, o projeto é aberto direto no Dashboard.
- **Estados:** carregando (spinner); vazio ("Nenhum projeto ainda" ou "Você não
  tem acesso a nenhum projeto", com orientação para pedir liberação ao admin).

### 3.3 Casca do projeto (navegação dentro de um projeto)
Ao entrar num projeto, aparece a **casca** comum a todos os módulos:

- **Cabeçalho:** botão **"‹ Projetos"** (volta ao Hub), **chip do projeto** (ícone
  colorido + nome), **sino de notificações** e, no celular, o botão **"Mais"**.
- **Barra inferior (celular):**
  - No **PESSOAL**, mostra **"Cockpit"**, **"Despesas"**, **"Maria"** e **"Cartões"**, com botão circular **"Lançar"** separado.
  - Nos demais tipos, mostra os três primeiros módulos autorizados para a pessoa,
    conforme a ordem de navegação do tipo.
  - O item ativo usa a **cor de destaque do tipo do projeto**.
- **Painel "Mais" (celular):** abre pelo botão do cabeçalho e reúne os demais
  módulos autorizados + (se for admin) atalho **"Usuários"** + botão **"Sair"**.
- **Sidebar (telas médias ou maiores):** apresenta a navegação autorizada em coluna
  lateral.
- **Permissões:** só aparecem os módulos que o usuário tem liberados; um módulo
  bloqueado por permissão nunca aparece na barra nem no "Mais".

### 3.4 Copiloto "Maria"
No projeto **PESSOAL**, o atalho **"Maria"** da barra inferior abre o assistente
financeiro em tela própria (chat em tela cheia no mobile).

- Mostra abertura proativa com leitura do mês atual.
- Aceita texto e voz (STT), e a resposta da Maria pode ser reproduzida por áudio (TTS).
- A ação **Editar** em sugestões abre o mesmo sheet de lançamento usado no app.

### 3.5 Notificações (sino)
Mostra avisos e pendências do sistema. O contador no sino indica quantos itens não
lidos existem.

### 3.6 Saúde financeira consolidada (`/financeiro`)
Dashboard que **junta todos os projetos** do usuário numa visão única (caixa,
entradas, saídas, comprometimentos consolidados). Só disponível para quem tem o
módulo `financialDashboard`.

### 3.7 Admin — Usuários (`/admin/users`)
Área do administrador. Permite gerenciar usuários e o que cada um pode acessar:
**módulos liberados**, **tipos de projeto** que pode criar e **acesso a projetos
específicos**. Essas permissões são o que controla o que cada pessoa vê no app.

---

## 4. Projeto PESSOAL

O tipo mais completo. Foco no controle do dinheiro do dia a dia.

### 4.1 Cockpit (`/monthly`)
A tela-mãe do PESSOAL. Responde "como está meu mês?".

**Controles do topo:**
- **Toggle Mês / Ano:** alterna entre a visão mensal e a anual.
- **Navegação ‹ › + mês:** troca o mês/ano em foco.
- **Eixo do mês (segmented):** **Caixa** (visão canônica do mês) ou **Extrato** (lista cronológica de saídas).
- **Botão "Atual"** (quando aplicável) volta para o mês corrente.

**Hero do topo:**
- Semáforo de fechamento (**No caminho / No limite / Fecha no vermelho**) baseado na projeção de caixa do mês.
- Valor principal mostra **Caixa hoje** (ou **Resultado realizado** quando não há saldo inicial cadastrado).
- **Banner de estado degradado:** quando `temSaldoInicial=false`, aparece um aviso
  persistente "Caixa mostrando só o fluxo — defina o saldo inicial para bater com o
  banco" que leva diretamente à edição da conta bancária.
- **Barra de progresso do mês** + frase narrativa de fechamento.
- **Dropdown "Recomendações"** (minimizado por padrão): dicas automáticas —
  projeção de fechamento e quanto cortar por dia para equilibrar, maior gasto
  variável, contas a vencer, e status da reserva de emergência.

**KPIs do mês (eixo caixa):**
| KPI | O que representa |
|---|---|
| **Entrou em {mês}** | Recebimentos já efetivados na conta no mês + indicação do que ainda falta receber. |
| **Saiu em {mês}** | Saídas do eixo de caixa (já saiu + ainda vai sair), incluindo faturas vencendo no mês. |
| **Sobra prevista** | Fechamento esperado do mês (`caixaHoje + aReceber - aPagar`), mesma fonte da Visão Conta. |

Cada KPI tem um **botão de ajuda (ⓘ)** que explica o cálculo ao passar o mouse.

**Widget "Quanto gastei":**
- Mostra **quanto foi gasto por cartão e por conta** no mês, respeitando o mês e o
  contexto da visão mensal de caixa (não aparece na aba Extrato).
- **Exclui neutros** (pagamento de fatura não conta como gasto).
- Cartões aparecem como mini-cartões com gradiente; contas como linhas. Ordena do
  maior para o menor e esconde origens sem gasto. Link **"ver"** leva ao módulo do
  cartão/conta.

**Gráfico "Fluxo de caixa do mês" (visão Mês):**
- Linha do saldo ao longo do mês (começa no caixa real; inclui cartão ainda não
  debitado como projeção).
- **Slider "Ritmo de gasto diário":** simula quanto você gastaria por dia; abaixo,
  *"Se manter esse ritmo, termina o mês com R$ …"* recalcula o fechamento
  projetado. Link **"média atual"** volta o slider ao ritmo real do mês.

**Seções da visão Mês (abaixo do gráfico):**
- **Principais gastos:** barras por categoria (participação % no mês).
- **Comprometimento futuro (cartão):** parcelas/lançamentos planejados por mês de
  saída, no eixo atual (quanto do futuro já está comprometido).
- **Saúde financeira:** reserva de emergência (meses de despesa cobertos) e sinais.

**Aba Extrato:**
- **Extrato de saídas:** todas as saídas do mês em ordem de data, agrupadas por dia.
- KPIs da visão: **Total de saídas no mês**, **Já saiu (realizado)** (parte já
  paga), **Ainda vai sair (planejado)** (saídas ainda não pagas — parcelas e
  contas previstas), **Ticket médio** (valor médio por lançamento = total ÷ nº de
  lançamentos).

**Visão Ano:**
- **Resultado do ano**, **Taxa de poupança**, **Evolução do patrimônio**,
  **Categorias do ano** e comparativos mês a mês.

### 4.2 Visão Conta (`/conta`) — apenas PESSOAL
Foca no **caixa real** da conta e nas **faturas de cartão**. Responde "quanto tenho
e o que ainda vai sair?".

**Cabeçalho:** título "Visão Conta" + mês; toggle **Mês / Ano todo**; seletor de
mês (‹ › + calendário).

**Ações rápidas (topo):**
- **"Nova Despesa"** → abre o **assistente guiado de despesa** (o mesmo do módulo
  Despesas): escolha inicial *Nova despesa paga* × *Pagar despesa planejada*, e
  então os passos Dados → Pagamento → Ação. Cria despesa simples (sem espelho por
  padrão); o vínculo/rateio é opcional.
- **"Nova Receita"** → modal de recebimento (Valor, Data, Tipo, Status).

**KPIs (ResumoCards):**
| KPI | O que representa |
|---|---|
| **Tenho na conta hoje** | O dinheiro disponível de verdade na conta agora, reconciliado com o banco (caixa real). Compras no cartão só entram quando a fatura é paga. |
| **Entrou no mês** | Recebimentos que já caíram na conta neste mês. |
| **Saiu no mês** | Tudo que já foi pago até hoje. |
| **Ainda falta pagar** | O que ainda vai sair até o fim do mês: faturas de cartão e contas em aberto. Clicável → filtra o que falta pagar. |
| **Sobra prevista** | Previsão do saldo no fim do mês: o que tem hoje + o que ainda entra − o que ainda falta pagar. Negativo = a conta deve fechar no vermelho. |

Os cards "Entrou/Saiu/Falta pagar" funcionam como **filtros rápidos** das
movimentações abaixo.

**Cartões e Contas (carrossel):**
- Cada **cartão** aparece com visual realista do banco, **fatura atual**, **vence
  em** e status (**A pagar / Parcial / ✓ Paga**). Clicar num cartão filtra as
  movimentações por ele.
- Quando a fatura está parcial, o card mostra **"R$ pago de R$ total"**.
- Cartões com intervenção manual exibem o indicador **"Ajuste manual"**.
- Cada **conta bancária** aparece como tile (instituição, final, saldo). Clicável
  para filtrar.
- **Pagar fatura** abre um diálogo (conta de débito + data) e registra um
  **lançamento neutro**: reduz o caixa, mas não é um novo gasto. Recalcula os KPIs.
- **Ajustar fatura…** abre formulário com valor (+/−), motivo e nota. O ajuste muda
  o espelho da fatura (valor bancário) sem virar consumo/caixa.
- **Marcar quitada com resíduo…** registra o resíduo declarado (com nota) e fecha a
  fatura mesmo com diferença de centavos/contestação.

**Movimentações:**
- Abas **Saídas / Entradas / Tudo**.
- Filtro de **origem** (Todos / uma conta / um cartão específico) e busca por
  descrição.
- Lista de lançamentos com ícone, descrição, data e valor (verde = entrada,
  escuro = saída). Estado vazio quando não há itens.
- Nas linhas de fatura, há ações rápidas **Ajustar** e **Resíduo**, além do status.

**Ticket médio:** valor médio por lançamento, com barras de apoio.

**Visão Ano todo:** gráfico de faturas por origem/cartão ao longo do ano, com
drill-down por origem (despesas relacionadas).

### 4.3 DRE (`/dre`) — Demonstrativo de Resultado
Mostra o resultado (receitas − despesas) de forma estruturada.

**Controles:** navegação **‹ Mês ›**; toggle **mensal / anual**; toggle
**Competência / Conta Corrente** (o eixo de tempo).

**Visão mensal:**
| Elemento | O que representa |
|---|---|
| **Hero "Resultado de [mês]"** | Por competência: o que entrou − o que saiu (e foi guardado), pela data dos lançamentos. Positivo = sobrou; negativo = faltou. Mostra delta vs. mês anterior. |
| **Entrou** | Total que entrou no mês por competência (receitas lançadas no mês). |
| **Saiu + guardou** | Total que saiu (despesas) somado ao que foi guardado/reservado, por competência. |
| **Barra Receita × Despesa** | Proporção visual entre receita e despesa, com a margem. |
| **Card Receitas** | Linhas de entradas + total. |
| **Card Despesas** | Linhas de saídas (cada uma com mini-barra proporcional) + total. |

No eixo **Conta Corrente**, os mesmos blocos passam a considerar só o que
efetivamente entrou/saiu da conta no mês ("O que entrou", "O que saiu", "O que
guardou" pela data de caixa).

**Visão anual:**
- **Resultado acumulado** (entradas − saídas − guardado no ano; positivo = sobrou),
  **entrou no ano**, **saiu no ano** (com média mensal), **mês mais crítico** (o de
  menor margem), gráfico com barras mês a mês e totais anuais.

### 4.4 Despesas (`/expenses`)
Onde se registra e acompanha tudo que se gasta. É o módulo mais rico.

**Cabeçalho:** saudação + "Despesas"; navegação de mês (‹ Jul 26 ›); botão
**"+ Nova despesa"**.

**Assistente "+ Nova despesa" (stepper):**
1. Garfo inicial: **"Nova despesa paga"** (já saiu) × **"Pagar despesa planejada"**
   (marcar uma futura como paga, escolhendo da lista).
2. Passo **Dados:** tipo da despesa, categoria (mão de obra quando aplica),
   ambiente (em Reforma), título, fornecedor.
3. Passo **Pagamento:** forma de pagamento; **Data do Pagamento** (caixa);
   **Data da compra** (competência); parcelamento (qtd + início) e vínculo a cartão/conta.
4. Passo **Ação:** **Planejar/Salvar** ou **Vincular** (rateio para outro projeto).
- No modal de opções também há **Planejar**, **Despesa recorrente** (mensal/quinzenal),
  **Lançar por voz** e **importação** (OFX/CSV de fatura/extrato).
- **Validações:** valor > 0; máscara monetária `1.234,56`.

**KPI hero "Gasto no mês":** total gasto no mês + **% pago** (barra), com
"Pago R$ X" e "A vir R$ Y".

**Mini-KPIs (eixo Gastar/competência):**
- **No cartão:** compras feitas no cartão neste mês (competência), independente de
  quando a fatura vence.
- **À vista:** compras pagas na hora (débito, PIX, dinheiro) neste mês.
- **A vir:** despesas planejadas ainda não confirmadas/pagas (parcelas e contas
  previstas).

**Mini-KPIs (eixo Caixa):**
- **Faturas** (faturas que vencem no mês), **Débitos** (saídas direto da conta),
  **Falta sair** (do que vai sair, quanto ainda não foi pago).

**Card do cartão (destaque):** o cartão com mais gasto, mostrando total, pago e
planejado.

**Filtros e visões:**
- **"Gastos por categoria"** (expansível): distribuição por categoria.
- Busca ("Buscar despesas…") + **Filtros** (período etc.).
- Visões: **Categoria** (agrupado por categoria), **Mês**, **Por projeto**
  (consolidado cross-project no PESSOAL), **Geral** (lista/extrato).
- Seletor de mês + **"Ano todo"**.

**Lista/tabela de despesas:**
- Cada linha: tipo/título, fornecedor, data, valor, **status** (chip que alterna
  **Planejado ⇄ Pago** ao clicar).
- Ações por linha: **Editar rápido**, **Editar completo**, **Copiar para outro
  mês/data**, **Alternar status**, **Excluir**, e (cross-project) **Criar despesa
  em outro projeto e vincular**.
- Seleção múltipla → **alterar data em lote** / marcar como pago em lote.

**Estados:** carregando, vazio, erro.

### 4.5 Recebimentos (`/receipts`)
Entradas de dinheiro (salário, dividendos, etc.).

- **Toggle "Por mês" / "Por tipo".**
- **Botão "Novo Recebimento":** modal com **Valor**, **Data**, **Tipo**, **Status**
  (Previsto / Em caixa).
- **KPIs:** **Total em caixa** (recebimentos confirmados) e **Total geral**
  (caixa + previsto).
- **Lista por mês:** cada mês mostra total, nº de itens e uma barra de progresso;
  expandível para ver os itens. Edição rápida inline; status alterna **Previsto ⇄
  Recebido** ao clicar; copiar para outro mês; excluir.
- **"Configuração rápida de recebimentos" (planejamento):** gera um plano
  automático a partir de **Salário mensal**, **Dividendos mensais**, **Juros de
  renda fixa**, com **mês inicial** e **quantidade de meses** (ex.: salário no dia
  X, % no dia 15).
- **Estados:** vazio ("Nenhum recebimento ainda").

### 4.6 Fluxo de Caixa (`/cash-flow`)
Projeção e realizado, lançamento a lançamento, por data.

- **KPIs:** **Saldo projetado** (inclui planejados e previstos) e **Saldo
  realizado** (apenas PAGO e EM_CAIXA), além de **Receitas** e **Despesas**.
- **Tabela** por data: Data, Tipo, Valor, Categoria/Subcategoria, Status,
  Parcela e saldos acumulados (projetado/realizado). No celular, vira lista de
  cards equivalente.
- **Estado vazio:** "Sem lançamentos no período".

### 4.7 Cartões (`/credit-cards`)
Gestão dos cartões de crédito.

- **Botão "Novo cartão"** e texto explicando a importação (OFX/CSV Itaú/Nubank):
  parcelas futuras entram como planejadas e viram pagas automaticamente quando a
  fatura do mês seguinte é importada.
- **Card por cartão:** visual realista do banco, final, bandeira, instituição,
  **fechamento** e **vencimento**, e (quando há limite/uso) status
  **DENTRO / ATENÇÃO / ESTOURADO** com barra de uso (usado/disponível/limite).
- **Badge "configurar" (deep-link):** cartões sem `closingDay` mostram badge
  vermelho "configurar" na carteira (tela Despesas e Visão Conta). Ao tocar,
  navega direto para o formulário de edição do cartão com foco no fechamento.
- **Ações por cartão:** **Vincular despesas** (+ painel de sugestões de vínculo),
  **Editar**, **Excluir** (com confirmação).
- **Importação de fatura:** ao importar, é possível **marcar a despesa planejada
  como paga** (vinculando a importação a ela) ou **excluir itens** da importação.
- **Estado vazio:** "Nenhum cartão cadastrado".

### 4.8 Contas Bancárias (`/bank-accounts`)
Gestão das contas.

- **Botão "Nova conta"** + explicação da importação de extrato (OFX/CSV/PDF):
  débitos viram despesas, créditos viram recebimentos, pagamentos de fatura são
  detectados automaticamente (evita dupla contagem); contas de utilidades e IPVA
  viram recorrências nos projetos de Casa/Carro automaticamente.
- **Card por conta:** instituição, **final**, **agência**, **conta**, **saldo**;
  configuração de **saldo inicial** (base do caixa real §10). Ações: **Vincular
  despesas**, **Vincular recebimentos**, **Editar**, **Excluir** (confirmação).
- **Deep-link do cockpit:** quando o cockpit exibe o banner de estado degradado
  (sem saldo inicial), leva para esta tela com o formulário de edição aberto.
- **Estado vazio:** "Nenhuma conta cadastrada".

### 4.9 Metas (`/metas`)
Limites de gasto por categoria no mês.

- **Cabeçalho** "Análise · [mês]" + botão **"Nova meta"** (Categoria + Limite
  mensal em R$).
- Quando há metas: **hero gasto × limite do mês** (barra) e **cards por
  categoria** (%, gasto/limite, "restam X" ou "X acima"). A barra muda de cor por
  status (normal / perto do limite / estourado).
- Ações: **criar / editar / remover meta**.
- **Estado vazio:** "Nenhuma meta definida" com CTA "Criar primeira meta".

### 4.10 Planning (`/planning`)
Cenários de projeção de longo prazo.

- **Hero** explicando o objetivo (simular o fluxo futuro para controlar saldos,
  antecipar risco de caixa e ajustar o budget).
- **Toolbar de cenários:** selecionar cenário, **+ Novo**, **Duplicar**,
  **Renomear**, **Excluir**.
- **Parâmetros do cenário:** meses no cenário, entrada média (R$/mês), despesa
  média (R$/mês), crescimento de entrada (% a.m.), etc. — ajudam a preencher novos
  meses.
- **Matriz** de receitas e despesas por mês, **resumo + gráfico de projeção**,
  **compromissos + tabela de projeção**. Permite adicionar mês e tipo de despesa.

### 4.11 Budget / Alocação de Budget (`/budget-allocation`)
Distribui o orçamento do PESSOAL para os outros projetos de vida.

- **Card "Budget Disponível":** **Disponível para Alocar** = recebimentos em caixa
  − (despesas do projeto pagas + planejadas + alocações existentes). Mostra o
  detalhamento (recebimentos em caixa, despesas do projeto).
- **"Nova Alocação":** **Projeto destino**, **Valor (R$)**, **Mês de referência**.
- **Histórico de alocações** e recálculo do saldo ao criar/excluir.

---

## 5. Projeto REFORMA

Foco em controlar o custo e a execução de uma obra.

### 5.1 Dashboard (`/dashboard`)
Visão geral da obra.
- **KPIs:** **Dinheiro disponível**, **Já pago**, e correlatos.
- **Gráfico "Despesas Mensais (Planejado × Pago)":** barras por mês comparando o
  previsto com o efetivamente pago.
- **"Saldo Acumulado do Fluxo de Caixa":** projetado (inclui planejados/previstos)
  × realizado (só pagos e em caixa).
- Próximas pendências.

### 5.2 Despesas / Recebimentos / Fluxo de Caixa
Mesmos módulos do PESSOAL (ver §4.4, §4.5, §4.6), adaptados ao contexto de obra —
com **Ambiente/Cômodo** nas despesas e os tipos de despesa próprios de reforma
(Material de Construção, Revestimento, Mão de Obra, Marcenaria, etc.).

### 5.3 Cômodos (`/rooms`)
Ambientes da reforma e custos por ambiente (cards de cômodos, itens e custos).
> Observação: superfície em evolução — pode não estar totalmente ativa como tela.

### 5.4 Plantas (`/floor-plans`)
Plantas da obra com marcações e vínculos.
- **Upload de planta** e **canvas** com zoom (in/out/reset).
- **Desenho de cômodos / marcações:** clicar num ponto da planta marca um objeto
  comprável ("Clique em um ponto da planta para marcar um objeto comprável").
- **Vincular marcação ↔ item comprável** (uma marcação já vinculada mostra "Já
  vinculado a outra marcação").
- **Imagens do cômodo + recorte (crop):** selecionar a área que aparece nos
  Compráveis; alternar remoção do fundo branco; remover recorte/imagem.
- **IA "Detectar":** identifica elementos na planta ("Elementos detectados").
- **Tour guiado** pela planta; navegação entre cômodos.
- Filtros: busca por nome/fornecedor; abas **Compráveis / Despesas**.

### 5.5 Simulação (`/simulation`)
Cenários de custo da obra.
- **Seletor de cenário** + toolbar: **+ Novo**, **Renomear**, **Duplicar**,
  **Excluir** (com "Excluir definitivamente"), **Salvar**, **Limpar**.
- Abas **Simulação / Compráveis Simulados / Comparar Cenários**.
- **KPIs:** **Total Recebimentos**, **Total Despesas** (com "Ajuste tipo"),
  **Saldo Final Projetado**.
- **"Simulação Rápida por Tipo":** ajustes por tipo de despesa (Real × Projetado),
  com toggle de "Ajustes ativos".
- **"Despesas do Fluxo de Caixa" (somente leitura):** usa checkboxes para
  incluir/excluir cada despesa real da projeção; **"Limpar Alterações"** desfaz.
  Aviso: despesas planejadas **sem data de pagamento** entram no Total mas não nas
  parcelas projetadas (definir datas em Despesas).
- Compráveis simulados: nome, URL do produto/imagem, ambiente, abrir link.

### 5.6 Cronograma (`/schedule`)
Etapas, tarefas e dependências da obra.
- **KPIs:** **% Concluído** (com barra), **Total Orçado**, **Custo Real**,
  **Desvio**, **Término Previsto**, **Dias de Atraso**.
- **"Configuração do Projeto"** (colapsável).
- **Etapas** (ex.: "DEMOLIR E RETIRADAS") com % de conclusão, expansíveis; cada
  **tarefa** tem datas (início → fim · duração), **slider de progresso %**, e ações
  (excluir). Duplo clique renomeia.
- **Predecessoras/dependências:** campo "Predecessoras (separadas por vírgula)";
  a data é calculada automaticamente a partir das dependências.
- **Botões:** **Nova tarefa**, **AddStage/AddTask**, **Importar** (modais);
  alternar visão da tabela (completa → compacta → só gráfico); tela cheia.
- Ações destrutivas (excluir etapa/tarefa) pedem confirmação.

### 5.7 Comparar Preço (`/price-compare`)
Cotações por item e fornecedor.
- **"Novo item"** a comparar; **cotações por fornecedor**; **melhor preço /
  economia** (KPI).
> Observação: superfície em evolução — pode não estar totalmente ativa como tela.

### 5.8 Pendências (`/pendencias`)
Quadro de pendências da obra.
- **Card de pendência:** título (ex.: "Comprar tinta do quarto"), **responsável**,
  detalhes. Ações: editar, **excluir pendência**.

---

## 6. Projeto CASA

Gestão da casa: contas fixas, manutenções e lembretes.

### 6.1 Dashboard (`/dashboard`)
Visão geral da casa (KPIs gerais, resumo, próximas pendências).

### 6.2 Contas recorrentes (`/bills`)
Contas fixas (luz, água, internet, gás…) e avulsas.
- **Abas "Recorrentes / Avulsas".**
- **"Total mensal estimado"** somando as recorrentes.
- **Botão "Nova conta recorrente":** Nome da conta, Categoria, Valor, Frequência,
  Vencimento, Status.
- **Dica contextual (hint):** ao criar uma conta em CASA/CARRO, aparece um aviso
  não-bloqueante: "Esta conta é debitada da sua conta pessoal? Para ela contar no
  seu caixa, lance como despesa recorrente no PESSOAL." Motivo: `recurringBills` de
  CASA/CARRO rastreiam o bem, mas NÃO alimentam o caixa consolidado (§10).
- **Tabela** (Conta, Categoria, Valor, Frequência, Vencimento, Status, ações):
  editar, **pausar/ativar**, excluir. No celular, a tabela rola horizontalmente
  para não cortar colunas/ações.
- **Aba Avulsas:** despesas pontuais (Data, Título, Categoria, Valor, Status,
  ações), com **Nova despesa avulsa** (Título, Valor, Categoria, Forma de
  pagamento, Data do pagamento, Fornecedor, Observações).

### 6.3 Manutenção (`/maintenance`)
Histórico e agenda de manutenções.
- **Botão "Nova Manutenção".**
- **"Próximas manutenções":** cards com o tipo, quando ("em X dias") e a data.
- **Tabela** (Tipo, Realizada, Próxima, Custo, Fornecedor, ações). No celular,
  rola horizontalmente. Ações: editar, excluir.
- Formulário: tipo, datas, custo, **Fornecedor (opcional)**, **Observações**.

### 6.4 Lembretes (`/reminders`)
Tarefas com prazo e prioridade.
- **Botão "Novo Lembrete"** (Título, Descrição opcional, data, prioridade,
  frequência).
- **Filtros (pills):** **Pendente / Concluído / Adiado / Todos**.
- **Card de lembrete:** título, data, frequência, badges de **prioridade** e
  **status**. Ações: **Concluir**, **Adiar**, **Editar**, **Excluir**.

### 6.5 Despesas (`/expenses`)
Despesas avulsas do lar (mesma mecânica do §4.4, com tipos próprios de casa).

---

## 7. Projeto CARRO

Igual ao CASA (Contas recorrentes, Manutenção, Lembretes, Despesas) **mais** o
módulo específico:

### 7.1 Carro — dados (`/car-info`)
Ficha do veículo (é um registro 1:1 com o projeto).
- **Botão "Salvar"** (mostra "Salvando…" / "✓ Salvo").
- **Identificação:** Marca, Modelo, Ano Fabricação, Ano Modelo, Cor, Placa.
- **Valores:** **Tabela FIPE** × **valor pago** (em centavos).
- **Quilometragem** + sinal de revisão (km atual/última revisão).

### 7.2 Manutenção do carro
Igual ao §6.3, com coluna **Km** adicional na tabela.

---

## 8. Projeto COMPRA

Para acompanhar uma compra grande (casa, carro, etc.).
- Módulos: **Dashboard**, **Despesas**, **Recebimentos**, **Fluxo de Caixa** —
  mesma mecânica descrita nas seções do PESSOAL/REFORMA.
- Tipos de despesa próprios: Entrada, Financiamento, Documentação, Cartório,
  Imposto, Seguro, Vistoria, Mudança, Outros.

---

## 9. Glossário

| Termo | Significado |
|---|---|
| **Competência** | Pela data do fato (compra/lançamento), não do dinheiro. |
| **Caixa / Conta Corrente** | Pela data em que o dinheiro entra/sai da conta. |
| **Caixa real (§10)** | Saldo reconciliado com o banco: saldo inicial + lançamentos realizados da conta. |
| **Neutro** | Movimento que não é consumo (pagar fatura, transferência, cartão paga cartão). Não vira gasto nem despesa no DRE. |
| **Guardado / Aporte** | Neutro de consumo: dinheiro que saiu da conta para investimento. Não é gasto, mas afeta o caixa. O resgate é o espelho (entra no caixa, não é renda). |
| **Fatura** | Soma das compras de um cartão com vencimento num mês; espelha o que o banco cobra. |
| **Pagar fatura** | Lançamento neutro que reduz o caixa; não é gasto novo. |
| **Espelho** | Despesa do PESSOAL vinculada a outro projeto; deduplicada no consolidado. |
| **Rateio** | Dividir uma despesa entre vários projetos de destino. |
| **Planejado / Pago** | Status de despesa (previsto × efetivado). |
| **Previsto / Em caixa** | Status de recebimento (a receber × recebido). |
| **Eixo de tempo** | No Cockpit mensal, alterna entre **Caixa** e **Extrato**; em outras telas pode alternar Competência ↔ Caixa. |
| **Ticket médio** | Total de saídas ÷ número de lançamentos. |
| **Reserva de emergência** | Quantos meses de despesa o caixa cobre. |

---

> **Nota de manutenção:** este documento descreve o comportamento observável do
> app. Regras financeiras detalhadas (caixa real, faturas, neutros, casamento
> pagamento→fatura, "cartão paga cartão") estão em `docs/cockpit-caixa-real.md` e
> `docs/visao-conta-faturas.md`. A configuração de módulos por tipo de projeto
> está em `packages/domain/src/config/project-features.ts`.
