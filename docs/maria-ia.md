# Maria — contrato de IA cross-channel

## CONTRATO (normativo — o que nunca pode quebrar)

### Promessa

A Maria transforma linguagem natural em consulta ou ação assistida de forma consistente entre
chat e voz, e entre os demais canais que vierem a expor o mesmo contrato. Ela deixa claro o que
entendeu, o que consultou, o que pretende alterar e quando não conseguiu concluir.

Respostas probabilísticas não viram autoridade sobre regras de negócio. Regras financeiras,
auth/tenant e persistência continuam nas fontes e serviços determinísticos do caminho direto.

### Escrita, revisão e cancelamento

- **Toda persistência é escrita**, financeira ou não. Uma autorização documental
  tem escopo próprio; não é exceção à confirmação nem autoriza outras tools.
- Antes de qualquer escrita, a Maria apresenta um resumo dos campos e efeitos e pede confirmação
  explícita. Ambiguidade mantém a operação pendente; silêncio, timeout ou fallback nunca confirmam.
- O usuário pode revisar/corrigir o resumo antes de confirmar e pode cancelar a escrita
  proposta sem aplicá-la. Uma correção gera novo resumo e nova confirmação. Cancelar uma etapa
  não apaga o fato de uma persistência anterior já autorizada; na importação, o consentimento
  documental e o cancelamento do lote financeiro seguem os limites abaixo.
- Depois da confirmação, a resposta diferencia sucesso confirmado pelo servidor, falha e estado
  desconhecido. Nunca responde com sucesso quando a tool falhou ou não retornou confirmação.
- Reenvio, retry e timeout não podem duplicar uma escrita.
- Tools reutilizam a mesma autenticação, tenant, escopo de projeto, autorização e validação do
  caminho direto. A Maria não amplia acesso e não libera uma tool sem decisão conjunta de produto,
  domínio, Security e implementação.

### Uploads, OCR e mídia

- Uploads e OCR não autorizam persistência por si. A seleção local não grava remotamente;
  guardar/processar anexos e rascunhos exige o consentimento documental explícito abaixo.
  A análise produz **prévia sem escrita financeira**: o usuário revisa campos extraídos,
  incertezas, origem e destino antes da confirmação financeira independente.
- Arquivo ilegível, truncamento, baixa confiança, timeout ou formato não suportado geram fallback
  explícito para correção manual ou nova tentativa; dado ausente não é inventado.
- Voz e TTS sempre têm alternativa textual. Falha/negação de microfone não bloqueia o chat.
- Dados enviados a modelo, logs e evidências são minimizados e redigidos: remover credenciais,
  tokens, identificadores desnecessários e conteúdo financeiro pessoal que não seja indispensável
  ao caso. Artefatos de eval não usam dados reais sem autorização e tratamento adequados.

### Importação: consentimentos, confirmação e retenção

1. **Consentimento documental:** antes de qualquer armazenamento remoto, **Analisar e guardar
   rascunho** apresenta processamento, finalidade e retenção. A ação explícita autoriza somente
   o objeto privado, a sessão e o rascunho descritos, sem despesas, pagamentos, rateios ou outros
   efeitos financeiros. Sem esse consentimento, o arquivo permanece apenas na seleção local.
2. **Confirmação financeira independente:** **Confirmar lote** aparece em card com resumo dos
   efeitos e identificação da revisão. Um "sim" em texto ou voz pode encaminhar ao card, mas
   não confirma pelo modelo nem transforma o consentimento documental em autorização financeira.
3. **Autoridade fora do LLM:** a confirmação é uma ação autenticada da UI, com proteção de
   origem/CSRF e nonce de curta validade vinculado à revisão e ao hash da proposta. O nonce não
   entra no contexto do modelo; nenhuma tool pode autorizar a si mesma com `confirmed: true`.
