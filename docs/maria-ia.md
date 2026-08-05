# Maria — contrato de IA cross-channel

## CONTRATO (normativo — o que nunca pode quebrar)

### Promessa

A Maria transforma linguagem natural em consulta ou ação assistida de forma consistente entre
chat e voz, e entre os demais canais que vierem a expor o mesmo contrato. Ela deixa claro o que
entendeu, o que consultou, o que pretende alterar e quando não conseguiu concluir.

Respostas probabilísticas não viram autoridade sobre regras de negócio. Regras financeiras,
auth/tenant e persistência continuam nas fontes e serviços determinísticos do caminho direto.

### Escrita, revisão e cancelamento

- Antes de qualquer escrita, a Maria apresenta um resumo dos campos e efeitos e pede confirmação
  explícita. Ambiguidade mantém a operação pendente; silêncio, timeout ou fallback nunca confirmam.
- O usuário pode revisar/corrigir o resumo antes de confirmar e pode cancelar sem efeito
  persistente. Uma correção gera novo resumo e nova confirmação.
- Depois da confirmação, a resposta diferencia sucesso confirmado pelo servidor, falha e estado
  desconhecido. Nunca responde com sucesso quando a tool falhou ou não retornou confirmação.
- Reenvio, retry e timeout não podem duplicar uma escrita.
- Tools reutilizam a mesma autenticação, tenant, escopo de projeto, autorização e validação do
  caminho direto. A Maria não amplia acesso e não libera uma tool sem decisão conjunta de produto,
  domínio, Security e implementação.

### Uploads, OCR e mídia

- Uploads e OCR produzem **preview sem write**. O usuário revisa campos extraídos,
  incertezas, origem e destino antes de qualquer persistência.
- Arquivo ilegível, truncamento, baixa confiança, timeout ou formato não suportado geram fallback
  explícito para correção manual ou nova tentativa; dado ausente não é inventado.
- Voz e TTS sempre têm alternativa textual. Falha/negação de microfone não bloqueia o chat.
- Dados enviados a modelo, logs e evidências são minimizados e redigidos: remover credenciais,
  tokens, identificadores desnecessários e conteúdo financeiro pessoal que não seja indispensável
  ao caso. Artefatos de eval não usam dados reais sem autorização e tratamento adequados.

### Fallback

- Troca de provider/modelo, parser determinístico ou caminho manual deve ser perceptível na
  evidência e preservar segurança, autorização e confirmação.
- Fallback não transforma erro em resposta vazia com aparência de sucesso, não reduz o escopo de
  auth/tenant e não autoriza escrita.
- Custo e latência só bloqueiam quando há baseline e limiar pré-declarado para a mudança; este
  contrato não inventa SLO.

### Evals e gates

- Exatidão de valor monetário e decisão de autorização: **100%** no conjunto direcionado; qualquer
  erro bloqueia.
- Escrita indevida (sem confirmação, fora do tenant/escopo ou divergente do resumo): **0**.
- Cobrir PT-BR de dinheiro/data, ambiguidades, campos ausentes, arquivo/texto adversarial, timeout,
  truncamento, privacidade, tool inválida e fallback.
- Mudança de prompt, modelo ou tool, incluindo seu contrato, apresenta evidência
  **baseline × candidate** com:
  SHA/configuração e prompt/modelo/provider/tool afetados; dataset/versionamento e tamanho; métricas e limites
  pré-declarados; resultados por caso; regressões, custo/latência quando aplicável; fallback e
  decisão PASS/GAPS.

## Referência de implementação

### Registry vivo e classes de efeito

A fonte viva é `AgentToolsService.buildHandlers` em
[`apps/api/src/agent/tools/agent-tools.service.ts`](../apps/api/src/agent/tools/agent-tools.service.ts).
O harness/validator deve descobrir as tools diretamente desse registry vivo; nunca manter uma
lista manual neste documento.

Conceitualmente, uma tool é:

- **consulta** quando apenas lê e não produz efeito persistente;
- **efeito persistente/escrita** quando altera estado, financeiro ou não, ficando sujeita ao
  contrato de confirmação, revisão, cancelamento, autorização e evidência acima.

Adição, remoção ou mudança de efeito deve ser detectada na fonte viva e no harness, não por
sincronização manual de inventário documental.

### Harness vivo

- Para parsing de voz e dinheiro:
  `cd packages/domain && npx vitest run __tests__/expense-voice-parser.test.ts`.
- Usar os testes vivos direcionados em `apps/api/src/agent/**/*.spec.ts`,
  `apps/api/src/receipt-scan/**/*.spec.ts`, `apps/api/src/credit-card/parsers/image-ocr.spec.ts`,
  `apps/api/src/merchant-classifier/**/*.spec.ts`, `apps/api/src/tts/**/*.spec.ts` e os testes de
  chat/voz em `apps/web/src/`.

O `maria-ai-owner` decide o contrato. AI Quality verifica a evidência; Security mantém findings
blocking; builders implementam; Journey QA dirige chat/voz; o PO decide produto/merge.

## Apêndice histórico

- 2026-08-05 — contrato cross-channel criado pela issue #404.

### Gap conhecido

- 2026-08-05 — a cobertura completa de confirmação e autorização para toda operação com efeito
  persistente/escrita ainda não foi provada no runtime. Deve ser tratada na
  [#405](https://github.com/Gabrieldco1994/reformaflow/issues/405) antes
  de declarar conformidade; este contrato normativo não é evidência de que o código atual já o
  satisfaz.
