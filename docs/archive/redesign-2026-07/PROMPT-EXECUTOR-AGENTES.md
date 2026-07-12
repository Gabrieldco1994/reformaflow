# PROMPT PARA COLAR E AGENTES EXECUTAREM

**Copie TUDO abaixo e cole em uma nova conversa do Claude (Opus 4.8 ou Sonnet 5, conforme indicado).**

---

# 🚀 EXECUTOR — Implementação Trilhas 1/2/3/E do Redesign UX

**Contexto:** Você vai implementar uma das 4 trilhas do plano de redesign UX do ReformaFlow. Cada trilha é **presentation-only** (sem mudanças de cálculo/schema), com QA visual obrigatória no final. Você trabalha em um worktree isolado.

**Repositório:** https://github.com/gabrielbarbosa/reformaflow  
**Dados reais (QA):** use credenciais de teste do projeto (será fornecida)

---

## 📍 Escolha SUA trilha:

> **Se você está implementando Trilha 1 (Fase C-visual — 6 inovações mobile):**

### TRILHA 1: Fase C-Visual — Cockpit Inovador Mobile

```
BRIEF: BRIEF-TRILHA1-FASE-C-VISUAL.md (raiz do repo)
MODELO RECOMENDADO: Opus 4.8
BASE: main (após PR #75 mergear)
BRANCH: feat/fase-c-visual
DEADLINE: não há (mas 6 inovações = ~3-5 dias)
```

**As 6 inovações (protótipo aprovado em docs/prototipo-mobile/cockpit-inovador-c3.html):**

1. **Herói escuro com viagem no tempo** — slider percorre dias do mês, caixa projetado por dia, glow verde→vermelho. Use `buildSaldoSeries` em `_cockpit/derive.ts:426`.

2. **Cenários "E se…?"** — chips/controles que deformam a curva de runway ao vivo (seu pedido explícito). Reusar `conta/_components/ProjecaoSaldo.tsx`.

3. **Sankey "Para onde foi"** — fluxo renda → categorias do mês. Dado em `deriveMonth` de `derive.ts`.

4. **Deslizar-para-pagar** — dnd-kit confirma PLANEJADO→PAGO + undo. Endpoint PAGO já existe.

5. **Mini-herói cápsula ao rolar** — sticky top/bottom com número visível. Atenção: `overflow-x-visible` clipa tooltips — testar.

6. **Stories "Maria percebeu"** — insights rule-based (sem LLM nesta fase) sobre maior categoria vs média, recorrências.

**Arquivos a criar/editar:**
```
apps/web/src/app/projects/[projectId]/monthly/
  _cockpit/MonthView.tsx                    ← integra as 6 inovações
  _cockpit/CockpitTop.tsx                   ← absorver herói escuro
  _components/HeroTimeTravel.tsx            ← NOVO
  _components/ScenarioChips.tsx             ← NOVO
  _components/SankeyParaOndeFoi.tsx         ← NOVO
  _components/SwipeToPay.tsx                ← NOVO
  _components/MiniHeroCapsule.tsx           ← NOVO
  _components/MariaStories.tsx              ← NOVO
  _lib/scenarios.ts                         ← NOVO (função pura + testes)
  _lib/insights.ts                          ← NOVO (função pura + testes)
```

**Critério de aceite:**
- [ ] 6 inovações implementadas conforme protótipo c3
- [ ] Piso tipográfico: nada <11px; valores ≥15px; alvos ≥44px; validar 360/390px
- [ ] `cd apps/web && npx tsc --noEmit` limpo nos arquivos tocados
- [ ] Testes de funções puras (`scenarios`, `insights`) passando
- [ ] QA visual real: validar cada inovação em 360/390px e desktop (com dados reais)
- [ ] Screenshots antes/depois no PR
- [ ] PR único: `feat(cockpit): Fase C-visual — cockpit inovador (protótipo c3)`

**Leitura obrigatória:**
1. `docs/prototipo-mobile/cockpit-inovador-c3.html` (abrir no browser)
2. `docs/estado-atual-cockpit-pessoal.md`
3. `_cockpit/derive.ts` (SÓ LER — `buildSaldoSeries`, `deriveMonth`, `saldoProjetado`)
4. `conta/_components/ProjecaoSaldo.tsx` (base do "E se…?")
5. `CLAUDE.md` (convenções + cicatrizes)

