# BRIEF DE EXECUÇÃO — Trilha 2: Web Analítico D1 (Fase F restante)

**Data:** 2026-07-11
**Base:** `main` APÓS merge do PR #75. Não iniciar antes.
**Branch sugerido:** `feat/fase-f-web-d1` (worktree próprio)
**Escopo:** 1 PR, presentation-only
**Protótipo aprovado (fonte de verdade visual):** `docs/prototipo-mobile/cockpit-web-analitico.html` (Proposta D1)

---

## 🎯 Objetivo

Completar a Fase F. O que já mergeou foi SÓ a sidebar recolhível (toggle + tooltip +
persistência). Falta o coração do protótipo D1 aprovado: o Cockpit desktop denso e
analítico. Princípio de produto do Gabriel: **APP = direto · WEB = completo/analítico**.
Hoje o Cockpit desktop é o mesmo empilhado vertical do mobile esticado — desperdiça tela.

**Zero motor novo.** Todo dado vem de `monthly-overview` + `derive.ts` (só LER).

---

## 🧱 Regras invioláveis

1. **Presentation-only.** PROIBIDO tocar `derive.ts` (lógica interna), services da API,
   schema Prisma, `tenant-financial.service` (a fusão do motor é Fase E, OUTRA sessão).
   Funções puras NOVAS de preparação de dado só em arquivos novos `_lib/*.ts` + testes.
2. **Antes de criar componente, procurar se já existe** (grep primeiro — cicatriz do
   FAB duplicado). Componentes candidatos a reuso estão listados por item abaixo.
3. **Não quebrar o mobile.** Tudo desta trilha é `hidden lg:...` / grid responsivo —
   o layout mobile (accordion da Fase C) fica intocado. Screenshot mobile antes/depois
   idêntico é critério de aceite.
4. **QA visual obrigatória no final:** login real (gabrieldco) + dados reais,
   viewports 1280×800 e 1536×960. tsc verde NÃO basta (5 bugs só apareceram em QA real).
5. Páginas ≤400 linhas — quebrar em `_components/` + `_lib/`.
6. Cuidado com a cicatriz sticky/overflow: `overflow-y-auto` + `overflow-x-visible`
   clipa tooltips (bug já corrigido 2× no projeto — não reintroduzir).
7. Commit por entrega (5+ commits), mensagens `feat(cockpit-web): ...`.

---

## 🚀 Entregas (ordem de implementação)

### 1. Grid de densidade — herói + análise lado a lado (`lg:`+)
- Hoje: MonthView é uma coluna única também no desktop.
- Alvo (protótipo D1): em `lg:`+, grid 2 colunas — coluna esquerda (~2/3) com herói +
  fluxo do mês + categorias; coluna direita (~1/3) um **rail** fixo/sticky com:
  - bloco "Lançar agora" (atalho para o modal de nova despesa JÁ EXISTENTE — reusar o
    handler do FAB, não criar fluxo novo)
  - bloco Maria (placeholder da assistente: entrada de texto que leva ao chat existente
    do agent, se houver rota; senão card estático "em breve" — NÃO integrar LLM aqui)
  - próximos vencimentos (reusar dado de `ComprometimentoFuturo`/entries PLANEJADO)
- Arquivo: `monthly/_cockpit/MonthView.tsx` (reorganizar em `lg:grid lg:grid-cols-3`)
  + novo `_cockpit/DesktopRail.tsx`.

### 2. Runway "Vai dar até dez?" com valor livre
- Reusar `conta/_components/ProjecaoSaldo.tsx` como base (runway com quebra por categoria
  no hover JÁ existe lá).
- Acrescentar no desktop do Cockpit: input de valor livre ("e se eu tirar R$ X?") que
  desloca a curva client-side. É a versão desktop do "E se…?" da Trilha 1 — se a Trilha 1
  já tiver criado `_lib/scenarios.ts`, REUSAR; senão criar aqui com a mesma assinatura
  (função pura + testes) e avisar no PR pra Trilha 1 consumir.

