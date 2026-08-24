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
   - 3.1 Login
   - 3.2 Registro
   - 3.3 Onboarding
   - 3.4 Convidado de demonstração
   - 3.5 Hub — Meus Projetos
   - 3.6 Casca do projeto
   - 3.7 Maria
   - 3.8 Notificações
   - 3.9 Saúde financeira consolidada
   - 3.10 Admin — Usuários
   - 3.11 Admin — Jornadas
   - 3.12 Tratamento de Erros e Estados de Carregamento
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
| **PESSOAL** | Controle do dinheiro pessoal (o "cockpit" da sua vida financeira) | Cockpit, Visão Conta, Cartões, Metas, Orçamento futuro, Compras e cenários, DRE, Fluxo de Caixa, Neutros, Recorrentes (+ drill-downs: Despesas/Recebimentos). **Budget** não é mais um módulo: virou histórico congelado, só para administradores — ver 4.11 |
| **REFORMA** | Controle financeiro e visual de uma obra/reforma | Dashboard, Despesas, Recebimentos, Fluxo de Caixa, Cômodos, Plantas, Simulação, Cronograma, Comparar Preço, Pendências |
| **CASA** | Gestão da casa (financiamento, contas fixas, manutenções, lembretes) | Dashboard, Financiamento, Contas recorrentes + Avulsas, Manutenção, Lembretes |
| **CARRO** | Gestão do carro | Dashboard, Carro (dados), Documentos, Financiamento, Contas recorrentes + Avulsas, Manutenção, Lembretes |
| **COMPRA** | Acompanhar uma compra grande (casa, carro etc.) | Dashboard, Despesas, Preços |

> Os módulos e sua ordem de navegação por tipo vivem em
> `packages/domain/src/config/module-navigator.ts`.
> No celular, os módulos autorizados que não ficam na barra inferior são abertos
> pelo botão **"Mais"** do cabeçalho — nunca somem.

Um projeto **PESSOAL** é o **controlador universal do caixa**: é dele que se
vinculam despesas de outros projetos (espelho/rateio). A alocação de orçamento
para outros projetos (Budget) foi **encerrada** e hoje só existe como histórico
somente leitura (ver 4.11).

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

Na **Visão Conta** (e também na lista de despesas mobile), o **aporte em
investimento aparece nas movimentações** — ele saiu da conta de verdade. Fica
fora do total "saiu no mês" (aporte não é gasto), e o filtro **"Investimentos"**
da barra de filtros permite escondê-lo quando você quer ler só o consumo. Já os
neutros de liquidação (pagamento de fatura, transferência interna, pagamento da
casa) não são listados como movimentação comum, porque a saída real já está
contada no outro lançamento.

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

