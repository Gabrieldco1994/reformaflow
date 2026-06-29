# ReformaFlow

Plataforma pessoal para **gerenciar projetos de reforma/obra e finanças**, organizada por tipo de projeto. Cada projeto habilita um conjunto de módulos diferente:

| Tipo | Foco | Módulos |
|---|---|---|
| **REFORMA** | Obra/renovação | dashboard, despesas, recebimentos, fluxo de caixa, cômodos, plantas, simulação, comparação de preços |
| **COMPRA** | Aquisição de imóvel | dashboard, despesas, recebimentos, fluxo de caixa |
| **CASA** | Casa em andamento | dashboard, contas recorrentes, manutenção, lembretes, despesas avulsas |
| **CARRO** | Veículo | idem CASA + registro do carro (`carInfo`) |
| **PESSOAL** | Controlador universal de caixa (o *Cockpit*) | visão mensal consolidada, cartões, contas bancárias, espelho cross-project, rateio |

Inclui a assistente de voz **Maria** (lançamento de despesas por voz, TTS via VibeVoice) e um motor de cronograma com gráfico de Gantt.

## Stack

Monorepo **Turbo** com **npm workspaces** (`packageManager: npm`):

- **Web** — Next.js 14 (App Router), Tailwind, React Query, Zustand, recharts, dnd-kit · porta **3000**
- **API** — NestJS, Prisma/SQLite · porta **3001**
- **Domínio** — `@reformaflow/domain`: enums + regras puras (testadas com vitest)
- **IA** — Gemini (classificação/assistente), VibeVoice no Modal (TTS)

## Estrutura

```
apps/web        # @reformaflow/web  — Next.js (rotas em src/app/projects/[projectId]/...)
apps/api        # @reformaflow/api  — NestJS (módulos por domínio)
packages/domain # @reformaflow/domain — enums e regras de negócio (barrel only)
packages/config # TS configs compartilhados
prisma          # schema + migrations + dev.db (SQLite, dados reais)
docs            # documentação (ver docs/README.md) + docs/archive
tools           # ferramentas de apoio (ex.: reconcile.py)
```

## Rodando localmente

```bash
npm ci                       # instala (npm workspaces)
npm run dev                  # web (3000) + api (3001) via Turbo
# ou a API isolada e estável em background:
./start-api.sh
```

A API usa SQLite em `prisma/dev.db`. **Nunca** rode `prisma migrate reset` / `db push --force-reset` — há dados reais; faça backup antes de qualquer migration.

## Testes & type-check

```bash
cd packages/domain && npx vitest run   # testes do domínio
cd apps/api        && npx jest          # testes da API
cd apps/web        && npx tsc --noEmit  # type-check (idem api/domain)
```

Um hook de pré-commit roda `tsc --noEmit` nos três pacotes.

## Deploy

API no **Fly.io** (volume persistente + migrations no entrypoint) e web no **Vercel**. Detalhes em [`DEPLOY.md`](./DEPLOY.md). O push para `main` dispara a CI que builda, testa e faz deploy da API.

## Documentação

- Guia para agentes/IA e convenções do projeto: [`AGENTS.md`](./AGENTS.md)
- Regras de negócio e status: [`docs/`](./docs/README.md)