4. **Revisão e ambiguidade:** mudança material invalida a confirmação anterior e exige novo
   resumo/confirmar. Silêncio, timeout e fallback não autorizam. Depois de confirmada, a proposta
   não muda silenciosamente; correção ou undo dependem do estado e das ações permitidas pelo
   servidor.
5. **Cancelamento por etapa:** antes do consentimento documental, cancelar não persiste nada.
   Depois dele e antes da aplicação financeira, cancelar encerra o rascunho e solta suas
   referências sem aplicar finanças. Se a aplicação já ocorreu ou o resultado é incerto,
   consultar o resultado; não prometer cancelamento retroativo nem undo irrestrito.
6. **Retenção do rascunho:** rascunho pendente e sua referência ao original privado expiram
   após **sete dias sem edição do usuário**. Consulta/polling não renova esse prazo.
   Conclusão/cancelamento soltam as referências; o blob só é removido quando nenhuma outra
   sessão ou retenção autorizada depender dele. Uma sessão não ganha acesso a outra pelo reuso.
7. **Preservação financeira:** limpar o original não apaga comprovantes financeiros, decisões
   normalizadas e proveniência mínima necessária à auditoria e à prevenção de reimportação.
   Esses registros seguem a retenção financeira/auditoria, sem conservar a imagem por omissão.
   Recibos privados não são automaticamente conteúdo público ou contexto para o modelo.
8. **Execução e resultado determinísticos:** serviços existentes continuam donos de valores,
   identidade, matching, autorização e execução. O commit revalida acesso e estado; retry ou
   timeout consultam o resultado persistido, sob autorização atual, em vez de repetir criação.
   Consultar resultado/revisão não depende de quota nem de nova chamada ao modelo.
9. **Limite transacional explícito:** cada lote financeiro confirmado tem efeitos atômicos;
   uma falha na aplicação não deixa efeitos financeiros parciais desse lote. Actions que não
   compartilhem transação atômica exigem resumos e confirmações próprios. Não estender essa
   garantia à jornada inteira nem aos importadores anteriores sem prova.
10. **Privacidade:** anexos, evidências e resultados permanecem isolados por autorização e
    minimizados. Parser local é preferido quando disponível; conteúdo necessário enviado a
    OCR/modelo exige informação e consentimento do fluxo. Não usar anexos em treinamento ou
    eval externo sem autorização específica; não expor dados pessoais, caminhos privados,
    nonces ou recibos internos em logs, evidências públicas ou contexto Maria.

O recorte e a sequência da jornada estão na
[experiência de importação](experiencia-importacao.md#importação-conversacional-na-maria).
Este contrato não habilita uma tool nem atesta conformidade do runtime.

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

### Planejamento agent-first futuro

- 2026-08-17 — E5/M0–M3 foi registrado como **FUTURO**, sem implementação aprovada. O roadmap canônico,
  suas dependências e a preservação do planejamento histórico estão no
  [SDD do Centro Financeiro](plano-centro-financeiro-sdd.md#9-maria-futura-preservação-do-planejamento-histórico)
  e no [epic #442](https://github.com/Gabrieldco1994/reformaflow/issues/442). Nada nesse roadmap
  amplia a capacidade entregue descrita neste documento.
- 2026-09-28 — PO aprovou **somente o recorte de importação M1/M2**, com card de confirmação da
  revisão, consentimento documental separado e retenção de sete dias sem edição. Esta
  clarificação normativa é prospectiva, aprovada em commit documental separado **antes do
  código consumidor de novas sessões**; não legitima persistência anterior sem consentimento.
  Security deu PASS conceitual às quatro estruturas, aos consentimentos separados e à retenção;
  **seis gaps técnicos continuam pendentes de tratamento pelo architect**. Não é aprovação
  técnica integral, entrega, conformidade geral da #405 nem autorização de deploy.
  O restante de E5 e os gates de H1–H5 permanecem inalterados; ver
  [decisão e limites no SDD](plano-centro-financeiro-sdd.md#24-recorte-de-importação-maria).