É possível abrir os detalhes de um rateio tanto pela **compra-fonte no PESSOAL**
quanto por uma **despesa-alvo na REFORMA**. Nas visões **Mês** e **Categoria**
da REFORMA, **Edição completa** também fica alcançável em celulares
de 375/390 px. Ao abrir um alvo rateado, a seção carrega o rateio existente
canônico e lista, somente para leitura, **todas** as alocações da compra — não
apenas a primeira. Essa lista só aparece quando o usuário pode ver todos os
participantes e os valores fecham o total da compra.
Alvos sem permissão de visualização **não aparecem de forma alguma** — nem
título, nem fornecedor, nem projeto, nem contagem ou soma agregada — e, com
eles, o rateio inteiro deixa de ser detalhado: basta **um** participante que o
usuário não pode ver, ou um alvo removido, para a compra ser exibida como **não
rateada**, sem lista, contagem ou soma (#448 B1b). A resposta é idêntica à de
uma compra que nunca foi rateada, e o valor total aparece integralmente como
sobra. Mostrar só a parte visível seria pior do que não mostrar nada: como a
soma das alocações sempre fecha o total, o que sobrasse na conta revelaria
exatamente quanto foi para os alvos ocultos.

Na compra-fonte do PESSOAL, **Ratear** reabre o rateio com as alocações visíveis
já preenchidas, em vez de mostrar um rateio novo. Se houver alocações removidas,
o app impede a substituição silenciosa; se houver participantes que o usuário não
pode ver, o app nem sabe disso (#448 B1b) — quem barra é o **servidor**, que
reautoriza todos os participantes na hora de gravar e recusa a substituição sem
escrever nada.
Somente essa fonte permite **editar** ou **desratear**. Ao abrir pelo alvo na
REFORMA, o rateio é estritamente somente-leitura e não pode ser alterado nem
desfeito. Enquanto a compra-fonte estiver rateada, a opção de alterar/remover
seu vínculo (`linkedExpenseId`) continua bloqueada.

Na **Visão Conta** do PESSOAL, um rateio pago conta uma única vez: a
compra-fonte permanece nas Movimentações e em **Saiu no mês**, com sua origem
real (**Carteira**, conta ou cartão), e todos os alvos pagos do mesmo rateio
ficam fora desses dois cálculos. Por exemplo, uma fonte de **R$ 1.000** dividida
em **R$ 450 + R$ 300 + R$ 250** produz **Carteira: −R$ 1.000** e **Saiu no mês:
R$ 1.000**, sem somar novamente os três alvos.

Se uma parcela de uma despesa de outro projeto (CASA/CARRO/REFORMA/COMPRA) for
marcada como paga **direto no projeto de origem** (sem passar pelo vínculo do
PESSOAL), ela continua aparecendo na Conta do PESSOAL — agora como **realizada**
("Paga"), em vez de desaparecer da lista. O dinheiro que já saiu não some do
consolidado só porque não houve uma conciliação formal.

Um espelho pago no PESSOAL por **Carteira** também aparece na data real de seu
pagamento. Nesse vínculo legado, ele é a única representação do caixa: o app
não duplica a parcela planejada do projeto de destino no mesmo mês.

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
- **Ação "Criar conta e continuar":** cria a conta e redireciona para o
  **Hub — Meus Projetos** (`/projects`), onde o usuário é convidado a criar o
  primeiro projeto. Ao criar, o painel de onboarding aparece automaticamente
  sobre o Dashboard via o trigger `PROJECT_CREATED` (jornada genérica, ver §3.1c).

### 3.1c Onboarding (painel sobre Dashboard)
Assistente **genérico**, dirigido por configuração — todos os 6 tipos de projeto
(Reforma, Compra, Casa, Carro, Pessoal, Plantas) passam por ele. Agora é um
**painel que flutua sobre o Dashboard**, não uma rota dedicada (`/onboarding/setup`).
O painel é acionado pelo trigger `PROJECT_CREATED` ao criar novo projeto e contém
3 seções:

1. **Etapas de âncora, específicas do tipo** — cada tipo tem seu próprio
   conjunto, **configurável pelo admin** em `/admin/jornadas` (ver §3.9): ordem,
   quais telas aparecem, os textos e se cada tela é pulável ou obrigatória. A
   lista abaixo é o **padrão de fábrica**, usado enquanto ninguém alterou a
   jornada — e também quando a configuração não pode ser lida:
   - **Pessoal:** Conta bancária (com o campo-herói "Quanto você tem na conta
     hoje?" — base do Caixa Real) → Cartão de crédito → Despesa rápida →
     Recebimento rápido → **Pergunte à Maria** (ver abaixo, último passo).
   - **Reforma:** Despesa rápida.
   - **Compra:** Despesa rápida.
   - **Casa:** Conta recorrente (água, luz, condomínio…).
   - **Carro:** Dados do veículo (placa, modelo, ano…).
   - **Plantas:** Cadastro de planta (nome, espécie, ambiente…).
   - **Pergunte à Maria (só PESSOAL, só após criar a 1ª despesa):** é o
    **último passo**, logo antes de fechar o painel — assim tocar numa
    pergunta não abandona nenhum passo pendente (todos já foram concluídos).
    Aparece um passo opcional "Pergunte à Maria sobre esse gasto" com 2–3
    perguntas prontas, a primeira **derivada da categoria real** que a pessoa
    lançou (ex.: Mercado → "Quanto já gastei em Mercado este mês?"). Tocar numa
    pergunta abre a Maria já com o texto e **envia automaticamente uma vez** — a
    resposta usa os dados reais recém cadastrados. "Pular por agora" (um toque,
    sem confirmação) fecha o painel. Se a despesa foi pulada, este passo
    **não aparece**.

2. **Comportamento de saída:** ao fechar o painel (botão de X, clique fora ou "Concluir"),
   o usuário volta ao **Dashboard/Cockpit do projeto**. Diferentemente do fluxo anterior,
   não há rota dedicada pós-onboarding — tudo acontece no mesmo Dashboard.

O critério central permanece o mesmo do fluxo original do PESSOAL: quem segue o
caminho feliz sai do assistente com pelo menos um lançamento/dado real
cadastrado, e sempre passa pelo guia de apoio antes do cockpit.


### 3.1d Convidado de demonstração
Conta temporária criada pelo modo demonstração (`AUTH_ENABLE_GUEST=1`), sem
senha e com o tenant expirando em 14 dias.

- **O que o convidado enxerga:** exatamente os módulos dos tipos **PESSOAL** e
  **REFORMA** — os dois projetos que a semeadura de demonstração cria. A lista
  é **derivada** desses objetivos (mesma regra do registro por objetivos), não
  uma lista à parte: módulos exclusivos de COMPRA, CASA, CARRO e PLANTAS
  (financiamento, manutenção, lembretes, contas recorrentes, dados e documentos
  do veículo, diagnóstico de plantas) **não** aparecem na navegação.
- **O que o convidado não faz:** nada que seja administrativo — **Usuários**,
  **Jornadas**, **Histórico de Budget**, editar ou excluir projeto. Esses itens
  não aparecem na navegação e o servidor os recusa.
- **Ao converter a conta** ("reivindicar"), o convidado vira um usuário comum
  do próprio espaço, com os mesmos objetivos e permissões que já tinha — o
  mesmo formato de quem se cadastra por conta própria em `/register`.

> O papel sozinho **nunca** decide o que aparece: o convidado é identificado
> por marca própria, não por papel. Contas administrativas reais seguem vendo o
> aplicativo inteiro, inclusive quando não têm nenhum módulo concedido
> explicitamente.

### 3.2 Hub — Meus Projetos (`/projects`)
Ponto de entrada depois do login. Lista todos os projetos que o usuário pode ver.

- **Eyebrow "LIFEONE" + título "Meus Projetos":** identidade da marca.
- **Campo de busca ("Buscar projeto…"):** filtra a lista em tempo real por
  **nome**, **descrição** ou **tipo** do projeto. Sem resultado → mensagem
  "Nenhum projeto encontrado para '…'".
- **Saúde financeira consolidada:** a antiga tela `/financeiro` foi retirada da
  navegação. O cockpit PESSOAL e os dashboards por projeto permanecem como
  superfícies financeiras visíveis; a Maria continua podendo consultar os
  agregados financeiros autorizados pelo escopo de despesas/recebimentos.
- **Lista/grade de projetos:** cada card mostra o **ícone e a cor** do tipo, o
  **nome**, e uma **pílula com o tipo** (Pessoal/Reforma/Casa/Carro/Compra).
  Clicar abre o projeto (vai para o Dashboard/Cockpit dele).
- **Botão "Novo Projeto" / FAB "+":** abre o modal de criação. Só habilitado se o
  usuário tem permissão para criar ao menos um tipo (`canCreateProjectType`).
  - Modal de criação: **Nome**, **Tipo** (apenas os tipos permitidos ao usuário) e
    **Descrição**. Ao criar, o projeto abre no Dashboard com o painel de onboarding
    flutuando automaticamente (não há rota dedicada; tudo acontece no mesmo lugar).
- **Estados:** carregando (spinner); vazio ("Nenhum projeto ainda" ou "Você não
  tem acesso a nenhum projeto", com orientação para pedir liberação ao admin).

### 3.3 Casca do projeto (navegação dentro de um projeto)
Ao entrar num projeto, aparece a **casca** comum a todos os módulos:

- **Cabeçalho:** botão **"Projetos"** (leva ao Hub), **chip do projeto** (ícone
  colorido + nome), **sino de notificações**, botão **Feedback** (balão) e, no
  celular, o botão **"Mais"**.
- **Barra inferior (celular):**
  - No **PESSOAL**, mostra **"Cockpit"**, **"Conta"**, **"Maria"** e **"Cartões"**, com botão circular **"Lançar"** separado.
    - O **"+"** abre um **menu de modo** com as jornadas: **Despesa** (teclado numérico rápido), **Recebimento**, **Voz** (dita a despesa, mesma IA da Maria) e **Foto** (importa print/foto de **fatura de cartão** ou **extrato de conta**).
    - No modo **Escrito**, o **valor e o teclado numérico ficam juntos no topo** da folha, para o valor continuar à vista enquanto se digita. Logo abaixo vem **"De onde sai"**, que sempre oferece a **Carteira** (dinheiro / sem conta) além das contas e cartões cadastrados — dá para lançar **sem ter conta nem cartão**, e nesse caso a despesa entra no consolidado como Carteira. Quem já tem conta ou cartão continua caindo neles por padrão.
    - As **categorias aparecem direto** (atalho das 6 mais usadas + "ver todas"): tocar numa categoria já **preenche o título por trás**; o campo de texto vira detalhe opcional. Parcelas de cartão saem num seletor nativo **1–18x** ("À vista" para 1).
  - Nos demais tipos, mostra os três primeiros módulos autorizados para a pessoa,
    conforme a ordem de navegação do tipo.
  - O item ativo usa a **cor de destaque do tipo do projeto**.
- **Painel "Mais" (celular):** abre pelo botão do cabeçalho e reúne os demais
  módulos autorizados + (se for admin) atalho **"Usuários"** + botão **"Sair"**.
- **Sidebar (telas médias ou maiores):** apresenta a navegação autorizada em coluna
  lateral, **agrupada por finalidade** (ver §3.3a).
- **Permissões:** só aparecem os módulos que o usuário tem liberados; um módulo
  bloqueado por permissão nunca aparece na barra nem no "Mais".

### 3.3a Grupos da sidebar (desktop)
A coluna lateral **nasce recolhida** (só ícones, 64px) e pode ser expandida pelo
botão **"Expandir menu lateral"** no rodapé; a escolha fica guardada e volta na
próxima visita.

Os módulos aparecem agrupados por finalidade, sempre nesta ordem:

| Grupo | O que reúne (no PESSOAL) |
|---|---|
| **Hoje** | Cockpit |
| **Movimentações** | Visão Conta, Despesas, Recebimentos, Cartões, Contas |
| **Planejamento** | Recorrentes, Metas, Orçamento futuro, Compras e cenários |
| **Resultado** | DRE |
| **Auditoria** | Neutros, Fluxo de Caixa |

Nos demais tipos de projeto (Reforma, Compra, Casa, Carro, Plantas) a navegação é
uma **lista única**, apresentada como um só grupo **"Módulos"** — o agrupamento
não muda a ordem nem esconde nenhum módulo autorizado.

- **Recolhida:** uma **linha fina separa um grupo do outro**; o rótulo do grupo
  não cabe na largura, então **passar o mouse (ou dar Tab) num ícone mostra uma
  dica no formato `Grupo · Item`** — por exemplo, `Movimentações · Cartões`.
- **Expandida:** o nome do grupo aparece escrito acima dos seus itens e a linha
  separadora sai (o rótulo já separa).
- **"Projetos" fica ancorado no topo**, junto do chip do projeto, e não entra na
  lista rolável: ele **sai** do projeto, enquanto os grupos são lugares **dentro**
  dele. Por isso existe uma entrada só para o Hub, sempre visível sem rolar.
- **"Apoio", "Configurações", "Usuários" (admin) e "Histórico de Budget"**
  continuam **ancorados no rodapé** da coluna, fora da área que rola.

> **Grupo vazio não aparece.** Os grupos são montados a partir dos módulos que
> **você** tem liberados: quem não tem acesso a "Visão mensal", por exemplo, não
> vê os grupos **Hoje**, **Resultado** e **Auditoria** — eles não ficam vazios,
> simplesmente não existem, e as linhas separadoras acompanham. Por isso a
> quantidade de grupos varia de pessoa para pessoa. Administradores enxergam
> todos os módulos, independentemente da lista de permissões.

### 3.4 Copiloto "Maria"
No projeto **PESSOAL**, o atalho **"Maria"** da barra inferior abre o assistente
financeiro em tela própria (chat em tela cheia no mobile).

- Mostra abertura proativa com leitura do mês atual.
- No cockpit mensal, o CTA **"Ver detalhes"** dos cards de "Maria percebeu" abre
  a mesma tela **Maria** do projeto, para aprofundar o insight.
- Pode ser aberta **já com uma pergunta pré-preenchida e enviada** a partir do
  onboarding (passo "Pergunte à Maria", ver §3.1c): o texto chega via
  sessionStorage e dispara uma única vez; abrir a Maria por qualquer outro
  caminho mantém o campo vazio.
- Aceita texto e voz (STT). **Iniciar conversa por voz** abre o modo automático:
  depois de ouvir e responder, a Maria reproduz o áudio e reabre o microfone.
  Durante o aquecimento da voz, a resposta já fica disponível para leitura.
- Ao responder **"quanto eu tenho na conta?"**, usa o mesmo motor de saldo da tela
  **Conta** — o número que a Maria fala é o mesmo de **"Tenho na conta hoje"**,
  já com o **saldo inicial** cadastrado da conta e a sua data de corte. Não há
  duas contas diferentes do mesmo dinheiro.
- A ação **Editar** em sugestões abre o mesmo sheet de lançamento usado no app.
- No desktop, ao abrir o painel flutuante, o conteúdo usa **reserva total 408px:
  painel 384px + inset lateral 24px**; fechado, mantém o respiro padrão de 24px.
- Também pode consultar monitoramento de preços (watchlist) e busca avulsa de preços por produto via chat/voz.
- Também responde sobre manutenção de **CASA/CARRO/PLANTAS** (ex.: "quando foi
  a última troca de óleo?"), lendo os registros de manutenção do projeto —
  data, quilometragem (se veículo) e próxima prevista. Só leitura (v1); criar
  manutenção continua sendo feito no módulo Manutenção do projeto.

### 3.5 Notificações (sino)
Mostra avisos e pendências do sistema. O contador no sino indica quantos itens não
lidos existem.

Quando aberto dentro de um projeto, o sino mostra apenas itens daquele projeto
pela rota atual (`/projects/:projectId/...`).

### 3.6 Saúde financeira consolidada (`/financeiro`) — retirada da UI
A antiga tela consolidada e seus endpoints HTTP não fazem mais parte da
navegação do app. Para números financeiros visíveis, use o cockpit PESSOAL, os
dashboards por projeto e a Maria, que preserva consultas agregadas dentro do
escopo autorizado de despesas/recebimentos.

### 3.7 Admin — Usuários (`/admin/users`)
Área do administrador. Permite gerenciar usuários e o que cada um pode acessar:
**módulos liberados**, **tipos de projeto** que pode criar e **acesso a projetos
específicos**. Essas permissões são o que controla o que cada pessoa vê no app.
O painel também mostra **Projetos criados** e **Despesas criadas** por usuário,
para auditoria rápida de atividade.

### 3.8 Admin — Jornadas (`/admin/jornadas`)
Área do administrador que controla **as jornadas guiadas do app** — inclusive o
assistente que aparece ao criar um projeto (§3.1c). A tela tem uma **lista de
todas as jornadas** à esquerda e o **editor da selecionada** à direita.

- **Nova jornada** — cria uma jornada a partir de outra existente, usada como
  modelo (copia etapas e gatilhos, que depois são editados à vontade).
- **Onde aparece** — escopo do alvo (todos os projetos, um tipo de projeto ou um
  projeto específico), dispositivo (desktop, mobile ou ambos), repetição (uma vez
  por usuário, uma vez por projeto ou sempre), o que fazer quando a pessoa fecha
  antes de concluir, se pode atravessar projetos, e ativa/inativa.
- **Quando começa** — um ou mais gatilhos: cadastro concluído, projeto criado,
  acesso a uma tela ou clique numa ação.
- **Trilha de passos** — as etapas como **mini-telas numeradas**, na ordem em que
  o usuário as vê. Por etapa dá para **reordenar** (arrastando pela alça, pelos
  botões ←/→ ou só pelo teclado), **ligar/desligar** (a desligada fica esmaecida,
  marcada "Fora da jornada", e some da jornada real), **reescrever os textos**
  (título curto e texto de apoio), **marcar obrigatória ou pulável** (obrigatória
  esconde o "Pular por agora") e escolher entre experiência **Resumida** (fica
  sobre a tela atual, sem navegar) e **Completa** (leva à tela real do app).
  A trilha oferece tanto os **passos operacionais** de sempre (Despesa,
  Recebimento, Contas & cartões, Conta recorrente, Veículo, Planta) quanto,
  agora, as **telas do catálogo de resumos** (Dashboard, Cockpit, Visão Conta,
  DRE, Fluxo de Caixa, Recorrentes, Metas, Compras e cenários, entre outras) — dá para
  montar uma jornada guiada usando qualquer uma delas.
- **O que a experiência Resumida realmente mostra** — depende do que a etapa
  representa, resolvido automaticamente pelo executor, nesta ordem:
  1. Se a etapa tem um formulário operacional de verdade (Despesa, Recebimento,
     Contas & cartões etc.), a **mini-tela embute o formulário real** — a pessoa
     lança a despesa, cadastra a conta etc. sem sair do painel, com as mesmas
     regras e validações da tela cheia.
  2. Se a etapa é uma tela analítica do catálogo de resumos (Dashboard, Cockpit,
     Visão Conta, DRE, Gantt, comparação de simulações etc.), o painel mostra um
     **resumo com título, descrição e atalhos** ("Adicionar despesa", "Ver
     detalhes"…) para a tela real — nunca reproduz o dashboard/gráfico/lista
     inteiros dentro do painel.
  3. Se a etapa não se encaixa em nenhum dos dois casos (ex.: "Pergunte à Maria",
     "Feedback"), o painel mostra só o **texto de apoio** configurado — nunca
     quebra por causa de uma etapa sem tela própria.

As mudanças são **globais** e entram em vigor na próxima execução da jornada, sem
deploy. Só passam a valer depois de **Salvar jornada** — enquanto houver edição
pendente, o painel avisa "alterações não salvas".

> Os gatilhos **cadastro concluído** e **projeto criado** já apareciam como opção
> aqui, mas até a Fase A do motor genérico de Jornadas nenhum fluxo de produto os
> disparava de fato — só **acesso a uma tela** funcionava. Os dois agora disparam:
> o primeiro logo após o cadastro público, o segundo logo após criar um projeto
> em `/projects`.


Duas limitações propositais: o painel **reordena e configura as telas que
existem**, não cria telas novas (cada tela é uma funcionalidade do app); e
telas marcadas **"Condicional"** (ex.: "Pergunte à Maria") só aparecem quando
a condição delas acontece — ligá-la no painel não burla a condição.

Se a configuração não puder ser lida, o onboarding cai no **padrão de fábrica**
em vez de falhar: essa é a primeira experiência da pessoa no produto e não
depende do painel estar no ar.

### 3.9 Tratamento de Erros e Estados de Carregamento

#### Estados de Carregamento
Quando uma página está carregando dados, aparece um **skeleton animado** com a mesma
estrutura visual da página final, mas com blocos cinzentos que pulsam. Isto dá feedback
visual de que o app está funcionando, sem deixar a tela em branco.

#### Erros de Rede / Exceções Não Tratadas
Se ocorrer um erro não esperado durante a navegação:

- **Dentro de um projeto:** mostra uma tela de erro com a navegação do projeto
  preservada. O usuário consegue voltar ou navegar para outra seção sem recarregar
  a página. Dois CTAs estão disponíveis: **"Tentar novamente"** (tenta renderizar
  a página novamente) e **"Ir para Cockpit"** (navega para a visão principal).

- **Telas gerais** (fora de um projeto): mostra uma tela de erro genérica com botão
  **"Tentar novamente"** para renderizar de novo a rota atual.

- **Erro catastrófico no root layout:** último recurso. Mostra uma tela com botão
  **"Recarregar"** (recarrega toda a página no navegador). Raramente é acionado.

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
- **Narrativa de horizonte (runway) no próprio Cockpit:** o mesmo veredito multi-mês
  ("fica negativo em…"/"se mantém positivo até…") também aparece aqui, usando a mesma
  série do card "Vai dar até dez?" para evitar contradição com a Visão Conta.
  Quando o tom é vermelho, aparece o botão **"Como fechar no azul?"** (ver §4, Projeção multi-mês).
- **Dropdown "Recomendações"** (minimizado por padrão): dicas automáticas —
  projeção de fechamento e quanto cortar por dia para equilibrar, maior gasto
  variável, contas a vencer, e status da reserva de emergência.
- **Card "Precisa de você (N)"** (quando `N > 0`): mostra pendências financeiras
  acionáveis (sem conta, sem categoria com sugestão, **pagamento de fatura sem
  cartão identificado**, fatura a vencer, parcela cross-project pendente e
  recebimento previsto atrasado). Ao tocar, abre um
  painel que dispara os modais já existentes (vincular, pagar fatura, quitar
  parcela, editar despesa/recebimento) sem criar um fluxo paralelo.
  - **Pagamento de fatura sem cartão**: um pagamento de fatura que ficou sem cartão
    vinculado sai do seu caixa mas deixa a fatura em aberto — o mesmo dinheiro conta
    duas vezes. A fila é a única superfície que mostra esse item (ele é neutro, então
    não aparece nas Movimentações). Ao tocar em **"Escolher cartão"**, o app lista os
    cartões cuja fatura em aberto mais se aproxima do valor pago (com mês de vencimento,
    total da fatura e a diferença), e vincular já faz a Visão Conta reconhecer a quitação.

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
- **"Lançar"** (desktop) → abre o launcher canônico **"Novo lançamento"**.
- No **mobile**, o lançamento fica no botão **"+"** da barra inferior.
- **"Planejar recebimentos"** fica no fluxo do **"+" mobile**.

**KPIs (ResumoCards):**
| KPI | O que representa |
|---|---|
| **Tenho na conta hoje** | O dinheiro disponível de verdade na conta agora, reconciliado com o banco (caixa real). Compras no cartão só entram quando a fatura é paga. |
| **Entrou no mês** | Recebimentos que já caíram na conta neste mês. |
| **Saiu no mês** | Tudo que já foi pago até hoje — **inclui lançamentos sem conta vinculada (Carteira)**. Um rateio pago entra só pela compra-fonte, com sua origem preservada; os alvos pagos não são somados outra vez. Quando há lançamentos Carteira, aparece a nota "inclui R$ X sem conta vinculada" abaixo do valor. |
| **Ainda falta pagar** | O que ainda vai sair até o fim do mês: faturas de cartão e contas em aberto. **Só saídas** — recebimentos previstos não entram aqui. Clicável → filtra o que falta pagar. |
| **Sobra prevista** | Previsão do saldo no fim do mês: o que tem hoje + o que ainda entra − o que ainda falta pagar. Quando há recebimentos previstos, aparece a nota "inclui R$ X previsto ainda a entrar" abaixo do valor. Negativo = a conta deve fechar no vermelho. |

Os cards "Entrou/Saiu/Falta pagar" funcionam como **filtros rápidos** das
movimentações abaixo.

**Projeção multi-mês (runway):**
- A exploração da projeção fica no **Cockpit** (mobile e desktop), incluindo
  narrativa de horizonte e gráfico "Vai dar até dez?".
- Quando o saldo projetado fica negativo em algum mês futuro (tom vermelho),
  aparece o botão **"Como fechar no azul?"**. Ao tocar, abre um sheet com:
  - O quanto falta (valor do pior ponto, ex.: "−R$ 77 mil em dezembro").
  - A **lista dos até 5 maiores gastos planejados** até o mês do crossover
    (o mês onde o saldo vira negativo), com descricao, valor e projeto de origem.
  - Por item: **Adiar** (abre seletor de data), **Reduzir** (abre campo de valor)
    e **Remover** (exclui a despesa). Cada ação recalcula a projeção ao fechar.
  - Linguagem neutra: nunca sugere cortes específicos — o usuário decide.
  - Quando o saldo se mantém positivo (tom verde), o botão não aparece.

**Cartões e Contas (carrossel):**
- No mobile, aparece em **1 linha horizontal com scroll-snap** (card compacto por origem).
- Link **"Ver todos"** leva para `/credit-cards`.
- Cada **cartão** aparece com visual realista do banco, **fatura atual**, **vence
  em** e status (**A pagar / Parcial / ✓ Paga**). Clicar num cartão filtra as
  movimentações por ele.
- Quando a fatura está parcial, o card mostra **"R$ pago de R$ total"**.
- Cartões com intervenção manual exibem o indicador **"Ajuste manual"**.
- Cada **conta bancária** aparece como tile (instituição, final, saldo). Clicável
  para filtrar.
- **Pagar fatura** abre um diálogo (conta de débito + data) e registra um
  **lançamento neutro**: reduz o caixa, mas não é um novo gasto. Recalcula os KPIs.
  O app identifica cartão e conta pelo **identificador do cadastro** (não só pelos
  4 últimos dígitos). Se esses dados mudarem enquanto a tela está aberta, o
  pagamento é **recusado com mensagem** ("os dados do cartão ou da conta
  mudaram… atualize e tente de novo") em vez de ser gravado no cartão errado — o
  diálogo continua aberto para você tentar de novo.
  Se o projeto tiver **dois cartões ativos com o mesmo final** (dado antigo; hoje
  o cadastro impede criar o segundo), não há como saber qual pagar: a fatura
  aparece normalmente, mas **sem** os botões de pagar/desfazer, com o aviso "mais
  de um cartão com esse final — ajuste o cadastro para pagar". **Ajustar fatura…**
  continua disponível. Se a duplicidade for criada depois que a tela carregou, a
  ação é recusada com essa mesma explicação e nada é gravado (#448 B1b).
- **Ajustar fatura…** abre formulário com valor (+/−), motivo e nota. O ajuste muda
  o espelho da fatura (valor bancário) sem virar consumo/caixa.
- **Marcar quitada com resíduo…** registra o resíduo declarado (com nota) e fecha a
  fatura mesmo com diferença de centavos/contestação.
- **Desfazer pagamento** (desktop) aparece quando a fatura não está "A pagar".
  Abre um diálogo de confirmação (foco inicial em "Cancelar") explicando que as
  compras da fatura voltam a ficar pendentes e o lançamento de pagamento é
  removido. Só funciona quando há exatamente um pagamento casado com a fatura —
  se houver mais de um (pagamento parcial/duplicado), a ação é recusada com
  mensagem explicando que o desfazer automático não é seguro nesse caso. A opção
  só é oferecida quando o servidor confirma que **existe** um pagamento a
  desfazer para aquela fatura, e some no caso de final duplicado descrito acima
  (#448 B1b). Também está no sheet de ações do carrossel mobile e no menu "⋯"
  da linha de fatura em Movimentações.

**Precisa de você (fila de pendências):**
- Quando há pendências financeiras no mês, a Conta exibe o card **"Precisa de você"**
  antes do carrossel de cartões/contas.
- O card abre o mesmo sheet de resolução do Cockpit, sem criar fluxo novo.

**Movimentações:**
- Abas **Saídas / Entradas / Tudo**.
- Em **Saídas** e **Entradas**, aparece o link **"Ver análise completa"** para os
  drill-downs dedicados (`/expenses` e `/receipts`).
- **Visões (só saídas):** **Lista**, **Por categoria** e **Por projeto** — as duas
  últimas agrupam os gastos com subtotais e ícone da categoria (drill-down por linha).
- Filtro de **origem** (Todos / uma conta / um cartão específico), **categoria** e
  **projeto**, busca por descrição e ordenação por data. Toggle **"Sem conta"** filtra
  só os lançamentos sem conta/cartão vinculado. Quando há qualquer filtro ativo, aparece o
  botão **"Limpar filtros"** que zera todos de uma vez.
- **Lançamentos sem conta vinculada (Carteira):** exibem o chip cinza clicável **"Sem conta"**
  na linha de metadados. Tocar abre o fluxo de vínculo ("de onde saiu esse pagamento?"). Após
  vincular, o chip some e a conta/cartão vinculada aparece nos metadados.
- **Lançamentos sem categoria (`OUTROS`)** exibem chip de sugestão (ex.: **"Alimentação?"**)
  na própria linha da Lista. Um toque confirma a categoria e cria regra manual do merchant;
  o toast permite **desfazer** (reverte categoria + remove regra).
- Em **Análises (DRE)**, o botão de **engrenagem "Regras"**
  abre a gestão simples de regras de categoria (listar + excluir). Não há atalho na navegação primária.
  As regras valem só para a sua conta; um administrador pode promover uma regra a **global** (fallback para todas as contas).
- Layout canônico de linha financeira (mobile-first): **linha 1** com descrição
  + valor `nowrap` à direita (valor nunca divide linha com chip/badge variável),
  **linha 2** com metadados (data · categoria · origem) + chip "Sem conta" quando carteira
  + chip de projeto quando cross-project, e **status textual** ("Paga/A pagar/Previsto/Recebido")
  abaixo do valor, alinhado à direita. Estado vazio quando não há itens.
- As **faturas de cartão** podem ser **expandidas na própria linha** para revelar as
  compras que as compõem (no celular, tocando na linha). Nas linhas de fatura há
  ações rápidas **Ajustar** e **Resíduo**, além do status.

**Visão Ano todo:** o toggle **"Ano todo"** estica a Visão Conta para os 12 meses do
ano — é a mesma tela, não um resumo separado:

- **Gráfico de faturas** por origem/cartão ao longo do ano. Clicar num chip de origem
  ou numa barra de mês **filtra a lista abaixo** (o drill-down por origem/mês).
- **Cards de resumo** com os fluxos do ano: "Entrou no ano", "Saiu no ano" e
  "Ainda falta pagar no ano" — cada um é a **soma exata dos 12 meses**.
- **"Tenho na conta hoje"** continua sendo o saldo de **hoje**, não uma soma do ano.
  Saldo é uma foto do momento; somar 12 fotas iguais daria 12× o valor real.
- **"Sobra prevista no ano"** responde *"com o caixa de hoje, eu atravesso o ano?"*:
  parte do saldo de hoje e desconta tudo que ainda falta pagar até dezembro, somando o
  que ainda deve entrar. Negativo = o ano fecha no vermelho mantendo o plano atual.
- **Lista de movimentações do ano**: as mesmas linhas da visão mensal, agrupadas **por
  mês** (cada mês fecha o próprio subtotal), com os mesmos filtros — busca, tipo de
  despesa, status, projeto, origem — mais um filtro **"Mês do ano"**. Despesas sem
  conta/cartão (Carteira) aparecem normalmente, com o chip **"Sem conta"**.
- **Cartões não têm tiles aqui** e pagar fatura pelo ano não é possível de propósito: o
  número do ano é a soma de 12 faturas. Ao acionar uma fatura na lista, o app **troca
  para o mês daquela fatura** e abre o pagamento lá, com o valor certo.

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

**Ticket médio (migrado da Conta):**
- A seção de ticket médio (valor, série 6 meses e delta) agora fica em **Análises (DRE)**,
  usando os mesmos números da Visão Conta para o mês selecionado.

**Visão anual:**
- **Resultado acumulado** (entradas − saídas − guardado no ano; positivo = sobrou),
  **entrou no ano**, **saiu no ano** (com média mensal), **mês mais crítico** (o de
  menor margem), gráfico com barras mês a mês e totais anuais.

### 4.4 Despesas (`/expenses`)
No PESSOAL, esta tela é um **drill-down da Visão Conta**.

- Faixa superior: **"Visão por competência"** + link **"Voltar para Conta"**.
- Rótulo explícito: os números desta tela são de **competência** (não de caixa).
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
  **Novo recebimento**, **Lançar por voz** e **importação** (OFX/CSV de fatura/extrato).
- **Validações:** valor > 0; máscara monetária `1.234,56`.

**KPI hero "Gasto no mês":** total gasto no mês + **% pago** (barra), com
"Pago R$ X" e "A vir R$ Y".

- **Eixo do KPI Pago:** no **PESSOAL**, permanece por competência. Nos demais
  tipos de projeto, como **REFORMA**, usa as ocorrências no eixo de caixa e
  considera as parcelas registradas em `paidParcelas`; assim, o total do
  período/ano e os contadores de itens reconciliam com as ocorrências nos
  cabeçalhos mensais.

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
- Na visão por mês, **Editar rápido** permite trocar a data de uma única ocorrência
  **PARCELADO** ou **QUINZENAL** (inclusive 1x), paga ou planejada, tanto pela
  REFORMA quanto pelo PESSOAL. Só a data escolhida muda: número da parcela, valor
  e status são preservados. Pares REFORMA↔PESSOAL permanecem sincronizados. Em
  rateio, edite a compra-fonte; a fonte real de uma conciliação fica bloqueada e
  a data deve ser alterada na parcela planejada alvo.
- Seleção múltipla → **alterar data em lote** / marcar como pago em lote.

- **Origem do pagamento (cross-project, somente leitura):** fora do PESSOAL
  (ex.: REFORMA), cada linha/ocorrência de uma despesa que foi paga através de
  uma conciliação, rateio ou vínculo cross-project mostra um **badge
  discreto** com o cartão/conta que efetivamente pagou (ex.: "Nubank ••3541"
  ou, sem apelido, "Cartão ••3541"/"Conta ••5572"). Regras visíveis:
  - Cada **parcela** pode mostrar uma origem diferente (ex.: parcelas pagas
    por cartões distintos); na visão por categoria, quando a despesa tem mais
    de uma origem entre suas parcelas, o agregado mostra **"Múltiplas
    origens"**.
  - Uma compra **rateada** para vários alvos mostra a **mesma** origem em
    todos eles.
  - O badge é **só leitura** (não abre modal, não é botão) e não aparece
    quando a fonte é **Carteira** (sem cartão/conta), quando o usuário não tem
    acesso ao módulo/projeto da fonte, ou enquanto a origem está carregando/
    com erro — nesses casos a linha segue normal, sem quebra de layout.
  - Nunca alarga o layout nem introduz overflow horizontal em 375/390px.

**Estados:** carregando, vazio, erro.

### 4.5 Recebimentos (`/receipts`)
No PESSOAL, esta tela é um **drill-down da Visão Conta**.

- Faixa superior: **"Visão por competência"** + link **"Voltar para Conta"**.
- Rótulo explícito: os números desta tela são de **competência** (não de caixa).
Entradas de dinheiro (salário, dividendos, etc.).

- **Toggle "Por mês" / "Por tipo".**
- **Botão "Novo Recebimento":** modal com **Valor**, **Data**, **Tipo**, **Status**
  (Previsto / Em caixa).
- **KPIs:** **Total em caixa** (recebimentos confirmados) e **Total geral**
  (caixa + previsto).
- **Lista por mês:** cada mês mostra total, nº de itens e uma barra de progresso;
  expandível para ver os itens. Edição rápida inline; status alterna **Previsto ⇄
  Recebido** ao clicar; copiar para outro mês; excluir.
- **Ações da linha por tamanho de tela:** no **desktop** as três ações
  (**Copiar para outro mês**, **Editar rápido**, **Excluir**) aparecem como
  ícones na própria linha, ao passar o mouse. No **celular** elas ficam num
  menu **"⋯"** no fim da linha — o mesmo menu já usado em Recorrentes,
  Manutenção e Lembretes. A troca é só de apresentação: as ações são as
  mesmas, e linhas somente-leitura (alocações de orçamento) continuam sem
  nenhuma delas.
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

### 4.6b Recorrentes (`/recorrentes`) — apenas PESSOAL
As contas que se repetem todo mês, em um lugar só.

- **O que aparece:** apenas o que **você criou** como despesa recorrente (o
  toggle "repetir" ao lançar uma despesa). A tela **não adivinha** assinaturas a
  partir do extrato do cartão — merchant que se repete continua sendo despesa
  comum. Parcelamento não entra: tem fim, não é recorrência.
- **KPIs:** **Ativas** (séries com ocorrência futura) e **Por mês** (soma do
  valor atual das ativas).
- **Linha:** categoria, próxima data, quantas ocorrências a série tem e o valor.
  À direita, quantas ainda estão **a pagar**. O chip **Vinculada** marca série
  espelhada em outro projeto — editar aqui propaga para lá.
- **Editar** (valor e categoria) e **Excluir** valem **apenas para as
  ocorrências futuras**. O histórico já pago nunca é reescrito nem apagado — o
  aviso aparece no próprio modal, com a contagem do que será alterado.
- **Estado vazio:** "Nenhuma despesa recorrente ainda."

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
- **Estado vazio:** "Nenhum cartão cadastrado" — com o botão **"Novo cartão"**
  dentro do próprio aviso. Enquanto a lista está vazia esse é o **único**
  "Novo cartão" da tela: o botão do cabeçalho só reaparece quando existe pelo
  menos um cartão. Assim não há duas CTAs idênticas competindo na mesma tela.

### 4.8 Contas Bancárias (na Visão Conta, `/conta`)
A gestão essencial das contas correntes fica na própria Visão Conta, acima das
visões de Mês/Ano.

- A seção compacta lista a identidade de cada conta (apelido, instituição, final,
  agência e número), sem criar um segundo saldo calculado.
- **Editar conta e saldo inicial** abre o formulário existente de identidade e
  reconciliação; **Nova conta** usa o mesmo formulário.
- Quando há mais de uma conta, o deep-link sem uma conta específica pede uma
  escolha explícita. Um `accountId` inválido mostra erro em vez de editar outra.
- **Deep-link do cockpit:** o banner de estado degradado leva a
  `/conta?focus=openingBalance`, abrindo a criação, a conta única ou o seletor.
- Links antigos para `/bank-accounts` continuam compatíveis: redirecionam para
  `/conta` preservando todos os parâmetros da URL.

#### 4.8.1 Importar para Carteira (sem conta vinculada)

Permite importar um extrato ou fatura sem associar a uma conta cadastrada. O fluxo é:

1. **Tipo de documento** — escolha entre **Extrato bancário** ou **Fatura de cartão**.
2. **Seleção de arquivos** — envie um ou mais arquivos (OFX, CSV, PDF, imagem, XLSX).
   Se o PDF estiver protegido por senha, o app solicita a senha antes de prosseguir.
3. **Pré-visualização somente leitura** — o upload gera uma tabela com cada
   lançamento encontrado (data, descrição, valor, tipo e status). Nenhum dado é
   gravado nesta etapa; a prévia existe apenas para revisão.
4. **Confirmação explícita** — somente ao clicar em **Confirmar importação** os
   lançamentos são criados. Os registros vão para **Carteira / Sem conta** com os
   seguintes valores-padrão por origem:

   | Origem | Tipo | Status |
   |---|---|---|
   | Extrato — débito (saída) | Despesa | PAGO |
   | Extrato — crédito (entrada) | Recebimento | EM_CAIXA |
   | Fatura de cartão — compra | Despesa | PLANEJADO |

### 4.9 Metas (`/metas`)
Limites de gasto por categoria no mês.

- **Cabeçalho** "Análise · [mês]" + botão **"Nova meta"** (Categoria + Limite
  mensal em R$).
- Quando há metas: **hero gasto × limite do mês** (barra) e **cards por
  categoria** (%, gasto/limite, "restam X" ou "X acima"). A barra muda de cor por
  status (normal / perto do limite / estourado).
- Ações: **criar / editar / remover meta**.
- **Estado vazio:** "Nenhuma meta definida" com CTA "Criar primeira meta".

### 4.10 Orçamento futuro (`/planning`)
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

### 4.11 Alocação de Budget (`/budget-allocation`) — histórico congelado
O recurso foi **encerrado**: não se cria, edita nem exclui alocação (a API
responde 404 para qualquer papel). O que já foi registrado **continua no banco e
continua visível** — congelar preservando o histórico, não extinguir.

- **Quem vê:** apenas papel administrativo (ADMIN/OWNER) **não-convidado**, e
  apenas em projetos **PESSOAL**. O servidor é a autoridade; a tela apenas
  espelha esse gate para não disparar consulta que já sabe que tomará 403.
- **Como chegar:** item **"Histórico de Budget"** no bloco administrativo da
  navegação do projeto — na barra lateral no desktop e no menu **"Mais"** no
  celular, ao lado de "Usuários". Ele **não** faz parte da lista de módulos
  (`PROJECT_NAV`), porque o acesso aqui é por papel, não por módulo: pô-lo lá o
  exibiria para todo mundo, entregando 403.
- **Card "Resumo do Budget":** **Saldo não alocado** = recebimentos em caixa
  − (despesas do projeto pagas + planejadas + alocações existentes), com o
  detalhamento. O texto não promete alocação: numa tela congelada, esse número é
  resultado histórico, não verba disponível.
- **Histórico de alocações:** somente leitura. Relações de outro tenant aparecem
  como *Projeto indisponível* (redigidas pela API), com o valor preservado. O
  valor nunca quebra em duas linhas.
  - **No computador e no tablet** (largura ≥ 640px) o histórico é uma **tabela**
    com Data, Projeto, Mês Ref. e Valor.
  - **No celular** (largura < 640px) a mesma informação vira **lista empilhada**,
    no mesmo padrão das linhas de Visão Conta: o **valor** fica à direita, em
    destaque e sempre inteiro; o **nome do projeto** é o título, em até duas
    linhas; e **data · mês de referência · descrição** ficam abaixo, como apoio.
    **Nada é omitido** — num histórico congelado, esconder campo seria decidir
    sobre o dado, não sobre o layout. Se o nome do projeto for longo demais para
    duas linhas, é ele que é cortado, nunca o valor: numa trilha de auditoria é
    preferível trocar *"não sei quanto"* por *"não sei para quem"*. Antes desta
    mudança (#490) a tabela não cabia em 375px e a coluna **Valor** só ficava
    legível depois de arrastar a tela na horizontal.
- **Onde está o total:** o **"Total Alocado"** aparece **uma única vez**, no card
  "Resumo do Budget". O rodapé do histórico repetia o mesmo rótulo com um total
  somado por conta própria; dois números com o mesmo nome na mesma tela obrigam
  quem lê a conferir se batem, então ficou só o do card.

### 4.12 Compras e cenários (`/planejador`) — apenas PESSOAL
Responde "cabe no meu orçamento?" antes de uma compra grande ou financiamento,
simulando o impacto **sobre a projeção real do PESSOAL** — sem criar nenhum
lançamento e sem ser um segundo motor financeiro (CASA/CARRO/COMPRA continuam
sendo só fontes de itens e destinos de conversão).

- **Cenários:** cada cenário agrupa itens hipotéticos (ex.: "Carro novo"). Criar,
  selecionar e trocar de cenário sem perder o estado dos demais.
- **Itens do cenário**, um dos três tipos:
  - **À vista:** um único impacto no mês de início.
  - **Parcelado:** N parcelas iguais a partir do mês de início (mesmo motor de
    parcelamento das despesas avulsas — `expense-installments`).
  - **Financiamento:** entrada (opcional) + cronograma **PRICE** ou **SAC** com
    juros mensais reais — o **mesmo gerador** usado pelo Financiamento real de
    CASA/CARRO (`packages/domain`), não uma segunda matemática.
  - Cada item tem um toggle **incluído/excluído**: itens desligados não entram
    no veredito, mas continuam salvos no cenário.
- **Horizonte 3/6/12 meses:** troca instantânea, recalculada 100% no navegador
  sobre a projeção já carregada — não busca dados de novo ao alternar.
- **Veredito na linguagem do app:** "A projeção segue positiva até dezembro" ou
  "Com esse plano, a projeção fica negativa em outubro", com o menor saldo do
  período e mini-barras por mês (mesmo padrão visual do runway do Cockpit).
- **Deep-link a partir do Monitoramento de preços (COMPRA):** o botão **"Simular
  impacto"** de um item monitorado (ver §8) abre Compras e cenários do projeto PESSOAL
  já com nome e melhor preço pré-carregados (referência como fallback).
- **Conversão só por navegação:** Compras e cenários nunca lança nada sozinho — para
  efetivar, use os CTAs já existentes "Comprar agora" (COMPRA) ou "Criar
  financiamento" (CASA/CARRO/Financiamento).
- Disponível apenas quando o projeto tem o módulo `monthlyOverview` (só
  PESSOAL); nos demais tipos de projeto, a rota e a API não existem.

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
Painel próprio de monitoramento de preços por produto.
- **Cadastro de item monitorado:** produto, termo de busca opcional, link opcional, preço de referência e preço alvo.
- **Watchlist persistida por projeto:** lista de itens monitorados com melhor preço, loja e data da última checagem.
- **Ações:** atualizar um item, atualizar todos, abrir oferta e remover item.
- **Histórico de preço:** cada checagem bem-sucedida (manual ou automática, via
  scheduler) grava um ponto (`PricePoint`: preço, loja, data). O card do item
  mostra um gráfico de linha com a evolução; com menos de 2 pontos registrados,
  mostra a mensagem "Histórico aparece após a 2ª checagem de preço" em vez de
  um gráfico vazio ou fabricado.

### 5.8 Pendências (`/pendencias`)
Quadro de pendências da obra.
- **Card de pendência:** título (ex.: "Comprar tinta do quarto"), **responsável**,
  detalhes. Ações: editar, **excluir pendência**.

---

## 6. Projeto CASA

Gestão da casa: financiamento, contas fixas, manutenções e lembretes.

### 6.1 Dashboard (`/dashboard`)
Visão geral da casa (KPIs gerais, resumo, próximas pendências). Quando há um
financiamento cadastrado, mostra saldo devedor, valor pago, progresso e próxima
parcela, com acesso aos detalhes.

### 6.2 Financiamento (`/financing`)
Registra um financiamento por projeto e gera sua projeção mensal. Também
disponível em **CARRO** (financiamento de veículo, issue #293) — mesma tela,
mesmo motor PRICE/SAC, mesmas regras abaixo.
- Sistemas de amortização **PRICE** e **SAC**, com valor financiado, taxa mensal,
  prazo, primeira parcela e dia de vencimento.
- Resumo com total, valor pago, saldo devedor, progresso e próxima parcela.
- Tabela de parcelas previstas/pagas. Cada parcela com vencimento dentro dos
  próximos 12 meses materializa automaticamente uma despesa avulsa PLANEJADA
  (tipo Financiamento) no projeto dono — ela aparece na Conta/consolidado
  normalmente e pode ser vinculada/rateada com o PESSOAL como qualquer outra
  despesa planejada (regras 14/15). Antes desta materialização, a parcela real
  era invisível no caixa consolidado.
- **Marcar como paga** (na tela do Financiamento) registra o valor/data na
  parcela **e** sincroniza a despesa espelho: ela vira PAGO e o caixa
  consolidado (faltaPagarMes/Contas Vencidas) é atualizado junto — não é mais
  preciso quitar pelo PESSOAL para a parcela sumir da fila "falta pagar" (#294).
  Se a parcela também for quitada via vínculo/rateio do PESSOAL, esse caminho
  continua governando o espelho normalmente (#276) — os dois não conflitam.
- Ao editar o contrato, parcelas já pagas ou já vinculadas ao PESSOAL
  permanecem intocadas; somente as parcelas futuras não vinculadas são
  recalculadas (e sua despesa espelho, atualizada).

### 6.3 Contas recorrentes (`/bills`)
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
  pagamento, Data do pagamento, Fornecedor, Observações). **Superfície única**
  de despesas avulsas para CASA/CARRO (issue #369) — a antiga tela dedicada
  `/expenses` foi descontinuada para esses dois tipos e redireciona para cá
  (veja §6.6). O módulo `expenses` (dados/permissão) continua existindo por
  baixo — só a tela dedicada saiu do ar.

### 6.4 Manutenção (`/maintenance`)
Histórico e agenda de manutenções.
- **Botão "Nova Manutenção".**
- **"Próximas manutenções":** cards com o tipo, quando ("em X dias") e a data.
- **Tabela** (Tipo, Realizada, Próxima, Custo, Fornecedor, ações). No celular,
  rola horizontalmente. Ações: editar, excluir.
- Formulário: tipo, datas, custo, **Fornecedor (opcional)**, **Observações**.

### 6.5 Lembretes (`/reminders`)
Tarefas com prazo e prioridade.
- **Botão "Novo Lembrete"** (Título, Descrição opcional, data, prioridade,
  frequência).
- **Filtros (pills):** **Pendente / Concluído / Adiado / Todos**.
- **Card de lembrete:** título, data, frequência, badges de **prioridade** e
  **status**. Ações: **Concluir**, **Adiar**, **Editar**, **Excluir**.

### 6.6 Despesas (`/expenses`) — descontinuada para CASA/CARRO (issue #369)
CASA e CARRO tinham duas superfícies para a mesma coisa: a aba **Avulsas**
dentro de **Contas** (§6.3) e esta tela dedicada — ambas liam/escreviam na
mesma tabela de despesas, com formulários divergentes (o `quantidade` fixo
em 1 nesta tela, por exemplo, zerava silenciosamente despesas com
quantidade > 1 editadas por aqui). O produto decidiu manter **uma
superfície só**: a aba Avulsas. Acessar `/expenses` num projeto CASA ou
CARRO agora redireciona automaticamente para **Contas → Avulsas**
(`/bills?tab=avulsas`); o item some do menu (dock mobile de CASA cai de 3
para 2 abas: Dashboard e Contas) mas o dado e o módulo `expenses` (usado
para vínculo/rateio cross-project a partir do PESSOAL e como fonte das
despesas de combustível de CARRO, §7.4) continuam intactos por baixo.
REFORMA, COMPRA e PESSOAL **não são afetados** — continuam usando
`/expenses` normalmente (ver §4.4/§8).

---

## 7. Projeto CARRO

Igual ao CASA (Contas recorrentes + Avulsas — §6.3, Manutenção, Lembretes,
**Financiamento** — §6.2, veja lá) **mais** o módulo específico:

### 7.1 Carro — dados (`/car-info`)
Ficha do veículo (é um registro 1:1 com o projeto).
- **Botão "Salvar"** (mostra "Salvando…" / "✓ Salvo").
- **Identificação:** Marca, Modelo, Ano Fabricação, Ano Modelo, Cor, Placa.
- **Valores:** **Tabela FIPE** × **valor pago** (em centavos).
- **Quilometragem** + sinal de revisão (km atual/última revisão).

### 7.2 Documentos (`/vehicle-documents`)
Centraliza documentos do veículo e seus vencimentos.
- Tipos próprios para **IPVA**, **Seguro**, **Licenciamento** e **Outro**.
- Cada cadastro guarda título, número/apólice opcional, vencimento, observações e
  antecedência do aviso.
- O app cria um lembrete vinculado e mantém título e data sincronizados quando o
  documento é editado. Excluir o documento também remove esse lembrete.
- Aceita múltiplos anexos em PDF, JPG, PNG ou WebP (até 10 MB cada).
- O dashboard de CARRO mostra um atalho e os próximos documentos cadastrados.

### 7.3 Manutenção do carro
Igual ao §6.3, com coluna **Km** adicional na tabela.

### 7.4 Dashboard do CARRO (`/dashboard`)
Além dos cartões gerais (§6.1), o dashboard de CARRO mostra:
- **"🔧 Próximas Manutenções":** ao lado do título, exibe o **km atual** do
  veículo (de `/car-info`, quando cadastrado). Cada manutenção agendada ganha
  uma **barra de progresso** do tempo decorrido desde a última troca até a
  próxima data prevista, além de "Em X dias" e o fornecedor.
- **"⛽ Gasto com Combustível":** soma das despesas do tipo Combustível
  (rótulo atual do tipo `GASOLINA`) lançadas na aba **Avulsas de Contas**
  (`/bills?tab=avulsas` — §6.3; a própria despesa é gravada no módulo
  `expenses`, só a tela dedicada saiu do ar, §6.6) **neste mês** e a
  **média mensal** dos últimos 3 meses com lançamento. Card só aparece para
  projetos CARRO; some silenciosamente sem despesas de combustível lançadas.

---

## 8. Projeto COMPRA

Para acompanhar uma compra grande (casa, carro, etc.).
- Módulos: **Dashboard**, **Despesas**, **Preços** — mesma mecânica descrita nas
  seções do PESSOAL/REFORMA. (Recebimentos e Fluxo de Caixa foram removidos:
  dado real do banco mostrou 0 usos em projetos COMPRA — dieta #291.)
- Em **Preços** (`/price-compare`), há uma tela própria de watchlist para monitorar produtos e atualizar cotações.
  Cada item monitorado tem o botão **"Simular impacto"**, que abre Compras e
  cenários (§4.12) do projeto PESSOAL com nome e melhor preço já pré-carregados —
  útil para responder "cabe no orçamento?" antes de decidir comprar.
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
