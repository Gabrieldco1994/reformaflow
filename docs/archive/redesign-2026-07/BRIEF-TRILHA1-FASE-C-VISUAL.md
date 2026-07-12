# BRIEF DE EXECUÇÃO — Trilha 1: Fase C-visual (Cockpit Inovador Mobile)

**Data:** 2026-07-11
**Base:** `main` APÓS merge do PR #75 (redesign estrutural). Não iniciar antes.
**Branch sugerido:** `feat/fase-c-visual` (worktree próprio)
**Escopo:** 1 PR, presentation-only
**Protótipo aprovado (fonte de verdade visual):** `docs/prototipo-mobile/cockpit-inovador-c3.html` (v3)

---

## 🎯 Objetivo

Construir DE VERDADE as 6 inovações do protótipo v3 aprovado pelo Gabriel. A Fase C
já mergeada foi apenas estrutural (accordion, 1-line header) — reorganizou componentes
existentes. Esta trilha constrói o visual novo. **Zero motor novo: todo dado já existe.**

Contexto de produto: APP = direto (relance, lançar rápido) · WEB = analítico.
Este brief é só o mobile do Cockpit (`apps/web/src/app/projects/[projectId]/monthly/`).

---

## 🧱 Regras invioláveis

1. **Presentation-only.** PROIBIDO tocar `derive.ts` (lógica), services da API, schema
   Prisma. Só criar/editar componentes visuais e, no máximo, funções puras NOVAS de
   preparação de dados em arquivos novos (`_lib/`), com testes.
2. **Piso tipográfico (critério de aceite v3.1):** nada <11px; valores de lista ≥15px;
   alvos de toque ≥44px; validar em 360px E 390px de largura.
3. **Antes de criar componente, procurar se já existe** (cicatriz do FAB duplicado).
4. **QA visual obrigatória no final:** login real + dados reais, mobile e desktop.
   tsc/testes verdes NÃO bastam (5 bugs só apareceram em QA real na fase anterior).
5. Páginas ≤400 linhas — quebrar em `_components/`, `_hooks/`, `_lib/`.
6. Commit por inovação (6+ commits), mensagens `feat(cockpit): ...`.

---

## 🚀 As 6 inovações (ordem de implementação)

### 1. Herói escuro com "viagem no tempo"
- Card herói de fundo escuro no topo do MonthView mobile.
- Slider horizontal percorre os DIAS do mês; a cada posição mostra o caixa
  projetado daquele dia; glow/acento muda verde→vermelho conforme o saldo.
- **Dado pronto:** `buildSaldoSeries(m, entries, ritmoDiario): DiaSaldo[]` em
  `_cockpit/derive.ts:426` (já usado pelo `SaldoMesChart.tsx`, que tem slider —
  estudar antes de escrever do zero).

### 2. Cenários "E se…?" (pedido explícito do Gabriel)
- Chips/controles de cenário (ex.: "e se eu gastar +R$500?", "e se adiar a parcela?",
  valor livre) que DEFORMAM ao vivo a curva do runway "Vai dar até o dia 10?".
- **Base a reaproveitar:** `conta/_components/ProjecaoSaldo.tsx` (runway com quebra
  por categoria) e lógica de projeção do dre-overview. O cenário é um delta aplicado
  client-side sobre a série existente — função pura nova em `_lib/scenarios.ts` + testes.

### 3. Sankey "Para onde foi"
- Fluxo renda → categorias → subcategorias do mês.
- **Dado pronto:** `categorias` de `deriveMonth`/`derive.ts` (mesma fonte do
  `CategoriasBarras.tsx`). Renderizar com SVG próprio ou recharts (já no stack) —
  NÃO adicionar lib nova de Sankey sem necessidade.

### 4. Deslizar-para-pagar
- Em lançamentos PLANEJADO/PREVISTO do mês, gesto de arrastar (dnd-kit, já no stack)
  confirma a saída → chama o endpoint EXISTENTE de marcar pago (o mesmo que a UI atual
  usa por botão). Nenhum endpoint novo.
- Feedback tátil/visual + undo (toast com desfazer).

### 5. Mini-herói cápsula ao rolar
- Ao rolar além do herói, uma cápsula compacta (sticky top ou bottom) mantém o número
  central (caixa/sobra do dia selecionado) visível.
- Atenção à cicatriz de CSS: sticky + overflow — testar que nada é clipado
  (bug de `overflow-x-visible` já mordeu duas vezes neste projeto).

### 6. Stories "Maria percebeu"
- Fila horizontal de cards estilo stories no topo/meio do cockpit com insights
  derivados dos dados JÁ CALCULADOS (ex.: maior categoria do mês vs média —
  `mediaMensalPorCodigo`, `gastoMedioMensal` em derive.ts; recorrências de
  `Recomendacoes.tsx`). **Sem chamada de IA nesta fase** — insights por regra pura
  (funções novas em `_lib/insights.ts` + testes). Integração com a Maria real
  (agent/LLM) fica pra fase posterior.

---

## 📁 Onde mexer

```
apps/web/src/app/projects/[projectId]/monthly/
  _cockpit/MonthView.tsx        ← integra as novas seções (respeitar accordion existente)
  _cockpit/CockpitTop.tsx       ← pode ser substituído/absorvido pelo herói escuro no mobile
  _cockpit/SaldoMesChart.tsx    ← referência de slider/série; pode ser absorvido pelo herói
  _components|_lib novos        ← HeroTimeTravel.tsx, ScenarioChips.tsx, SankeyParaOndeFoi.tsx,
                                   SwipeToPay.tsx, MiniHeroCapsule.tsx, MariaStories.tsx,
                                   _lib/scenarios.ts, _lib/insights.ts (+ testes vitest/jest)
```

Desktop (`md:`+) mantém o layout atual — as inovações são mobile-first; onde fizer
sentido no desktop, mostrar sem quebrar o grid existente.

---

## ✅ Definition of Done

- [ ] 6 inovações implementadas conforme protótipo c3 (abrir o HTML lado a lado)
- [ ] Piso tipográfico validado em 360px e 390px
- [ ] `cd apps/web && npx tsc --noEmit` limpo (nos arquivos tocados)
- [ ] Testes das funções puras novas (`scenarios`, `insights`) passando
- [ ] Testes existentes do cockpit (`derive.*.test.ts`) intocados e verdes
- [ ] QA visual com login real (usuário gabrieldco) + dados reais:
      cockpit mobile 360/390, interação de cada inovação, desktop sem regressão
- [ ] Screenshots do antes/depois anexados ao PR
- [ ] PR único: `feat(cockpit): Fase C-visual — cockpit inovador (protótipo c3)`

## 🚫 Fora de escopo (NÃO fazer)

- Fase E / motores / `derive.ts` interno / `/financeiro`
- Maria com LLM real (stories são rule-based nesta fase)
- PWA, web analítico D1 (Trilha 2), outros módulos (Trilha 3)
- Qualquer migration/schema

## 📚 Leitura obrigatória antes de codar

1. `docs/prototipo-mobile/cockpit-inovador-c3.html` (abrir no browser)
2. `docs/estado-atual-cockpit-pessoal.md`
3. `_cockpit/derive.ts` (só LER — entender `buildSaldoSeries`, `deriveMonth`, `saldoProjetado`)
4. `conta/_components/ProjecaoSaldo.tsx` (base do "E se…?")
5. `CLAUDE.md` (convenções + cicatrizes)