### 3. Metas por categoria (viz only)
- Barras de progresso gasto-do-mês vs média histórica por categoria.
- **Dado pronto:** `mediaMensalPorCodigo` / `gastoMedioMensal` em `derive.ts` +
  `categorias` de `deriveMonth`. Existe página `metas` no PESSOAL — LER antes
  (`app/projects/[projectId]/metas/`) e reusar/absorver componentes em vez de duplicar.
  Se a página metas já cobre, esta entrega vira: embutir o resumo dela como seção do
  cockpit desktop com link "ver metas".

### 4. DRE glance — competência × caixa lado a lado
- Mini-tabela/cards no desktop: mês corrente nas duas óticas (Gastei vs Vai sair).
- **Dado pronto:** página `dre` já existe (`app/projects/[projectId]/dre/`) — extrair o
  resumo dela pra um componente compartilhado (ex.: `_components/DreGlance.tsx`) usado
  pelas duas telas. NÃO recalcular nada novo.

### 5. Auditoria de navegação (verificação, não construção)
- `packages/domain/src/config/module-navigator.ts` JÁ tem Cockpit/Conta/DRE/Neutros/
  Cartões/Contas pro PESSOAL — o bug D4 histórico foi resolvido.
- Tarefa: VERIFICAR no browser que a sidebar desktop renderiza todos e que o item ativo
  destaca certo em cada rota (monthly, conta, dre, neutros, credit-cards, bank-accounts).
  Corrigir só divergência visual, se houver. Reportar no PR o resultado.

### 6. Migração de dialetos (só nas telas tocadas)
- Nas telas que este PR tocar, substituir KPI/card ad-hoc pelos componentes canônicos da
  Fase A (`KpiTile`, `Delta`, `moneyGlance`/`moneyDetail`, cores semânticas `--ck-*`).
- NÃO fazer swap em massa no repo (cicatriz: CSS Tailwind é frágil; migração é gradual).

---

## 📁 Onde mexer

```
apps/web/src/app/projects/[projectId]/monthly/
  _cockpit/MonthView.tsx          ← grid lg: 2 colunas + rail
  _cockpit/DesktopRail.tsx        ← NOVO (lançar agora, Maria, vencimentos)
  _cockpit/DreGlance.tsx          ← NOVO (extraído do /dre)
  _cockpit/MetasGlance.tsx        ← NOVO ou reuso de /metas
  _lib/scenarios.ts               ← reuso da Trilha 1 OU criar (função pura + teste)
apps/web/src/app/projects/[projectId]/dre/       ← só extrair componente (sem mudar rota)
apps/web/src/app/projects/[projectId]/metas/     ← só ler/reusar
```

**NÃO tocar:** `apps/web/src/app/financeiro/**` (morre na Fase E), `derive.ts` (lógica),
qualquer coisa em `apps/api/`.

---

## ✅ Definition of Done

- [ ] Desktop `lg:`+ com grid herói+análise / rail direito conforme protótipo D1
- [ ] Runway com valor livre funcionando (deforma a curva ao vivo)
- [ ] Metas por categoria e DRE glance visíveis no cockpit desktop
- [ ] Rail: "Lançar agora" abre o modal existente de despesa
- [ ] Navegação PESSOAL auditada (checklist por rota no corpo do PR)
- [ ] Mobile 100% intocado (screenshot antes/depois idêntico em 390px)
- [ ] `cd apps/web && npx tsc --noEmit` limpo nos arquivos tocados
- [ ] Testes existentes verdes + testes das funções puras novas
- [ ] QA visual real: 1280×800 e 1536×960, sidebar expandida E recolhida
- [ ] Screenshots no PR
- [ ] PR único: `feat(cockpit-web): Fase F — cockpit desktop analítico (protótipo D1)`

## 🚫 Fora de escopo (NÃO fazer)

- Fusão `/financeiro` → Cockpit (Fase E, precisa de wizard + pessoal-lens)
- Qualquer mudança de cálculo/motor/schema
- Maria com LLM real
- Mobile (Trilha 1), outros módulos (Trilha 3), PWA

## 📚 Leitura obrigatória antes de codar

1. `docs/prototipo-mobile/cockpit-web-analitico.html` (abrir no browser)
2. `docs/estado-atual-cockpit-pessoal.md`
3. `_cockpit/MonthView.tsx` e `_cockpit/derive.ts` (só LER)
4. `conta/_components/ProjecaoSaldo.tsx`, páginas `dre/` e `metas/`
5. `CLAUDE.md` (convenções + cicatrizes)