**Cicatrizes do projeto (não repetir):**
- Não criar componente sem grep antes (FAB duplicado já mordeu)
- Sticky + `overflow-x-auto overflow-x-visible` clipa tooltips (bug fixado 2×)
- Accordion com nome duplicado quebra armazenamento localStorage (já aconteceu)
- Formatação de dinheiro: usar `moneyGlance` (abreviado) e `moneyDetail` (exato) canônicos

---

> **Se você está implementando Trilha 2 (Fase F — Web Analítico):**

### TRILHA 2: Fase F — Cockpit Desktop Analítico (D1)

```
BRIEF: BRIEF-TRILHA2-WEB-ANALITICO-D1.md (raiz do repo)
MODELO RECOMENDADO: Opus 4.8
BASE: main (após Trilha 1 mergear, OK rodar paralelo)
BRANCH: feat/fase-f-web-d1
```

**Entregas (protótipo em docs/prototipo-mobile/cockpit-web-analitico.html):**

1. **Grid de densidade** — `lg:` com 2 colunas: herói (2/3) + rail direito (1/3)
2. **Runway com valor livre** — slider com input que deforma curva ao vivo
3. **Metas por categoria** — barras gasto vs média histórica
4. **DRE glance** — competência × caixa lado a lado
5. **Auditoria de navegação** — PESSOAL mostra Cockpit/Conta/DRE/Cartões/Contas
6. **Migração de dialetos** — trocar KPI ad-hoc por KpiTile/Delta/moneyGlance canônicos

**Arquivos:**
```
apps/web/src/app/projects/[projectId]/monthly/
  _cockpit/MonthView.tsx          ← grid lg:
  _cockpit/DesktopRail.tsx        ← NOVO
  _cockpit/DreGlance.tsx          ← NOVO
  _cockpit/MetasGlance.tsx        ← NOVO
  _lib/scenarios.ts               ← reuso de Trilha 1 OU criar aqui
```

**Cicatrizes específicas:**
- `overflow-y-auto overflow-x-visible` clipa tooltips (mudou pra `overflow-visible` em Fase F anterior, não reverter)
- Reusar dados de `/metas` e `/dre` — não duplicar lógica

---

> **Se você está implementando Trilha 3 (Fase G — Módulos):**

### TRILHA 3: Fase G — 3 Camadas em 7 Módulos

```
BRIEF: BRIEF-TRILHA3-FASE-G-MODULOS.md (raiz do repo)
MODELO RECOMENDADO: Sonnet 5 (padrão repetitivo = economia)
BASE: main (OK rodar paralelo)
BRANCH: feat/fase-g-modulos
```

**7 módulos (aplicar padrão 3-camadas: KPIs topo + cards + detalhe):**

1. `bills/` (recurringBills — CASA/CARRO)
2. `maintenance/` (CASA/CARRO)
3. `reminders/` (CASA/CARRO)
4. `receipts/` (REFORMA/COMPRA/PESSOAL)
5. `cash-flow/` (REFORMA/COMPRA/PESSOAL)
6. `dashboard/` (todas as tipos)
7. `simulation/` (REFORMA — página dedicada digna)

**Padrão:** topo com KpiTiles, lista em cards (não tabelas), filtros em 1 linha + sheet mobile.

**Cicatrizes:**
- `hasFeature(tipo, 'x')` obrigatório — nunca gate por tipo hard-coded
- Nomes duplicados de sections — conferir antes
- Tailwind frágil — migrar componente a componente, não swap em massa

---

> **Se você está implementando Fase E (Motor Único — serial, DEPOIS dos 3):**

### FASE E: Motor Único (Consolidação de Cálculos)

```
BRIEF: BRIEF-FASE-E-MOTOR-UNICO.md (raiz do repo)
MODELO RECOMENDADO: Opus 4.8 (máxima complexidade)
BASE: main (APÓS Trilhas 1/2/3 mergearem — é serial)
BRANCH: feat/fase-e-motor-unico
CRITICIDADE: MÁXIMA — altera números de decisão financeira
```

**PRÉ-REQUISITO VALIDADO:**
- Auditoria em produção (2026-07-11) prova que §10 (monthly-overview) bate com saldo real do banco
- Saldo real: R$ 63.427,35 = Visão Conta (§10) ✅
- Página /financeiro: R$ 592.892 ❌ (834% off — morre aqui)

**Entregas:**

