# ReformaFlow

Plataforma pessoal para **gerenciar projetos de reforma/obra e finanças**, organizada por tipo de
projeto. A tabela abaixo resume o posicionamento dos tipos; ela **não é fonte de autorização nem
inventário de módulos**. Os mapas vivos e autoritativos são
[`project-features.ts`](./packages/domain/src/config/project-features.ts),
[`type-modules.ts`](./packages/domain/src/config/type-modules.ts) e
[`module-navigator.ts`](./packages/domain/src/config/module-navigator.ts).

| Tipo        | Foco                                         |
| ----------- | -------------------------------------------- |
| **REFORMA** | Obra/renovação                               |
| **COMPRA**  | Aquisição de imóvel                          |
| **CASA**    | Casa em andamento                            |
| **CARRO**   | Veículo                                      |
| **PESSOAL** | Controlador universal de caixa (o _Cockpit_) |
| **PLANTAS** | Cuidado de plantas                           |

Inclui a assistente **Maria** (consultas, lançamento de despesas por voz e TTS
via VibeVoice) e um motor de cronograma com gráfico de Gantt. O snapshot de
implementação `6867ba991f4c39deb19bb48ead0cda62a2a9a131` contém a importação
guiada de faturas por CSV/PDF textual da #718 e a implementação da #719 para OCR
de PDF integralmente digitalizado. A verdade de release será o HEAD corrente da
PR `feat/719-final-ocr` quando ela for aberta. O OCR permanece **OFF**, pendente
da qualificação Vertex ao vivo e dos gates de release; este status não afirma
merge, deploy, produção ou disponibilidade. PNG/JPEG/WEBP, fotos e imagens
avulsas continuam futuros e não são entregues pela #719.

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
./start-api.sh               # PORT=3011 ./start-api.sh para uma segunda instância
```

`start-api.sh` carrega o `.env` do próprio diretório (seguro em git worktree), respeita um
`DATABASE_URL` já exportado, imprime um resumo do que vai usar antes de subir, grava log em
`/tmp/reformaflow-api-<dir>-<porta>.log` e **aborta** se a porta já estiver ocupada (nunca mata
o processo de outra instância).

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
- Planejamento aprovado do Centro Financeiro (**produto/runtime não iniciado; baseline S0.3
  test-only em andamento**):
  [`docs/plano-centro-financeiro-sdd.md`](./docs/plano-centro-financeiro-sdd.md)

  Em 2026-08-17, #446 foi liberada sob exceção PO para build/test/merge test-only sem aguardar
  #445. Isso não certifica B0, segurança ou produção: #445 concluída/revisada e #446 verde seguem
  gates conjuntos de #447/B0. Produção permanece `NOT_COLLECTED`, nunca zero; código, histórico e
  as 63 migrations commitadas até `20260810234344` descrevem estado esperado, não dados de runtime
  nem migrations efetivamente aplicadas.
