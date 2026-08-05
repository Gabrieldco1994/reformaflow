# Experiência Mobile/PWA

## CONTRATO (normativo — o que nunca pode quebrar)

### Escopo

Mobile no ReformaFlow é a experiência **responsiva e PWA de `apps/web`**. Não é um aplicativo
nativo iOS/Android. O mesmo produto web deve preservar a jornada em 375 e 390 px, com toque,
teclado/viewport e capacidades do navegador tratados explicitamente.

Este documento define o contrato transversal; ele não é um inventário de telas. Regras de
negócio continuam nos respectivos docs normativos.

### Contrato responsivo

- Toda mudança visível aplicável deve ser verificada em 375 px, 390 px e desktop.
- Controles de toque têm alvo mínimo de 44 px, sem sobreposição; `getBoundingClientRect` e
  `elementFromPoint` comprovam visibilidade e hit-test.
- Fluxos não dependem apenas de hover, precisão de mouse ou viewport fixo.
- Câmera e microfone são melhoria progressiva: indisponibilidade, negação ou revogação de
  permissão oferecem fallback explícito e acionável, sem bloquear o caminho manual.
- Console, HTTP 4xx/5xx inesperados e ações duplicadas fazem parte da evidência, não de inspeção
  visual informal.

### Instalação, offline e atualização

- O PWA deve permanecer instalável a partir do manifest e abrir numa rota válida.
- Offline é degradação explícita. **Nenhuma mutação offline pode aparentar sucesso**: sem
  confirmação do servidor, a ação permanece não concluída e deve poder ser retomada/repetida com
  segurança quando a rede voltar.
- **Dados financeiros nunca são cacheados.** Respostas de API, saldos, lançamentos, faturas e
  qualquer representação financeira não podem ser servidos de cache como se fossem atuais.
- O cache limita-se ao casco estático e ao fallback offline. Navegação prioriza rede; falha de rede
  pode exibir casco/fallback, nunca dado financeiro velho.
- Atualizações do service worker não podem manter indefinidamente uma build anterior. Mudanças de
  estratégia/cache exigem versionamento e limpeza dos caches obsoletos.

## Referência de implementação

- Manifest: [`apps/web/public/manifest.json`](../apps/web/public/manifest.json).
- Service worker: [`apps/web/public/sw.js`](../apps/web/public/sw.js).
- Registro do SW:
  [`apps/web/src/app/_components/ServiceWorkerInit.tsx`](../apps/web/src/app/_components/ServiceWorkerInit.tsx).
- Runbook de evidência:
  [`.claude/skills/journey-qa-runbook/SKILL.md`](../.claude/skills/journey-qa-runbook/SKILL.md).
- Testes de browser vivos: [`apps/web/e2e/`](../apps/web/e2e/), selecionados pela jornada afetada.

O `mobile-experience-owner` decide o contrato; builders existentes implementam; QA/Journey QA
verificam de forma independente; o Fleet PO mantém owner, branch e ordem.

## Apêndice histórico

- 2026-08-05 — contrato transversal criado pela issue #404.
