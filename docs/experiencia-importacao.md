# Experiência completa de importação

**Status em 2026-09-11: aprovado, em implementação; ainda não entregue.**

Entrega [#689](https://github.com/Gabrieldco1994/reformaflow/issues/689):
[A — criação cross-project](https://github.com/Gabrieldco1994/reformaflow/issues/690) e
[B — fluxo visual](https://github.com/Gabrieldco1994/reformaflow/issues/691).
Reutiliza as PRs #687/#688, mergeadas na base `9587a19f`; este documento não
comprova deploy. A verificação de toque também cobre a #662, sem encerrá-la por antecipação.

**Recorte Maria no snapshot de implementação
`6867ba991f4c39deb19bb48ead0cda62a2a9a131`:** a árvore contém a importação guiada
CSV/PDF textual da #718 e a implementação de OCR de PDF integralmente digitalizado da #719. A
verdade de release será o HEAD corrente da PR `feat/719-final-ocr` quando ela for aberta.
`881e9b5c` permanece apenas uma base histórica. OCR e vault estão OFF por padrão, e não há
qualificação Vertex ao vivo; este documento não afirma merge, ativação, deploy, produção, Linux,
Journey nem release. PNG/JPEG/WEBP, fotos e imagens avulsas continuam futuros e não são entregues
pela #719. O recorte de
[importação conversacional](#importação-conversacional-na-maria) é separado da entrega #689.
Não libera todo E5, não dispensa H1–H5 e não comprova disponibilidade ou deploy.

## CONTRATO (normativo — o que nunca pode quebrar)

### Benefício e limites

Importar, revisar, dar finalidade ao gasto e conferir o resultado sem sair
da jornada nem duplicar o caixa.

- **A:** um débito comum do extrato bancário no PESSOAL pode criar uma despesa
  em outro projeto autorizado, pelo valor integral efetivo.
- **B:** arquivo e origem → revisão → resumo → resultado; histórico onde já
  existe, com detalhes antes de desfazer.
- Preservar as capacidades atuais de banco, cartão e Carteira e a associação
  a despesas/recebimentos existentes.
- A entrega #689 não inclui criação inline via cartão/Carteira/Maria, vários destinos,
  novos parsers, dashboard global ou recuperação durável de rascunhos.
- Os contratos de [caixa](cockpit-caixa-real.md), [faturas](visao-conta-faturas.md)
  e [datas](politica-datas-timezone.md) continuam vigentes.

### Criação: rascunho até confirmar

Na entrega #689, o editor guarda apenas uma decisão local. Nenhum POST financeiro cria despesa
ou rateio ao aplicar ou cancelar esse rascunho. Somente **Confirmar importação**
grava origem, destino, vínculo e proveniência na mesma transação central.

O servidor deriva quantidade `1`, valor, status, datas e alocação da linha
efetiva. Origem e destino ficam pagos; para A centavos, seus valores e a
alocação são A, mas o caixa diminui apenas A. A origem mantém a conta bancária;
o destino não recebe conta/cartão nem os identificadores de dedupe/importação
da origem e não vira uma segunda saída da Carteira.

O destino pode ser um projeto vazio, mas precisa estar ativo, ser de outro
projeto do tenant e possuir capacidade e autorização efetiva de despesas.
A categoria deve ser válida no destino e a sala, se informada, deve pertencer a ele.
Não pré-selecionar destino nem confirmar uma categoria silenciosamente.

Criação inline não aceita crédito, parcela, investimento, neutro ou pagamento
de fatura, inclusive reconhecido pelo servidor e disfarçado por override.
Duplicatas fortes e linhas ignoradas nunca criam destinos. Possíveis duplicatas,
mesmo com **Importar mesmo assim**, mantêm apenas a importação existente nesta
primeira fatia. `newTarget` é exclusivo com associação a item existente.

Falha no núcleo de lote com criação inline reverte esse núcleo inteiro.
Associações existentes, executadas depois do núcleo na base atual, não recebem
uma promessa fictícia de atomicidade. Falhas pós-commit devem aparecer como
avisos do resultado confirmado, não como rollback nem como convite a repetir
automaticamente o lote.

### Desfazer: destino próprio e intacto

Somente destino comprovadamente criado pela importação e ainda intacto pode
ser removido junto com a origem, relações e caixa correspondentes.
Uma despesa preexistente associada nunca é apagada como destino gerado.

Alteração posterior, inclusive de título, sala, categoria, valor, status,
vínculo ou dependência incompatível, bloqueia **todo** o desfazer sem escrita.
Não converter automaticamente o destino em despesa planejada para preservar
parcialmente o lote. Não inferir autoria por `createdAt`, `linkedExpenseId`
ou flags do cliente.

A proveniência é versionada, escrita exclusivamente pelo servidor, com donos
estáveis e estado persistido pós-aplicação. Conteúdo inválido, incompleto,
versão desconhecida ou participante desaparecido não significa ausência de
destinos. Somente `null` legado conserva o comportamento anterior, sem backfill.
Mudanças do próprio processamento não podem causar drift imediato nem servir
de justificativa para aceitar edições posteriores do usuário.

Commit e undo releem usuário, tenant, grants e participantes dentro da transação.
ACL integral precede dados, agregados e motivos de drift. Detalhe e undo
compartilham o preflight; todo o lote é verificado antes da primeira escrita,
inclusive antes da reversão de fatura em lote misto. Nunca serializar a
proveniência bruta ou expor participantes ocultos parcialmente.

### Fluxo visual

1. **Arquivo e origem:** conta/cartão/Carteira claramente identificados; formatos
   e limites reais, erros recuperáveis, nenhuma escolha arbitrária de origem.
2. **Revisão:** filtros e decisões por lançamento; manter, associar existente
   ou preparar novo destino. Aplicar à revisão é local; remover associação
   preserva edições, enquanto restaurar sugestão avisa que as descarta.
3. **Resumo:** separar saída de caixa e finalidade no projeto, contar cada linha
   financeira uma vez, apresentar pendências e bloquear confirmação duplicada.
4. **Resultado:** permanecer até Concluir; distinguir criado, associado,
   ignorado, cartão identificado e fatura efetivamente quitada. Resposta perdida
   é resultado desconhecido, nunca certeza de que nada foi criado.
5. **Histórico existente:** Ver detalhes antes de Desfazer; consumir `canUndo`
   e o motivo autoritativo, visível junto ao botão. Preservar os estados e a
   ocultação integral da PR #688.

Desktop usa contexto lateral somente quando couber; caso contrário, o editor
ocupa um subpasso de largura total. Mobile usa uma coluna, sem formulários
empilhados. Voltar preserva revisão e foco; descartar pede confirmação.
Filtrar ou editar não reprocessa arquivo nem repete classificação.

Controles das superfícies alteradas medem pelo menos 44×44 px, inclusive
Confirmar e Cancelar. Valores não quebram linha. Teclado, rodapé e erros não
encobrem a ação. Validar foco, caixas não nulas e hit-testing real em 375/390/1280,
não apenas classes CSS.

### Importação conversacional na Maria

Este recorte consome o
[contrato de consentimentos, confirmação e retenção](maria-ia.md#importação-consentimentos-confirmação-e-retenção).
Guardar um rascunho é escrita documental confirmada, **não** uma prévia sem persistência nem
uma autorização para lançar dinheiro. A exclusão de Maria/rascunho durável da entrega #689
não se aplica como proibição global deste novo recorte; também não altera o rascunho local
daquela entrega.

1. **Selecionar e consentir:** CSV ou PDF textual permanece local até **Analisar e guardar
   rascunho**, com resumo do processamento e da retenção. Só então guardar o objeto
   privado/sessão autorizados. PDF com raster não entra como PDF textual e exige o recorte OCR.
2. **Analisar e revisar:** usar parsers e serviços financeiros existentes, consultar candidatos
   autorizados e explicitar incertezas. Origem, finalidade, compra e ocorrência não são
   intercambiáveis; nome/valor isolados não provam identidade nem pagamento.
3. **Apresentar a proposta:** mostrar compras, valores, cronograma/ciclo, origem, finalidade,
   reutilizações e efeitos financeiros. Mudança material exige revisão e nova confirmação.
4. **Confirmar lote:** card da revisão, com autorização financeira autenticada da UI e nonce
   fora do LLM. O servidor reautoriza participantes e estado e aplica o lote atômico. Operações
   sem transação comum têm resumos/confirmações próprios, sem promessa de atomicidade global.
5. **Consultar resultado e retomar:** distinguir sucesso confirmado, falha e resultado
   desconhecido. Retomar o rascunho dentro da retenção; após timeout consultar o comprovante
   persistido e autorizado, sem recriar. Undo usa somente capacidades reais, com prova de
   propriedade, ACL e drift.
6. **Encerrar:** expiração após sete dias sem edição do usuário; polling não renova.
   Conclusão/cancelamento soltam referências, e o original privado é removido quando não houver
   outra referência/retenção autorizada. Comprovantes e proveniência financeira mínima ficam
   preservados conforme seu contrato, sem guardar a imagem por omissão.

> **OCR #719 continua desabilitado.** `IMPORT_OCR_ENABLED` permanece falso por
> omissão, portanto scans continuam exigindo entrada manual e PDFs
> mistos/pesquisáveis nunca são enviados ao provedor. O slice inerte não cria endpoint: a versão 2
> estrita do mesmo `POST .../attachments/:attachmentId/analyze` aceita somente
> revisão, request id e a referência ao consentimento explícito. Antes disso, a
> pessoa precisa registrar pelo `documentary-answer` uma declaração afirmativa
> persistida e vinculada ao ator, sessão, revisão, anexo, artefato e payload.
> A declaração informa provedor, finalidade, região e retenção de sete dias e
> afirma que o **arquivo original completo**, inclusive metadados e conteúdo
> potencialmente não visível/embutido, será enviado externamente. O servidor inspeciona primeiro o
> PDF original; PDF textual termina localmente e faz zero chamadas externas.
> Apenas PDF integralmente raster, sem qualquer texto pesquisável e com 1–10
> páginas observadas, pode, depois da ativação, enviar uma
> única vez os bytes imutáveis de `application/pdf` ao Vertex regional
> `southamerica-east1`, modelo fixo `gemini-2.5-flash`, via uma fonte explícita. Em produção,
> aceita-se somente o principal
> `reformaflow-ocr@<GOOGLE_CLOUD_PROJECT>.iam.gserviceaccount.com` no arquivo fixo
> `/secrets/vertex-sa.json`; o `apps/api/fly.toml` do candidato ainda não possui esse mount,
> intencionalmente, até o secret existir. Localmente, aceita-se somente o arquivo owner-only
> `~/.config/gcloud/application_default_credentials.json` no shape `authorized_user` gerado pelo
> gcloud, sem descoberta ambiente. Não há API key,
> Developer API, região global, renderização local, File API, cache, tools,
> grounding ou fallback. WIF foi avaliado e adiado porque o caminho STS suportado por
> `google-auth-library` não fornece o controle explícito de timeout/cancelamento e ausência de retry
> exigido para esta fronteira. A falha sanitizada do adapter carrega a fronteira
> imutável `NOT_DISPATCHED` ou `DISPATCHED_OR_UNKNOWN`. Erro de validação,
> ADC ou cancelamento antes de invocar `fetch` é reconciliado como
> `NOT_DISPATCHED`/`OCR_UNAVAILABLE`; rede, timeout, 429 e demais respostas HTTP
> depois da invocação tornam-se `UNKNOWN`/`OCR_ATTEMPT_UNKNOWN`. Bloqueio de
> segurança e resposta malformada pós-dispatch preservam seus códigos conhecidos.
> Nenhum desses resultados repete a chamada: inclusive ledgers legados
> `RATE_LIMITED`, `UPSTREAM`, `ATTEMPTED` e `UNKNOWN` reabrem como tentativa
> desconhecida, enquanto `AUTH` e `NOT_DISPATCHED` reabrem como indisponibilidade.
> Candidatos entram não selecionados e `UNVERIFIED`; preparar uma linha
> escolhida exige declarações documentais atuais. Evidência mínima e origem
> permanecem visíveis ao retomar a sessão, vinculadas ao anexo, artefato e
> candidato. O conteúdo OCR derivado do PDF original completo, o resultado e a evidência OCR
> tornam-se ilegíveis no limite absoluto `ImportOcrUsage.createdAt + 7 × 24 horas`. Toda
> leitura/escrita relevante aplica essa barreira antes de responder, independentemente do cron;
> edição, polling e extensão da sessão não renovam o prazo. Conclusão/cancelamento ou liberação da
> referência local do vault podem apagar antes. O original privado no vault segue a retenção local
> separada da sessão; ela pode soltá-lo antes e nunca renova nem torna novamente legível o conteúdo
> OCR após o limite. Permanecem somente auditoria/proveniência não-conteúdo duráveis:
> consentimento, modelo configurado, `modelVersion` do provedor, região, `authTrace`, correlação,
> contadores, resultado e instante da limpeza. Não permanecem bytes/base64 do PDF, texto ou
> evidência extraídos, resposta/erro bruto, token, secret, chave ou documento de credencial.
> Reservas diárias duráveis limitam chamadas, páginas, bytes e unidades de tokens por pessoa,
> tenant e globalmente. Indisponibilidade
> antes da chamada, bloqueio de segurança/resposta inválida e resultado
> desconhecido sem repetição são erros distintos e orientam entrada manual,
> substituição ou cancelamento; nenhum deles grava finanças. O modelo apenas
> transcreve todas as ocorrências visíveis, em ordem, preservando duplicatas,
> sinal e zero, sem classificar crédito, pagamento, tarifa, juros ou total. O
> migration `20261013180000_import_pdf_ocr_runtime` permanece byte a byte igual
> ao commit original de uma coluna; o ledger entra em
> `20261013183000_import_ocr_usage_budget` e a migration aditiva
> `20261013233000_import_ocr_usage_foreign_keys` reconstrói somente esse ledger,
> sem desligar FKs nem reparar órfãos. Ela preserva todas as colunas e linhas
> válidas e restringe update/delete do tenant, sessão, referência de anexo e
> artefato por chaves compostas tenant-scoped; `actorId` continua vínculo
> validado pela aplicação, sem FK própria. Fixtures cobrem banco novo, upgrade
> legado populado e rejeição de órfão/cross-tenant. A decisão do data owner aceita
> explicitamente o risco residual do transporte do original completo e rejeita
> rasterização local silenciosa neste release. A ativação ainda exige uma captura real única dos
> 18 scans, com 18/18 de qualidade, 10/10 casos mistos/pesquisáveis sem chamada, 35/35 probes de
> serviço, documento denso com 24 linhas, `finishReason=STOP`, `maxOutputTokens=8192`, limites
> pré-declarados de custo/latência/RSS, autenticação `SERVICE_ACCOUNT_FILE_ADC`, aprovação do
> provedor e revisões finais de Security, Privacy e data owner. O código não comprova rollout,
> aprovação do fornecedor nem disponibilidade em produção; qualquer evidência ausente mantém GAPS
> e OCR OFF.

Durante uma sessão ativa, as pendências são resolvidas por controles manuais e determinísticos:

- perguntas focadas do rascunho usam `PATCH /import-sessions/:id/draft`, sem modelo ou tool;
  atestações documentais continuam no writer nativo separado, também sem `/agent/chat`;
- a arquitetura contextual de sessão não existe mais: sem turno/outcome de importação, texto
  livre, aprovação de escopo ou tool contextual. O PATCH legado continua
  selection-only para documentos locais; apenas linhas OCR aceitam correções
  estritamente validadas, sem permitir trocar os IDs das observações;
- dinheiro, datas, parcelas e significado aceitam somente literais estritos; enums e decisões
  vêm de opções tipadas e autorizadas; finalidade exige `NO_TARGETS` explícito ou um único
  `TARGET` integral em REFORMA ativa, acessível e diferente da proprietária, sem destino
  silencioso; eventual cômodo pertence à REFORMA escolhida;
- voz apenas preenche e pré-visualiza deterministicamente o campo atual; a pessoa precisa
  conferir e guardar, sem autosubmit ou fallback para LLM. Alternativas, múltiplos nomes ou
  incerteza no estabelecimento falham fechadas e permanecem para correção manual;
- preparar a proposta e consultar o resultado são chamadas diretas da sessão. `READY` abre a
  revisão; `NEEDS_INPUT` volta às perguntas sem confirmação, execução ou resultado. Nenhuma
  dessas ações substitui a confirmação financeira autenticada e separada no card;
- a Maria genérica permanece fora desse subfluxo, com canal aninhado `TEXT`/`VOICE` apenas como
  proveniência. A detecção do pedido inicial pode abrir a entrada determinística CSV/PDF, sem
  transferir a sessão ao provider. Vault OFF por padrão continua fail-closed, e os sete dias sem
  edição continuam inalterados.

O canal Maria não cria outro ledger, motor de dedupe ou cronograma. Permanecem os contratos
de [caixa](cockpit-caixa-real.md), [faturas e undo](visao-conta-faturas.md),
[quitação cross-project](quitacao-parcela-cross-project.md) e
[datas](politica-datas-timezone.md). Correção documental não prova funding; associação
documental não autoriza novo pagamento ou exclusão de um registro preexistente.

## Referência de implementação

### Integração bancária da entrega #689

O contrato de integração acrescenta `newTarget` à decisão bancária,
`inlineTargetProjects` e `inlineTargetEligible` à prévia, `inlineExpenses`
ao resultado/detalhe autorizado e `postCommitWarnings` quando necessário.
`INLINE_TARGET_INVALID` identifica rascunho inválido; `INLINE_IMPORT_DRIFT`
bloqueia undo por alteração posterior; ACL usa a resposta genérica existente.

Estes nomes são o contrato de implementação aprovado, **não prova de campos
já entregues**. A persistência proposta é um campo nullable versionado no
próprio lote bancário; o diff final deve comprovar upgrade legado, segurança
de serialização e rollback. Não reutilizar `invoiceUndo*` para outra origem.

Reutilizar os importadores em `apps/web`, o histórico compartilhado e o núcleo
transacional de criação/rateio em `apps/api`. O salvamento atual de
`CreateLinkedExpenseModal` cria uma despesa imediatamente: apenas seus campos
podem ser reutilizados em modo rascunho sem esse POST.

### Recorte Maria na árvore candidata

As responsabilidades continuam separadas em sessão (`ImportSession`), objeto privado
(`ImportArtifact`), referência sessão/objeto (`ImportSessionArtifact`) e observação documental
(`ImportObservation`). Não são quatro fontes de dinheiro nem um novo ledger. Recibos e
identidades financeiras existentes continuam nos respectivos serviços.

Na árvore candidata atual, o controller diferencia o envelope focado no mesmo
`PATCH /import-sessions/:id/draft`; o parser estrito e o grant
`FOCUSED_DRAFT_ANSWER` ficam em
`apps/api/src/imports/import-session/import-session.focused-draft-answer.ts`.
Os controles e a serialização vivem em
`apps/web/src/app/projects/[projectId]/maria/_components/ImportFocusedDraftQuestion.tsx` e
`apps/web/src/app/projects/[projectId]/maria/_lib/import-focused-draft-transport.ts`.
O módulo público de conversa contextual e seus adaptadores de UI foram removidos; o contrato
público conserva somente a ação de entrada e a proveniência de canal. O PATCH legado mantém
seleção para documentos locais e aceita correções estritas somente em linhas OCR; respostas
documentais continuam no envelope focado ou no endpoint documental.
`POST /import-sessions/:id/prepare` e `GET /import-sessions/:id/result` permanecem caminhos
diretos. Estes locatores descrevem o candidato, não atestam merge, Linux, release ou produção.

A métrica de projeção de contexto elegível do corpus puro cobre somente o
resultado e a projeção de contexto do avaliador. Ela não comprova autenticação,
isolamento de tenant, passagem pela API nem revalidação do servidor. O snapshot inspecionado é
`6867ba991f4c39deb19bb48ead0cda62a2a9a131`; a decisão de merge/release usa o HEAD
corrente da PR `feat/719-final-ocr` e seus checks vivos, e o avaliador puro não concede autorização
nem substitui essa evidência.

## Apêndice histórico

- 2026-09-11: PO aprovou os dois pacotes e o undo somente de destino próprio
  intacto. Design desktop/mobile e contrato transacional foram consolidados
  antes da implementação. Verificação futura: testes reais de origem →
  destino → leitura → undo, concorrência/ACL/drift e jornada em banco isolado.
- 2026-09-28: contrato prospectivo do recorte Maria aprovado antes do código consumidor:
  consentimento documental separado, card por revisão e retenção de sete dias sem edição.
  Não modifica as garantias transacionais da entrega #689, não entrega o programa completo
  e não dispensa os gates técnicos pendentes. Manual de disponibilidade só após composição
  e verificação do comportamento.