1. **Wrapper de tenant-financial** → chama §10
2. **Absorver KpiCards /financeiro** → Cockpit (usando §10)
3. **Alinhar cash-flow** com §10 (fechar −R$ 999)
4. **Auditar espelho + rateio + neutro** com pessoal-lens (6 permutações)
5. **Wizard de consolidação** (antes/depois, confirmação, rollback)

**Guarda-chuva:** §10 é READ-ONLY, invariante congelada. Se mudar = bug crítico.

**Cicatrizes:**
- `pessoal-lens` REVISA cada permutação (espelho, rateio, fatura neutra, cartão-paga-cartão)
- Nenhuma mudança de schema
- Testes de invariante rodam antes/depois (mesmo resultado)

---

## 🎯 INSTRUÇÕES DE EXECUÇÃO

### 1. **Setup inicial**
```bash
cd /Users/gabrielbarbosa/reformaflow
git fetch origin
git checkout main
git pull
git checkout -b [seu-branch-da-trilha]   # ex: feat/fase-c-visual
```

### 2. **Implemente conforme brief**
- Leia TUDO do brief (não pule)
- Procure no código ANTES de criar (grep para cicatrizes)
- Commit por entrega, mensagens `feat(modulo): descrição`

### 3. **QA Visual obrigatória**
```bash
npm run dev          # inicia web + API
# Login: credenciais de teste (será fornecida pelo Gabriel)
# Teste em 390px (mobile) e 1280px (desktop)
# Valide cada inovação com dados reais
# Screenshot antes/depois
```

### 4. **Testes**
```bash
cd apps/web && npx tsc --noEmit      # type-check
npm run test                         # testes do projeto
```

### 5. **PR**
```bash
git push origin [seu-branch]
gh pr create \
  --title "feat(cockpit): [seu-titulo]" \
  --body "## Resumo
  [3-4 bullets do que fez]
  
  ## Validação
  - [ ] Build: 3/3 tasks
  - [ ] Testes: X/X passing
  - [ ] QA visual: 390px + 1280px ✅
  - [ ] Screenshots: [attached]
  
  Closes #XX (se houver issue)"
```

---

## 🔐 REGRAS OURO (não quebrar)

1. **Presentation-only:** sem mudanças em `derive.ts`, schema, services da API
2. **Antes de criar, grep:** (cicatriz do FAB duplicado)
3. **QA visual real obrigatória:** tsc verde NÃO basta (5 bugs só apareceram com login real)
4. **Piso tipográfico:** nada <11px; valores ≥15px; alvos ≥44px
5. **Páginas ≤400 linhas:** quebrar em `_components/` + `_hooks/` + `_lib/`
6. **Reuso de componentes:** KpiTile, Delta, moneyGlance, CardActionsMenu, FilterSheet (canônicos)
7. **Gate por feature:** `hasFeature(tipo, 'x')` — nunca hard-coded

---

## 📋 CHECKLIST FINAL

Antes de fazer PR:
- [ ] Branch baseado em main (ou main + PR #75 mergeado)
- [ ] 100% dos commits pusheados
- [ ] `git status` = clean
- [ ] `npx tsc --noEmit` = OK nos arquivos tocados
- [ ] Testes passando
- [ ] QA visual feita (login real, 390/1280px)
- [ ] Screenshots no PR
- [ ] Nenhum arquivo `.js`/`.d.ts` compilado commitado
- [ ] Commit messages em português, padrão repo

---

## 📞 DÚVIDAS

Consulte:
- `CLAUDE.md` — convenções do projeto
- `docs/estado-atual-cockpit-pessoal.md` — contexto financeiro
- `docs/cockpit-caixa-real.md` — regras de negócio
- Briefs acima (cada um tem "Leitura obrigatória" + cicatrizes específicas)

---

## 🚀 COMECE AGORA

```bash
# 1. Clone / setup
cd /Users/gabrielbarbosa/reformaflow

# 2. Branch
git checkout -b [seu-branch]

# 3. Implemente
# (siga seu brief acima)

# 4. PR quando pronto
gh pr create --title "..." --body "..."
```

**Boa sorte! 🎯**

---

**Gerado:** 2026-07-12
**Repos:** https://github.com/gabrielbarbosa/reformaflow
**Briefs completos:** `/` do repo (BRIEF-TRILHA[1-3]-*.md, BRIEF-FASE-E-*.md)
