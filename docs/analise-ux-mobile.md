# Análise de UX/UI — Mobile-first para dados financeiros (LifeOne)

> Revisão de design cruzando o **Manual do Aplicativo** com a **UX deployada**
> (telas reais verificadas no celular a 402×840). Foco: tornar o app mais
> **acessível no celular**, principalmente onde estão os **KPIs e Despesas**.
> Inclui uma proposta de **split mobile-first** (o que mostrar, e o que esconder
> atrás de um toque).
>
> Método de leitura desta análise: cada achado tem **Sintoma** (o que se vê),
> **Custo** (por que atrapalha no celular) e **Recomendação** (o que fazer).

---

## 0. O diagnóstico em uma frase

> O app foi desenhado com a densidade de um **painel de desktop** e depois
> **empilhado** numa coluna de celular. Ele responde a *"me mostre tudo"* — mas
> no celular a pergunta certa é *"me diga a única coisa que importa agora, e me
> deixe cavar o resto se eu quiser"*.

O trabalho recente já resolveu a **casca** (navegação, tab bar, sheets) e vários
overflows. O próximo salto não é de estilo — é de **arquitetura de informação**:
decidir, por tela, **o que aparece de imediato** e **o que fica a um toque de
distância**. É aqui que mora o pedido de "splitar para mobile-first".

---

## 1. Princípios (a régua desta análise)

Cinco regras que uso para julgar cada tela. Elas viram os critérios de aceite das
recomendações mais abaixo.

1. **Uma resposta por dobra.** A primeira tela de cada módulo deve entregar **um
   número-herói** que responde à pergunta do módulo, não uma grade de 3–6 KPIs
   competindo por atenção.
2. **Glance → Focus → Detail.** Camada 1 (relance): 1 herói + 2–3 apoios
   abreviados. Camada 2 (foco): o detalhamento atual, sob toque. Camada 3
   (detalhe): tabelas/extratos completos, tela dedicada.
3. **Número legível > número exato.** No relance, `R$ 205 mil` bate `R$
   205.062,38`. O valor exato aparece no detalhe/toque, não no card de visão geral.
4. **Controles são custo.** Cada toggle/filtro empilhado antes do dado empurra a
   informação para baixo. Consolidar controles num único ponto de entrada
   ("Filtrar", "Período").
5. **Uma língua visual só.** Um usuário que troca de aba não deveria reaprender o
   que é "um card de KPI". Hoje há três dialetos (ver §6).

---

## 2. Achados por tela

### 2.1 Cockpit (`/monthly`) — o caso mais crítico

