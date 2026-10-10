# Maria CSV — contrato delimitado do servidor

**Estado em 2026-10-09: implementação em andamento em PR independente baseada em `main`;
não entregue nem implantada.** Este documento define requisitos, não capacidades verificadas.
O [ledger #711](https://github.com/Gabrieldco1994/reformaflow/issues/711) é a referência de
aceite; o contrato prospectivo M1/M2 já aprovado não comprova entrega funcional.

## CONTRATO (normativo — o que nunca pode quebrar)

### Escopo e composição independente

- Extensão backend PDF textual (2026-10-10): somente `.pdf`/`application/pdf`,
  no mesmo vault e workflow; CSV qualificado isoladamente permanece compatível.
  Não habilita OFX, planilhas, imagens, OCR ou o kill switch financeiro amplo.
  Worker local terminável audita todas as páginas por operadores públicos PDF.js:
  qualquer raster pintado, inclusive logotipo, exige `OCR_REQUIRED` no arquivo inteiro.
  Diagnóstico de warning/error retido apenas como booleano, até o cleanup, rejeita
  `DOCUMENT_UNREADABLE`; senha exige `PDF_PASSWORD_REQUIRED`. Nenhum texto diagnóstico
  é persistido/emitido. A cerca de diagnósticos é conservadora, não prova matemática
  de completude de PDFs arbitrários/corrompidos.
  Limites: 10 MiB/arquivo, 30 páginas/arquivo, 60/sessão recontadas na transação
  de publicação, deadline e concorrência existentes; limite pós-retorno de operadores
  e saída textual. Heap V8 de 128 MiB **não limita integralmente buffers externos/nativos**;
  a lista de operadores não oferece limite pré-alocação. Sem promessa de memória total
  limitada ou suporte amplo a PDFs. Datas/anos/significado ausentes continuam desconhecidos,
  ocorrências idênticas não são deduplicadas e pagamento mantém evidência ignorada.

- Somente **CSV suportado de compras de cartão** na conversa Maria. Banco/Carteira, imagens,
  OCR, outros formatos e actions R2 não são parte desta entrega nem requisitos antecipados.
- A PR nasce de `main`, não da branch da PR #714, e não altera essa PR. Deve conter a fundação
  coerente e mínima de import-session, private-vault/upload privado, backend/native writer e
  workflow necessários; UI sobre APIs ausentes, fixtures ou recovery-only não satisfazem aceite.
- Reutilizar serviços financeiros, identidade/dedupe e contratos canônicos, sem motor financeiro
  paralelo. O contrato de cronograma documental #701 é dependência compartilhada, não motivo
  para empilhar as PRs. Incluir apenas sua fundação necessária se ausente em `main`; se #714
  mergear primeiro, atualizar de `main`, remover sobreposição e repetir gates no SHA integrado.
- #703 replay de faturas, #704 refund purposes e CARD restore de #700 são **deferidos**,
  não declarados concluídos. Dependência não separável exige justificativa antes de ampliar
  escopo; proximidade no candidato não autoriza copiar esses pacotes.
- #709/#710 continuam donos dos contratos/fundação, #716 da UX guiada e #712 da qualificação.
  Esta entrega não fecha automaticamente esses ledgers, #711/R2, H1–H5 ou todo E5.

### Consentimentos, privacidade e autoridade

1. Selecionar CSV é local e não persiste remotamente. **Analisar e guardar rascunho** informa
   finalidade, processamento e retenção; consentimento explícito autoriza apenas upload
   privado, sessão e preparação documental. Não usar storage público nem URL pública de anexo.
2. Sessão, anexo, revisão e recibo são isolados por usuário/tenant/escopo autorizado. Reuso de
   objeto não concede acesso a outra sessão. Servidor reautoriza leitura e execução; troca de
   usuário não herda rascunho ou confirmação.
3. Usuário escolhe explicitamente cartão e compras, inclusive quando só há um cartão.
   Sem cartão/configuração obrigatória, orientar cadastro/retomada e bloquear confirmação.
   Seleção/desseleção, declarações e correções são humanas; sugestão do parser/modelo não é
   decisão confirmada. Resposta altera somente o campo alvo e não sobrescreve revisão humana.
4. Revisão contém exatamente o subconjunto selecionado, elegível e pronto; pendências,
   não selecionados e inválidos não são aplicados. Zero elegíveis/only-ignored não oferece
   confirmação financeira.
5. **Confirmação financeira explícita e independente** identifica a versão visível e seus
   efeitos. A ação autenticada da UI usa proteção de origem/CSRF e nonce de curta validade
   vinculado à revisão/hash da proposta, fora do contexto LLM. Modelo/tool/`confirmed: true`,
   texto afirmativo, silêncio ou timeout não autorizam commit. Mudança material exige nova
   revisão e confirmação.
6. Seleção local, consentimento/upload, análise, edição, seleção/desseleção, revisão, reload,
   retry e cancelamento pré-confirmação não criam nem alteram Expense, CashFlowEntry, funding,
   liquidação ou efeito financeiro equivalente. Persistência documental consentida é distinta.

### Evidência documental e efeito financeiro

- Pagamento de fatura aparece **ignorado com motivo**, evidence-only: não vira compra, despesa,
  fluxo, funding, liquidação nem erro financeiro retryable; compras elegíveis seguem revisáveis.
  Evidência de modo de pagamento não é uma compra de cartão nem prova pagamento/funding.
- Confirmação de uma compra selecionada cria exatamente uma compra e o fluxo planejado
  correspondente. Preservar centavos por ocorrência, datas reais, parcelas/ciclos explícitos,
  identidade e proveniência; não redistribuir total/N nem reconstruir cronograma divergente.
  Destino/finalidade, inclusive REFORMA autorizada, é revisado pelo usuário; não gera dupla compra.
- Commit revalida acesso, participantes, versão e estado dentro da transação canônica.
  Lote confirmado é atômico; operações sem transação comum exigem resumos/confirmações próprios,
  sem promessa de atomicidade global da jornada ou dos importadores legados.
- Repetição/retry da mesma confirmação produz um único efeito e o mesmo recibo persistido.
  Resposta perdida é resultado desconhecido: consultar estado/recibo autorizado, sem anunciar
  sucesso não comprovado ou iniciar nova criação. Consulta não exige nova chamada ao modelo.

### Retomada, terminalidade e retenção

- Reload/reabertura recupera decisões e pendências autorizadas; estado terminal e recibo não
  regridem a upload nem reaplicam. `APPLIED` com attachment ausente não oferece nem aceita
  retry de upload/análise/aplicação, inclusive por chamada direta. `DRAFT` na etapa `UPLOAD`
  com attachment ausente pode reenviar com consentimento válido.
- Falha, lentidão e recuperação são explícitas. Retry não duplica processamento/aplicação,
  não sobrescreve decisões humanas e respeita isolamento, versão e estado.
- Um CSV enviado novamente com bytes idênticos na mesma sessão não cria outro anexo
  analisável: o servidor libera a reserva duplicada, remove sua referência pendente na
  mesma transação e retorna um resultado explícito de deduplicação; os arquivos únicos
  da sessão continuam disponíveis para preparação.
- Rascunho pendente expira após **sete dias sem edição do usuário**; consulta/polling não
  renova. Concluir/cancelar libera referências. Remover o original privado quando não houver
  referência ativa nem retenção autorizada que exija preservação; cumprir também remoção
  exigida pela política autorizada. **O padrão após aplicar é não reter originais.**
- Apenas recibo/proveniência e decisões normalizadas minimamente necessários da operação
  aplicada permanecem conforme retenção financeira/auditoria. Limpar original não apaga essa
  trilha; ela não autoriza conservar CSV bruto por omissão. Cancelar não desfaz aplicação já
  ocorrida; resultado incerto exige consulta, não promessa de undo ou CARD restore.

### Habilitação e prova de entrega

- Escritas financeiras amplas em produção somente se **explicitamente habilitadas no servidor**,
  com controle e padrão fail-closed documentados: configuração ausente, inválida ou desabilitada
  não autoriza escrita. Consentimento e confirmação não são substituídos por essa habilitação.
  Este contrato não inventa nome de flag, afirma que o gate já existe ou certifica ativação.
- Contrato inativo/default-OFF não satisfaz a jornada funcional; tampouco autoriza ativação em
  produção para obter evidência. Aceite exige prova integrada e gates de release aplicáveis.
- Testes focados e typecheck no SHA integrado, regressões de ACL/privacidade, zero efeitos
  pré-confirmação, idempotência, cronograma, ignored payment e retry terminal são necessários.
  Migrations exigem gates fresh e upgrade legado representativo em bancos descartáveis,
  preservando IDs, centavos, dedupe e trilhas, com integridade/FK; sem reset ou dados reais.
- Jornada Linux real parte de signup descartável e navegação Maria visível (não URL direta ou
  sessão preseeded), com APIs e banco isolados em 1280×800, 375×844 e 390×844. Cobrir nenhum/
  um/vários cartões, configuração incompleta, zero/only-ignored/múltiplas compras e subconjunto,
  falha/retomada, confirmação incerta e reload. CTAs não ficam cobertos pela navegação;
  toque mínimo 44px, foco/hit-testing, labels específicos e dinheiro legível.
- Analytics/eventos são opcionais/deferidos, não requisito ou substituto de aceite. Não
  registrar conteúdo financeiro, anexos, credenciais, nonces ou artefatos privados em logs.
  Evidências públicas usam somente cenários sintéticos e sanitizados.
- Merge não é deploy. Produção exige CI e **Deploy API to Fly** verdes no SHA correto de
  `main`, migrations aplicadas e provas Fly/Vercel/jornada e upgrade/rollback quando aplicáveis.

## Referência de implementação

Na base documental `3d83771c9b60333d3534dc62119f34cc98f62148` não há subsistema import-session
que comprove esta entrega. Nenhum endpoint, DTO, schema, flag ou capacidade candidata é
declarado entregue aqui. A composição final deverá vincular locatores e evidências por AC no
[ledger #711](https://github.com/Gabrieldco1994/reformaflow/issues/711).

Fontes complementares: [contrato Maria](maria-ia.md#importação-consentimentos-confirmação-e-retenção),
[jornada de importação](experiencia-importacao.md#jornada-delimitada-csv-de-cartão-711),
[status do cockpit](estado-atual-cockpit-pessoal.md), [caixa](cockpit-caixa-real.md),
[faturas](visao-conta-faturas.md), [datas](politica-datas-timezone.md) e [índice](README.md).
O manual da experiência permanece sob ownership frontend; este documento não substitui sua
atualização e verificação na entrega funcional.

### Dependência de modelo na resposta guiada (candidato, não prova de entrega)

`AgentService.contextual` encaminha `ANSWER` ao provider construído em
`agent.module.ts`; o parsing determinístico do CSV não elimina essa dependência.
O padrão atual é Ollama em `http://localhost:11434/v1`: uma URL configurada não
comprova disponibilidade do serviço/modelo. Falhas reconhecidas de transporte e
ausência de credenciais retornam `503` com `importOutcome.code = PROVIDER_UNAVAILABLE`,
sem editar o rascunho nem autorizar finanças. Erros de contrato do modelo permanecem
distintos (`MODEL_OUTPUT_INVALID`).

O teste `apps/api/src/agent/agent.import-provider.spec.ts` cobre DTO, controller,
admissão/bridge e provider reais, com persistência representativa e conexão recusada
em loopback. A jornada Linux completa precisa de Ollama acessível com o modelo
configurado (`AGENT_MODEL`, padrão `qwen2.5:7b-instruct`), ou de autorização explícita
para usar um provider externo e enviar o conteúdo mínimo da sessão: por exemplo,
`AGENT_LLM_PROVIDER=gemini` com `GEMINI_API_KEY` (ou `GOOGLE_API_KEY`) e modelo
compatível com tools. Não habilitar acesso externo nem obter credenciais implicitamente;
503 não é evidência de confirmação bem-sucedida.

## Apêndice histórico

- 2026-10-09: documentado o recorte CSV independente de `main` conforme ledger #711, separado
  da PR #714. Aprovação do contrato não marca AC funcional, conclusão de código ou produção.