**Sintoma.** Na visão Mês, a ordem é: 2 linhas de controles → card-narrativa →
**3 cards-herói full-width** (Caixa, Resultado, Projeção) → Entrou/Gastei →
"Quanto gastei" → gráfico + slider → Principais gastos → Comprometimento → Saúde.
São **~6–7 alturas de tela** de rolagem, e os **3 primeiros números do herói
aparecem duas vezes**: em prosa na narrativa ("Você tem R$ X… fechar em R$ Y…
faltam R$ Z") **e** logo abaixo como 3 cards.

**Custo.** No celular, quem abre o Cockpit quer *uma* leitura ("como está meu
mês?"). Em vez disso recebe a mesma informação em dois formatos e precisa rolar
três telas só para passar pelos KPIs de topo. A densidade dilui a hierarquia —
tudo parece igualmente importante, então nada guia o olho.

**Recomendação.**
- **Fundir narrativa + herói.** A narrativa já diz Caixa/Projeção/Falta em
  palavras. Transforme-a no **herói único**: número grande de **Caixa** + a frase
  de fechamento como legenda. Elimine a duplicação.
- **Rebaixar Resultado e Projeção** para uma **faixa compacta de 2 apoios**
  (label pequeno + valor 20px), não dois cards full-width.
- **Colapsar a análise.** Gráfico, Principais gastos, Comprometimento e Saúde
  entram em **seções recolhidas** (accordion) ou numa sub-aba **"Análise"** dentro
  do Cockpit. Relance primeiro; profundidade sob toque.
- **Resultado da fusão:** a primeira dobra passa a ser *Caixa + fechamento + 2
  apoios*, e o resto é opt-in. Menos rolagem, hierarquia óbvia.

Wireframe (relance proposto):
```
┌───────────────────────────────┐
│ Julho 2026        [Mês][Ano] ⚙ │  ← 1 linha de controle; resto vai p/ "⚙ Filtrar"
├───────────────────────────────┤
│ CAIXA HOJE                     │
│  R$ 6,4 mil            ↗       │  ← herói único (abreviado), sparkline
│  fecha julho em ~R$ -1,9 mil   │  ← a narrativa vira legenda do herói
│  faltam R$ 8,3 mil até dia 31  │
├───────────────┬───────────────┤
│ Entrou  R$ 0  │ Gastei R$ 1,2k │  ← 2 apoios compactos
├───────────────┴───────────────┤
│ ▸ Quanto gastei (cartões/conta)│  ← seções recolhidas
│ ▸ Fluxo do mês                 │
│ ▸ Onde gastei / Saúde          │
└───────────────────────────────┘
```

### 2.2 Despesas (`/expenses`) — excesso de controles antes do dado

**Sintoma.** Antes da lista de despesas aparecem, empilhados: hero escuro "Gasto
no mês" → 3 mini-KPIs → card do cartão → "Gastos por categoria" (colapsável) →
busca → **Filtros** → **4 abas de visão** (Categoria/Mês/Por projeto/Geral) →
seletor de mês → "Ano todo". São **~7 blocos de chrome** antes de ver um gasto. Os
mini-KPIs ainda **truncam** o valor no 3-up ("R$ 4.541,…").

**Custo.** É a tela que o usuário mais usa no dia a dia ("quanto gastei, onde,
lancei certo?") e é a que mais faz rolar antes de agir. Quatro abas de visão +
filtros + busca + período é vocabulário de planilha, não de app de bolso.

**Recomendação.**
- **Um botão "Filtrar" / "Ver por…"** abrindo um **bottom-sheet** com as 4 visões
  + período + busca. Libera 4–5 alturas de linha na dobra.
- **Mini-KPIs: 2, não 3.** No relance, "No cartão" e "À vista" cobrem 90% da
  intenção; "A vir" é uma terceira coluna que força o truncamento. Mova "A vir"
  para dentro do hero (ele já tem "A vir R$ Y") ou para o detalhe.
- **Abreviar valores** nos mini-KPIs (`R$ 4,5 mil`) — exato aparece ao tocar.
- **FAB "+ Nova despesa"** fixo no polegar (canto inferior), não um botão no fluxo
  que rola para fora da tela.

### 2.3 Visão Conta (`/conta`) — perto do ideal, ajustar densidade

**Sintoma.** Boa hierarquia: herói "Tenho na conta hoje" + grade 2×2
(Entrou/Saiu/Falta pagar/Sobra) + carrossel de cartões + movimentações. Mas são
**4 KPIs de peso visual igual** logo abaixo do herói, e dois deles (Falta pagar,
Sobra) são projeções, não fatos.

**Custo.** Fatos e previsões com o mesmo peso confundem. "Sobra prevista -R$
223k" (previsão) grita tão alto quanto "Tenho na conta hoje" (fato).

**Recomendação.**
- **Separar fatos de previsões:** Entrou/Saiu (fatos do mês) como par primário;
  Falta pagar/Sobra como par **secundário** (menor, ou dentro de um bloco
  "Projeção"). O rótulo "previsto" deve estar visível, não só no ⓘ.

### 2.4 Tabelas em CASA/CARRO (`/bills`, `/maintenance`) — scroll horizontal é armadilha

**Sintoma.** As tabelas (Conta/Categoria/Valor/**Frequência**/Vencimento/Status/
Ações) foram tornadas **roláveis na horizontal** para não cortar colunas. Funciona,
mas o usuário **não sabe** que há colunas fora da tela — inclusive as **ações**
(pausar/editar/excluir).

**Custo.** Descoberta zero. Uma ação escondida atrás de scroll horizontal é uma
ação que não existe para a maioria dos usuários no celular.

**Recomendação.**
- **Tabela → lista de cards no mobile.** Cada conta vira um card: **nome + valor**
  em destaque, **categoria/vencimento** como legenda, **status** como chip, e as
  **ações** num menu "⋯" ou revelação por toque. Sem scroll horizontal.
- No desktop, a tabela permanece (é boa lá). Split real por breakpoint.

### 2.5 Simulação / Comparar Cenários (Reforma) — complexidade legítima, empacotamento ruim

**Sintoma.** Muitos KPIs + tabelas aninhadas (Real × Projetado por tipo, "Despesas
do Fluxo de Caixa" com checkboxes) cortando no mobile.

**Custo.** É uma ferramenta de análise densa. No celular vira ilegível.

**Recomendação.** Tratar como **camada Detail**: no mobile, entregar os 3 KPIs de
resultado (Recebimentos/Despesas/Saldo Final) + um resumo, e mover a matriz de
edição para uma **tela dedicada em tela cheia** (ou sinalizar "melhor no desktop"
com honestidade). Não empilhar a matriz na coluna.

---

## 3. Dados & números — legibilidade e consistência (o coração do pedido)

### 3.1 Formatação inconsistente do MESMO valor
- Cockpit usa `fmtMoney` → arredonda e **omite centavos**: `R$ -205.062`.
- Visão Conta/listas usam `fmtMoneyExact` → **com centavos**: `-R$ 205.062,38`.
- Além do centavo, o **sinal muda de lugar**: `R$ -205.062` vs `-R$ 205.062,38`.

**Recomendação.** Padronizar:
- **KPIs de visão geral:** sem centavos, sinal antes do R$ → `-R$ 205.062` (ou
  abreviado, ver 3.2).
- **Listas/extratos/edição:** com centavos (precisão importa).
- **Uma função só** por camada, aplicada em todo o app. Hoje `fmtMoney`,
  `fmtMoneyExact`, `formatCurrency` coexistem com regras diferentes.

### 3.2 Abreviação para relance
Valores como `R$ 205.062` a 30px dominam a tela e são difíceis de comparar de
relance. Já existe `fmtK` (`R$ 12k` / `R$ 1,2M`) — **usado só em eixos de
gráfico**. Estenda-o aos **KPIs-herói no mobile**:
- Herói: `R$ 205 mil` (com o exato disponível ao tocar/segurar).
- Regra: abreviar quando |valor| ≥ 10.000 e a largura for apertada; exato no toque.

### 3.3 Semântica de cor do "gasto"
Hoje quase tudo em despesas aparece **vermelho**. Mas **gastar não é ruim** —
*estourar o previsto* é. Vermelho gasto por gasto anestesia o alarme (quando tudo
é vermelho, nada é).

**Recomendação.** Reservar vermelho para **estado ruim de verdade** (saldo
negativo, meta estourada, fatura vencida). Gasto comum em **neutro/tinta**;
comparações (vs mês, vs meta) é que ganham verde/vermelho.

### 3.4 Delta que pode enganar
"Resultado -R$ 1.200 · **↑ 57% vs mês anterior**" com seta para cima e cor verde,
num número **negativo**, é ambíguo (57% "melhor" de um prejuízo?).

**Recomendação.** Deixar explícito o sentido: `melhorou 57%` / `piorou 57%` em vez
de seta+%; e a cor deve refletir *se é bom*, não *a direção da flecha*.

---

## 4. A proposta de "split" mobile-first

O usuário abriu espaço para **dividir funcionalidade/dados** numa visão mobile.
Aqui está o modelo, sem duplicar código de negócio (só a camada de apresentação):

### Modelo de 3 camadas por módulo

| Camada | O que mostra | Como se acessa | Exemplo (Cockpit) |
|---|---|---|---|
| **Relance** (default mobile) | 1 herói + 2–3 apoios abreviados | tela inicial do módulo | Caixa + fechamento + Entrou/Gastei |
| **Foco** | o detalhamento atual (gráficos, quebras) | seções recolhidas / sub-aba "Análise" | Fluxo, categorias, comprometimento, saúde |
| **Detalhe** | tabelas/extratos completos, exato | tela dedicada / "ver tudo" | Extrato de saídas, DRE completo |

### Como aplicar sem reescrever regra de negócio
- É **apresentação**: os mesmos hooks/derivações alimentam as 3 camadas. O que
  muda é **quanto** se renderiza por padrão no mobile e **o que fica sob toque**.
- Reaproveitar o que já existe: os **bottom-sheets** (já usados em forms), os
  **accordions** (Recomendações já é um), e os breakpoints `md:` (desktop mantém a
  densidade atual, mobile recebe a camada Relance).
- **Regra de ouro preservada:** nenhum KPI/cálculo some — ele muda de *camada*,
  não deixa de existir. Todo número tem um caminho até ele.

### Onde o split rende mais
1. **Cockpit** — fundir herói, colapsar análise. (maior ganho)
2. **Despesas** — controles num sheet, 2 KPIs no relance, lista primeiro.
3. **Tabelas Casa/Carro** — cards no mobile, tabela no desktop.
4. **Simulação** — matriz em tela dedicada.

---

## 5. Acessibilidade (piso de qualidade)

- **Alvos de toque ≥ 44px** (o protótipo já pede; auditar chips de status e o "⋯"
  de ações, que costumam ficar pequenos).
- **Contraste:** conferir textos terciários (`#8A857C`/`#A7A29A`) sobre superfícies
  claras — no limite do AA para 12–13px. Legendas de KPI precisam passar AA.
- **Zona do polegar:** ações primárias (FAB, "Pagar fatura", "Nova despesa") na
  metade inferior; navegação destrutiva (excluir) fora do alcance acidental.
- **Tipografia dinâmica:** valores em `tabular-nums` (já usado) — manter; garantir
  que abreviação evite quebra/truncamento em telas de 360px.
- **Movimento:** respeitar `prefers-reduced-motion` nos slides de sheet e no
  sparkline.
- **Foco visível** e navegação por teclado nos sheets (já parcialmente ok via
  `<details>`/InfoHint).

---

## 6. Consistência do sistema (uma língua de KPI só)

Hoje convivem **três dialetos** de card de KPI:
- **Cockpit:** cards claros `lifeone-*` com ⓘ e sub-hint colorido.
- **Despesas/Recebimentos:** **hero escuro** com gradiente `darc-*` + mini-cards
  claros.
- **Visão Conta:** cards com **tinta** (verde/âmbar/vermelho).

**Custo.** O usuário reaprende "o que é um número importante" a cada aba.

**Recomendação.** Definir **um componente de KPI** com variantes controladas
(herói / apoio / tinta-de-estado) e **um mapa de cor semântica** único (positivo,
negativo, alerta, neutro, accent). Aplicar em todos os módulos. Isso também reduz
o custo de manutenção e o risco de regressões visuais.

---

## 7. Roadmap priorizado (do barato ao estrutural)

**Ganhos rápidos (1 PR cada, baixo risco, presentation-only):**
1. **Padronizar formatação de moeda** por camada (herói sem centavos + sinal
   consistente; abreviação `fmtK` nos heróis mobile). — *maior clareza, menor esforço*
2. **Despesas: colapsar controles** num sheet "Filtrar/Ver por…" + reduzir a 2
   mini-KPIs no relance.
3. **Delta legível** ("melhorou/piorou X%") e **cor por bom/ruim**, não por seta.

**Estruturais (arquitetura de informação, maior valor):**
4. **Cockpit: fundir herói + colapsar análise** (camada Relance/Foco).
5. **Tabelas Casa/Carro → cards no mobile** (fim do scroll horizontal).
6. **Componente único de KPI + mapa de cor semântica** (consistência entre abas).

**Maior fôlego:**
7. **Modelo de 3 camadas** aplicado módulo a módulo (Relance/Foco/Detalhe).
8. **Simulação em tela dedicada** no mobile.

---

## 8. Um risco a evitar

Não transformar "mobile-first" em "**mobile-menos**". O objetivo não é remover
poder — é **sequenciar** o poder. Todo dado do manual continua acessível; muda
**quando** ele aparece. Cada corte da camada Relance precisa de um caminho óbvio
("ver detalhes", "ver tudo", accordion) para a informação completa. O teste final
de cada mudança: *um usuário consegue, em 1 toque, chegar ao número que sumiu da
primeira dobra?* Se sim, é split; se não, é perda.

---

> **Próximo passo sugerido:** começar pelos **ganhos rápidos 1–3** (formatação,
> controles de Despesas, delta) — são baixo risco, presentation-only, e já elevam
> muito a legibilidade no celular — e então atacar o **Cockpit (item 4)**, que é
> onde o split mobile-first mais transforma a experiência.
