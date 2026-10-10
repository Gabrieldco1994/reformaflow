# Experiência completa de importação

**Status em 2026-09-11: aprovado, em implementação; ainda não entregue.**

Entrega [#689](https://github.com/Gabrieldco1994/reformaflow/issues/689):
[A — criação cross-project](https://github.com/Gabrieldco1994/reformaflow/issues/690) e
[B — fluxo visual](https://github.com/Gabrieldco1994/reformaflow/issues/691).
Reutiliza as PRs #687/#688, mergeadas na base `9587a19f`; este documento não
comprova deploy. A verificação de toque também cobre a #662, sem encerrá-la por antecipação.

**Recorte Maria em 2026-09-28: autorizado, não entregue.** O contrato prospectivo de
[importação conversacional](#importação-conversacional-na-maria) é separado da entrega #689.
Não libera todo E5, não dispensa H1–H5 e não comprova disponibilidade ou deploy.

**Entrada produtiva CSV aprovada em 2026-10-09, ainda não entregue nem ativa.** O primeiro
rollout fica restrito a CSV de fatura de cartão, atrás do modo de boot documentado no
[contrato da Maria](maria-ia.md#primeiro-rollout-produtivo-entrada-csv-de-fatura). Aprovação,
parsers e testes não comprovam merge do runtime nem QA de release.

**Revisão guiada #716 implementada no candidato de backend GREEN
`5ce573e6a6de033c096389c2be8c7b52639f97d3` em 2026-10-10; não mergeada, implantada,
liberada nem ativa.** O candidato estrutura as decisões que faltavam, mas não altera os
gates de release nem comprova disponibilidade ao usuário.

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

#### Limite do primeiro rollout produtivo

O intake aprovado publica somente **CSV de fatura de cartão**. OFX, PDF, XLS, XLSX e imagens
permanecem fora do rollout ainda que seus parsers ou contratos existam. O catálogo diferencia
`NOT_ENABLED`, `RUNTIME_UNAVAILABLE` e `NO_QUALIFIED_FORMAT`; cada indisponibilidade precisa
ser explicada sem remover o acesso a histórico, resultado e recuperação.

O modo `off` é o padrão e bloqueia só novas entradas. O modo `csv` não reduz os dois atos
humanos a um: **Analisar e guardar rascunho** autoriza persistência documental, enquanto
**Confirmar lote** autoriza os efeitos financeiros daquela revisão. A ativação depende do
[runbook de release](../DEPLOY.md#release-da-entrada-csv-da-maria) e permanece não entregue
até merge do runtime e QA em produção.

1. **Selecionar e consentir:** seleção local até **Analisar e guardar rascunho**, com resumo
   do processamento e da retenção. Só então guardar o objeto privado/sessão autorizados.
2. **Resolver uma compra por vez:** depois da análise determinística, mostrar uma compra
   reconhecível por estabelecimento/descrição, data, valor e parcela/ciclo quando disponíveis.
   O servidor fornece pergunta, rótulos, opções e posições da compra/pergunta. Para o rascunho,
   as decisões estruturadas são `decision`, `targets`, `tipoDespesa` e, quando aplicável,
   `categoriaMaoDeObra`; IDs, nomes de campo, proveniência privada e estados internos não
   aparecem. Texto/voz é alternativa opcional para interpretar somente o campo em foco; cada
   envio exige aceite da informação de que o texto irá ao provider externo e de que nenhuma
   compra será alterada até a pessoa conferir e guardar.
3. **Responder ou adiar:** a pessoa confere a opção e usa **Guardar e continuar**. O comando
   estruturado deriva campo e contexto no servidor, normaliza novamente e faz zero chamadas ao
   provider. **Responder depois** preserva a compra e suas informações no rascunho, mas a retira
   do lote atual; a próxima compra selecionada assume o foco. Em uma retomada/continuação,
   **Continuar compra N de M** a reativa explicitamente sem apagar decisões anteriores. Não
   saber a resposta, adiar a compra, remover uma informação já guardada e cancelar o rascunho
   são ações diferentes. Replay exato conserva o recibo; resultado incerto consulta o estado
   guardado antes de permitir repetir a mesma tentativa.
4. **Definir fonte e finalidade:** cada compra de cartão/fatura que entrar no lote cria ou
   mantém exatamente uma fonte no projeto PESSOAL proprietário do cartão. `TARGETS []` significa
   somente a fonte PESSOAL. `TARGETS [um REFORMA]` significa a mesma fonte mais um único destino
   REFORMA autorizado pelo valor integral, com o vínculo/espelho/alocação existente. Não se cria
   REFORMA sem a fonte, não se aceita mais de um REFORMA neste rollout e fonte + espelho não
   duplicam caixa, fatura ou total econômico. O vínculo e a alocação existentes continuam sendo
   a autoridade; esta decisão não muda números financeiros.
   Com REFORMA, a pergunta de tipo usa sua taxonomia canônica, inclusive
   `MATERIAL_CONSTRUCAO`; sem destino, exige um tipo canônico PESSOAL. Tipo ausente/incompatível
   é perguntado, nunca convertido silenciosamente. `categoriaMaoDeObra` só aparece e é exigida
   para mão de obra.
5. **Revisar somente as prontas:** a projeção `READY_WITH_PENDING` oferece
   **Continuar respondendo** ou **Revisar as prontas agora**. A pergunta fica oculta até essa
   escolha. Revisar faz somente `GET /import-sessions/:id/current-lot`: não há comando
   `REVIEW_READY`, escrita ou avanço de revisão, e leituras repetidas permanecem estáveis
   enquanto proposta e revisão não mudarem. A resposta contém apenas as compras prontas e os
   totais desse conjunto; o navegador não filtra uma proposta ampla. **Continuar respondendo**
   usa `POST /import-sessions/:id/current-lot/continue` apenas com versão, `requestId` e revisão
   esperada — nunca recebe `lineId`. O servidor deriva a seleção pendente do escopo selado,
   invalida a proposta pronta e seu material de confirmação e volta a `NEEDS_INPUT` antes de
   aceitar mais respostas. Se restar trabalho, mostrar apenas “Há outras compras fora deste lote.
   Elas continuam no rascunho para depois.”, sem quantidade, valor, identidade ou total
   subtraível.
6. **Confirmar lote separadamente:** a revisão não lança dinheiro. Um card separado apresenta
   os efeitos do lote pronto e exige confirmação financeira autenticada da UI, com nonce fora
   do LLM. O servidor relê revisão, participantes e estado e aplica o lote atômico. Operações
   sem transação comum têm resumos/confirmações próprios, sem promessa de atomicidade global.
   A confirmação fica vinculada somente à projeção ready-only; é a execução posterior que
   aplica esse lote e cria a sessão de continuação quando o escopo selado ainda tem pendências.
   Abrir a revisão ou confirmar, sem executar, não cria continuação.
7. **Consultar resultado e retomar:** distinguir sucesso confirmado, falha e resultado
   desconhecido. Retomar o rascunho dentro da retenção; após timeout consultar o comprovante
   persistido e autorizado, sem recriar. Undo usa somente capacidades reais, com prova de
   propriedade, ACL e drift.
   Leitura/GET/resultado de recuperação não pedem grant financeira. Já o replay exato de
   confirmação ou execução exige uma grant fresca do servidor para cada invocação HTTP,
   não a grant antiga nem um novo clique humano ou nova confirmação do lote. `nonce: null`
   só recupera a confirmação exata persistida. OFF não impede emissão ou replay consultivo;
   admissão UI, reautorização atual, ACL e tupla persistida vêm antes dos gates de primeira
   escrita. Retry interno não renova nem verifica novamente a grant consumida.
8. **Encerrar:** expiração após sete dias sem edição do usuário; polling não renova.
   Conclusão/cancelamento soltam referências, e o original privado é removido quando não houver
   outra referência/retenção autorizada. Comprovantes e proveniência financeira mínima ficam
   preservados conforme seu contrato, sem guardar a imagem por omissão.

Em 375/390 px, a tela mantém uma coluna, uma decisão primária por vez, controles com pelo
menos 44×44 px e valor sem quebra. Não empilha uma lista de compras com ações concorrentes.
Falha, quota, timeout ou resposta inválida do provider mantém texto/foco e os controles
estruturados disponíveis; adiar, reativar, preparar, revisar e consultar resultado continuam
determinísticos. O contrato detalhado e os gates estão em
[Revisão guiada do CSV — #716](maria-ia.md#revisão-guiada-do-csv--contrato-candidato-716).

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

### Recorte Maria: contrato e checkpoints candidatos, não release

As responsabilidades conceituais são separadas em sessão (`ImportSession`), objeto privado
(`ImportArtifact`), referência sessão/objeto (`ImportSessionArtifact`) e observação documental
(`ImportObservation`). Não são quatro fontes de dinheiro nem um novo ledger. Recibos e
identidades financeiras existentes continuam nos respectivos serviços.

Security PASS conceitual e implementação parcial no candidato não fecham todos os gates de
schema, runtime ou release. Este documento não inventa disponibilidade produtiva: o código
consumidor de novas sessões parte do contrato aprovado e dos gates técnicos aplicáveis. Ver
[decisão de escopo no SDD](plano-centro-financeiro-sdd.md#24-recorte-de-importação-maria).

O caminho compartilhado de execução M1 permanece **candidato inativo**. Adapter, workflow,
grant financeira separada, writer e admissão HTTP financeira estão compostos no runtime
candidato auditado, inclusive nos handlers guiados e de challenge/confirm/execute. Os flags
OFF permanecem; merge, deploy, ativação e release continuam pendentes.

### Componentes locais candidatos M1 — inativos, sem integração

Checkpoint contextual P08 autorizado para implementação **INATIVA**: integrar
o chat à sessão por admissão privada vinculada ao request original, sem nova
rota, confirmação financeira pelo modelo ou fallback para tools genéricas.
Respostas focadas, inclusive “sim”, continuam vinculadas à pergunta; revisão
explícita e recuperação são determinísticas. Somente outcomes do servidor
confirmam edição/preparação; `READ_RESULT` não comprova recibo.

O produtor autoritativo de actions da visão completa preservará as actions de
recuperação/summaries e o `UPLOAD` existente. Escritas continuam OFF e o
consumidor web não será montado por este checkpoint. Extração/materialização,
completude por anexo e decisões sobre fatos “Informado por você” permanecem
gates separados; nenhuma fixture sintética comprova a jornada documental.

`ImportConversationBody` monta `ImportLocalDocuments`, `ImportFocusedQuestion` e
`ImportProposalCard`; `MariaChatBody` seleciona esse corpo quando recebe um contexto
de importação. Essa composição existe no candidato local, mas o modo padrão continua
OFF e não há prova de merge, deploy ou ativação. No baseline `080d68a`, respostas
documentais ainda atravessavam o chat/provider e a revisão consumia a visão completa;
o candidato #716 substitui esses caminhos pelos comandos determinísticos e pela
projeção ready-only, sem tratar ocultação no cliente como controle de segurança.

- A seleção mantém objetos `File` apenas em memória. Remover/cancelar antes do
  consentimento limpa essa seleção, sem cancelar uma sessão remota. Extensões e
  limites vêm dos formatos e limites v1 do domínio; não há validação de conteúdo,
  inferência de MIME confiável, câmera, upload, parser ou armazenamento.
- O botão documental emite uma vez o callback local com os mesmos arquivos.
  Sem callback, com `pending`/`disabled` ou após emissão, a ação fica bloqueada.
  O proprietário deve substituir essa etapa após tratar o evento: o componente
  não declara rascunho guardado, não recebe resposta de API e não tenta novamente.
- A pergunta exige `ImportSessionQuestionV1` completa, as compras identificadas,
  nome e ajuda do campo. Emite somente `{ id, text }`, sem converter dinheiro,
  normalizar DTO ou ampliar o alvo por nome/valor. A projeção reduzida de recovery
  não satisfaz esse contrato. Montar ao abrir a pergunta por ação do usuário dá
  foco ao campo; refresh da mesma pergunta não apaga texto nem retoma o foco.
- Estes componentes continuam sem transporte. A revisão de propostas tem um
  candidato separado abaixo; edição múltipla e integração na Maria ainda exigem
  capacidades reais. Os callbacks locais são eventos síncronos, não adapters de
  API nem confirmação de persistência.

QA de apresentação isolada usa os componentes reais e o CSS do aplicativo, sem
API/Next route, em `apps/web/e2e/maria-local-interaction`. Comando a partir de
`apps/web`: `TZ=UTC npx playwright test --config e2e/maria-local-interaction/playwright.config.ts`.
O harness Vite/Playwright usa dependências já presentes, porta exclusiva com
`strictPort`, um worker e o guard de banco do repositório. Fixtures e screenshots
provam apenas interação/layout local, não uma jornada M1 integrada ou entregue.

### Primitiva financeira interna candidata M1 — inativa

`ExpenseService.createPlannedCardPurchaseInTx` recebe campos de uma compra
planejada e a agenda já explícita, sem handles de sessão. Na criação assistida
interna, a agenda V2 validada é persistida no INSERT da fonte, com UUID gerado
pelo servidor, antes da única geração dos CFEs; o caminho público permanece
inalterado. Evidência, motivo e ator são preservados, sem inventar importação
legada. O núcleo privado é compartilhado com `create`; a inserção de destinos,
projeção documental e geração de seus CFEs continuam no caminho nativo existente.

**Candidata, sem ativação:** o adapter/coordenador candidato chama a primitiva pelo
workflow registrado, sem tornar a superfície ativa ou liberada. Além do teste
unitário de entrada, o spec independente congelado
`expense.planned-card-source.spec.ts` foi validado localmente com `PrismaService`
real, FK ativa e banco descartável: primeiro INSERT observado por middleware e
journal SQL, dez CFEs definitivos da fonte, vinte na composição com destino
integral, sem recriação, e rollback no último CFE da fonte ou do destino.
O mutante que grava a agenda só depois da geração dos CFEs é detectado.
Os controles preservam a criação pública e validam diretamente os metadados do
DTO; não são, isoladamente, prova HTTP nem prova de jornada M1 entregue.

### Revisão e execução M1 — candidato view-layer montado, NÃO LIBERADO

O reader `import-session-workflow-read.ts`, o hook `useImportExecution` e o
`ImportProposalCard` estão montados no corpo contextual candidato, mas continuam
**inativos para release**: o intake padrão é OFF e não há evidência de deploy/QA
produtiva. A montagem local não altera o status do produto nem depende da nova
primitiva financeira em QA.

- `getImportSession` continua sendo a projeção reduzida de recovery. A nova
  leitura completa usa o mesmo `GET /import-sessions/:id`, validando todos os
  campos públicos aninhados, referências, agendas, proposta, confirmação e
  recibo. Não há promoção por cast, defaults ou endpoint alternativo.
- O snapshot e os itens do recibo são conferidos mesmo sem a proposta opcional:
  criações precisam de CFEs, fontes distintas e IDs de destinos/alocações
  coerentes com os destinos aprovados. Isso não exige fontes distintas para
  reutilizações nem inventa a quantidade exata de CFEs dos destinos.
- Pela regra M1, toda linha `CREATE` de qualquer proposta não nula exige ciclos
  de fatura resolvidos nas agendas de origem e dos destinos propostos. Isso vale
  para propostas prontas ou históricas, mesmo com `actions: []`; viabilidade
  aritmética não autoriza publicar uma criação com ciclo desconhecido.
  No recibo imutável, a mesma exigência vale para a agenda de cada linha cujo
  item correlacionado tem resultado `CREATED`, mesmo sem a proposta opcional.
  O snapshot não contém agendas dos destinos, apenas seus projetos e valores:
  não se inventam campos nem quantidade exata de CFEs para conferi-las.
- Ciclos desconhecidos podem permanecer em `KEEP_EXISTING`. Criações ainda
  não resolvidas pertencem ao rascunho, perguntas ou escopo adiado, não à
  proposta publicada nem ao recibo. Não se inferem ciclos ou reescrevem valores
  e agendas. Os efeitos em fatura das criações resolvidas devem conservar o
  total e cada ciclo explícito de origem; destinos e reutilizações não somam
  nova criação.
- No baseline, o card preserva linhas distintas, valores, datas/ciclos, agendas de
  origem, destinos e escopo adiado. A #716 não reutiliza essa resposta ampla para a
  tela final: a revisão guiada recebe do servidor somente o lote pronto, sem
  detalhes, contagens ou valores adiados. Nomes vêm dos catálogos autorizados
  existentes; ausência/falha bloqueia ação financeira e oferece consulta novamente.
  Neste rollout, cada criação mantém uma fonte PESSOAL e aceita somente zero ou um
  destino REFORMA integral; não há promessa de quatro destinos executáveis.
- Somente ações financeiras fornecidas pelo servidor podem aparecer, com visão
  completa, busca concluída, operação conhecida e sem pendência. `READY` sozinho
  não autoriza confirmação. O clique compara a tupla **visível** com um GET
  fresco; mudança exige outra revisão e outro clique.
  A ordem das propriedades de objetos JSON não é mudança de conteúdo; a ordem
  dos arrays e seus valores continuam significativas, inclusive na releitura
  após confirmar. Estados anteriores à confirmação não podem carregar uma
  confirmação antiga; a revisão aprovada pode permanecer histórica nos estados
  pós-confirmação.
- Challenge, confirmação e execução usam o helper de API existente, cookies e
  o header de UI. O nonce permanece somente na chamada em memória; nunca vai
  para cache, storage, URL, logs ou contexto do modelo. A confirmação não tem
  `actions`: há nova leitura antes de decidir executar. Respostas antigas após
  troca de usuário/sessão não publicam estado nem disparam escritas seguintes.
- O navegador recebe `confirmationHash`, calculado sobre a tupla ready-only
  visível: compras e destinos exibidos, seus cronogramas e os totais/efeitos do
  lote. Challenge e confirmação vinculam essa projeção pública. O digest do plano
  executável completo continua privado sob a chave legada `proposalHash` e nunca
  é serializado para o navegador.
- Resposta perdida consulta a sessão persistida. Retries preservam o UUID da
  tentativa; retomada usa `confirmation.financialRequestId`. Sucesso só é
  apresentado com recibo completo e seu snapshot, nunca narrado pela Maria.
  Recibo incompleto ou incoerente produz erro de leitura, não sucesso parcial.

**Os handlers guiados dedicados e os handlers `/:id/confirmation-challenge`,
`/:id/confirm` e `/:id/execute` estão registrados no runtime candidato.**
Essa composição candidata não concede ativação, entrega ou release.
`ImportConversationReferenceV1` permanece contrato futuro separado.

QA offline usa `apps/web/e2e/maria-workflow-view`: componente/hook reais,
catálogo e respostas sintéticas, identidade de teste por alias local de auth,
CSS/fontes do app, 375/390/1280px e host efetivo de 320px no desktop. O harness
não é rota Next nem login/cadastro. A partir de `apps/web`:
`TZ=UTC npx playwright test --config e2e/maria-workflow-view/playwright.config.ts`.
Todos os runners usam o guard de banco e um worker; não há servidor financeiro
nessa verificação.

### Superfície candidata de API: recuperação de sessões (B1a/B1b) — não entregue

Cinco rotas candidatas existem no código sob `import-sessions`, **compiladas e registradas, mas
sem ativação**: nenhuma configuração, ambiente ou rota liga as escritas, e não há upload,
executor financeiro, tool da Maria nem LLM confirmado. Não é entrega do recorte M1 e não altera
nenhum contrato financeiro; o comportamento visível ao usuário só será documentado no manual
após composição e verificação.

| Rota | Papel | Com escritas desligadas (padrão) |
|---|---|---|
| `POST /import-sessions` | Criar rascunho após consentimento (idempotente por `createRequestId`) | `503 CAPABILITY_DISABLED` antes de qualquer validação ou leitura de banco |
| `GET /import-sessions?state=active\|applied&cursor=` | Lista de recuperação, 25 por página, cursor assinado com TTL de 15 min | Funciona: é leitura de recuperação |
| `GET /import-sessions/:id` | Sessão autorizada, com recibo quando aplicada | Funciona |
| `GET /import-sessions/:id/result` | Resultado/recibo persistido | Funciona |
| `POST /import-sessions/:id/cancel` | Cancelar sessão não aplicada (revisão esperada) | Funciona |

Regras de contrato desta superfície:

- **Identidade e ACL no service.** Cada rota reautentica o usuário e resolve tenant, projeto âncora
  e cartão no service; erro de acesso é sempre o `404` opaco, sem distinguir "inexistente" de
  "sem permissão". Os cinco handlers ficam fora da extração de ids do `ProjectAccessGuard`
  (`@ServiceOwnedProjectAccess()`, marca estática por handler); uma rota nova **não** é protegida
  pela ausência da marca e deve declarar essa decisão e ter testes próprios.
- **Query e body com chaves extras.** A lista aceita só `state` e `cursor`; qualquer outra chave
  (inclusive `projectId`, `sourceProjectId`, `targetProjectId`, `tenantId`), duplicata ou valor
  inválido é `400 INVALID_INPUT` uniforme, para qualquer papel. Nas rotas por id a query extra é
  ignorada e nunca vira seletor de ACL; corpo de `create`/`cancel` com chave extra é `400`. Sem
  token continua `401` antes de tudo.
- **Cancelar sessão já aplicada** é `409 ALREADY_APPLIED` para o dono autorizado. É exceção
  registrada e aceita, não um caminho de desfazer dinheiro.
- **Recibo e retenção.** O recibo v1 é imutável e guarda um snapshot financeiro estrito (linhas,
  cronograma, participantes, totais). A leitura reautoriza todos os participantes antes de
  processar o recibo profundo e nunca recalcula números a partir de despesas atuais. O histórico
  de sessões aplicadas não tem corte de sete dias; a retenção de sete dias sem edição vale para
  rascunhos ativos e o polling não a renova.
- **Cursor.** Chave derivada de `JWT_SECRET`; em produção, segredo ausente, padrão ou com menos de
  32 caracteres faz **apenas a lista** responder `503 CAPABILITY_DISABLED`. Identidade inválida
  (`401`) é avaliada antes. `GET` por id e resultado não dependem dessa chave.
- **Guard de framing de upload (pré-parser).** Existe no código, e é chamado em `main.ts`, um
  middleware que recusa cabeçalhos hostis em `PUT /import-sessions/:id/attachments/:attachmentId/content`
  antes de o parser de corpo do Nest consumi-lo: `Content-Type` diferente de `application/octet-stream`
  → `422 UNSUPPORTED_DOCUMENT`; `Transfer-Encoding`, `Content-Encoding` diferente de `identity` ou
  `Content-Length` ausente, não decimal, zero ou acima de 10 MiB → `400 INVALID_INPUT`. A resposta é
  genérica e o guard não lê banco, disco nem autorização. Ele **não** cria a rota: não há controller,
  reserva, armazenamento nem upload: um `PUT` bem formado nessa rota continua sem handler (`404`) e
  um hostil recebe a recusa genérica acima, sem revelar se a sessão existe. Só decide o framing; a
  autorização continua no service.

### Entrada pública e retomada contextual — candidato INATIVO

O GET existente de `/import-sessions` acrescenta `entry` ao envelope de
recuperação, sem alterar `items`, `nextCursor`, filtros, cursor ou Summary:

- `{ kind: "UNAVAILABLE" }` é indisponibilidade normal, inclusive com escritas
  OFF. Não esconde recuperação, detalhe, cancelamento autorizado ou resultado.
- `{ kind: "CARD_INVOICE", formats: [...] }` exige formatos distintos e não
  vazios, exclusivamente `CSV`, `OFX`, `PDF`, `XLS` ou `XLSX`. Informa a
  disponibilidade de iniciar a jornada; não valida conteúdo nem autoriza o
  cartão selecionado.

A capability interna possui `newImportFormats()` síncrono e obrigatório.
Seu produtor padrão retorna `[]`, mantendo `writesEnabled() === false`,
sem configuração de ativação. Somente após reautorização, com escrita
habilitada, boot não interrompido, runtime do cofre disponível e formatos
qualificados para a cadeia RAW, o servidor pode projetar o ramo positivo.
Formato inválido, coleção esparsa, duplicata ou valor fora do conjunto é
erro explícito, nunca filtragem, deduplicação ou disponibilidade presumida.
O GET consulta apenas o estado de boot/runtime já existente em memória;
não inicia boot, reconferência de lock, I/O documental, parser ou modelo.
Parser disponível ou adoção de EXTRACTED não qualificam a cadeia RAW.
Overrides positivos de teste não são evidência de executor disponível.

Um único GET alimenta dois resultados de leitura independentes: a página
validada e a disponibilidade. Items/cursor inválidos continuam rejeitando a
leitura inteira. Página válida com `entry` ausente ou inválida permanece
utilizável para recuperação, mas apresenta respectivamente `MISSING_ENTRY`
ou `INVALID_ENTRY` e não habilita intake. Esse erro não vira `UNAVAILABLE`
silenciosamente, nem reutiliza disponibilidade positiva anterior.

A composição futura da página pública preserva a Maria genérica sem contexto
de importação. A retomada usa `?importSessionId=<id>` somente como referência:
valida sintaxe, faz GET autorizado e então abre a conversa contextual. Falha
de acesso não degrada silenciosamente para conversa genérica. Navegar ou
retomar não cria sessão, envia documentos, analisa ou cancela remotamente.

O coordenador documental pertence ao host acima da alternância entre seleção
e conversa. O consentimento explícito captura tentativa, usuário, cartão,
arquivos e IDs de request/referências. Após CREATE, verifica a tentativa viva
e adota o ID retornado sincronamente na mesma geração, preservando controller,
arquivos, referências e revisão, antes de publicar URL/apresentação. Só essa
tentativa com esse ID reconhece seu próprio eco de URL. Mudança externa de
sessão, navegação, projeto, usuário ou desmontagem do host invalida a geração;
CREATE tardio não adota, publica ou reserva. O filho contextual reutiliza o
coordenador, sem segunda sequência, e trocar cartão não modifica tentativa
iniciada. Desmontagem visual não significa cancelamento remoto.

Este contrato prepara entrada e recuperação, não entrega RAW → Maria nem
ativa novas importações. A cadeia RAW real e sua qualificação continuam
necessárias para um produtor positivo de produção. Consentimento documental
não autoriza despesas; a confirmação financeira independente permanece
inalterada.

### Bootstrap privado do cofre (B2a) — INATIVO

Os módulos `vault-boot.ts` e `vault-durability.ts`, em
`apps/api/src/imports/import-session/vault/`, implementam apenas o bootstrap isolado.
Nenhum código de produção chama o boot: não há provider/token, rota, writer de upload
integrado nem ativação do produto. A fundação privada futura poderá importar apenas
os tipos `VaultBootHandle`/`VaultRuntime` em storage e purger; somente storage poderá
reutilizar os helpers nominais de durabilidade. Isso não autoriza chamada de boot,
novo consumidor dos coletores, registro ou ON. Configuração sintaticamente completa
não significa cofre disponível.

O handle retorna imediatamente `OFF/BOOT_PENDING`; prova de lock, raízes privadas,
`fsync` e fechamento do descritor próprio, e headroom são verificados sequencialmente.
O mesmo caminho canônico V governa lock, raízes e runtime; `fsync` e `statfs` medem `V/t`,
não V. O descritor de lock emprestado não é fechado. O headroom usa `bavail * bsize`
em BigInt, com comparação inclusiva, e não é reserva de espaço.

O deadline monotônico de **5000 ms é política fail-closed, não SLA medido**. Timeout
é terminal até reiniciar, não espera cleanup e nunca permite ON tardio. Erros operacionais
e tardios usam o Logger existente do Nest com campos estruturados sanitizados; códigos
de OS vêm de conjunto finito, sem mensagem, caminho, stack ou erro bruto.
`SETTLED` e `INVALID_STATFS` são outcomes internos, separados de errno; sucesso tardio
não gera erro. Falhas simultâneas de sync e close permanecem observáveis.

Testes locais com FS real do host e falhas sintéticas não certificam Linux/Fly nem
ativação. Antes de ON, SRE ainda deve provar fsync de diretório no volume, semântica de
statfs, mounts de V/t/trash, latência dos quatro passos e concordância de V com
provisionamento/launcher/FD herdado/writer. Permanecem os limites de TOCTOU de caminhos,
aliases internos e starvation do threadpool; I/O pendente não é cancelado pelo timeout,
e close pendente pode reter um descritor próprio até a saída do processo.
Esta etapa não altera o contrato financeiro nem o comportamento disponível ao usuário.

#### Composição privada — candidato local INATIVO em validação

A composição de runtime/anexos é um candidato local INATIVO em validação, com um único
`IMPORT_VAULT_GATE` privado, apoiado no handle canônico, e três rotas de anexo separadas
das 17 rotas do runtime candidato; não exporta providers nem liga a constante de escritas.
Revogação terminal por perda do lock ou shutdown sela novas admissões e aborta leases
de upload **e** leitura. O descritor emprestado do lock nunca é fechado pelo cofre.

`IMPORT_VAULT_DRAIN_TIMEOUT_MS` será obrigatório, sem valor padrão: somente decimal
inteiro entre **0 e 2147483647**, inclusive. Essa faixa é sintaxe, não aprovação de
qualquer valor para produção; o valor e a janela de término continuam gates de SRE.
Ausência/configuração inválida deverá falhar OFF antes de probes. O provider deverá
instalar o listener terminal e verificar imediatamente um sinal já abortado antes de
ser exposto. As interfaces e o binding integram o candidato local; revisão QA
independente, publicação e autorização de ON continuam pendentes.

O drain usará apenas sinais, promises das leases e fechamento real dos handles;
não depende de Prisma disponível nem de uma ordem de destruição dos módulos Nest.
Após stop, nenhuma nova operação de finalize, self-fence, purge ou consulta ao banco
poderá começar; operações já emitidas podem terminar, preservando o estado realmente
commitado para recuperação. Timeout não prova fechamento nem libera cota. O recorte
usará apenas hooks padrão de shutdown; `app.close()` não certifica sinais do sistema.

Autorização no banco precede a reconferência do lock fora da transação; depois dela,
uma nova transação revalida a autoridade antes de efeitos. Nenhum probe/FS será
aguardado dentro do writer SQLite. Reconferência não elimina TOCTOU nem certifica
Linux/Fly, cadência de detecção ou término do processo. Extração, contexto Maria,
scheduler, launcher e autorização de ON continuam fora desta composição inativa.

Validação candidata SEC-B1a-1 (sem ativação): os parsers de rascunho/proposta agora
validam as chaves aninhadas, tipos, limites do protocolo e referências internas antes de
projetar linhas e perguntas. Reutilizam o cronograma do domain sem recalcular valores,
rótulos ou datas; `null` continua desconhecido. A ACL dos participantes do recibo e dos
destinos projetados precede a validação detalhada: participante oculto mantém `404` opaco,
corrupção autorizada produz somente `500` sanitizado, nunca rascunho vazio. Cancelamento
não interpreta o conteúdo que vai descartar. A descoberta de participantes legíveis não
é truncada pelo limite de 1 MiB; o parse profundo mantém esse limite após a ACL.
Com escopo deferido, `proposal.retainUntil` deve ser exatamente o `expiresAt` herdado,
sem renovar ou reduzir o prazo; sem escopo deferido, permanece `null`. Testes:
`apps/api/src/imports/import-session/import-session.recovery-receipt.spec.ts` e
`import-session.lifecycle.spec.ts`, com controles independentes em
`import-session.sec-b1a1-independent.spec.ts` e `import-session.sec-b1a1-followup.spec.ts`.
Isto fecha o TODO de parse profundo apenas no candidato,
não entrega writer, endpoint novo, execução financeira ou contexto LLM.

Gates de rollout ainda abertos (ativação não liberada):

1. Throttle real e medição do journal mode de produção.
2. Benchmark com snapshot cheio próximo ao limite monetário e de ocorrências, além do receipt
   pequeno; o orçamento de 250 ms (mediana) foi medido só na fixture local.
3. Verificação, por SRE, do `JWT_SECRET` de produção (32 caracteres não provam entropia).
4. Composição do registro em `app.module` com o restante do intake, upload, reserva/lease e
   executor, ainda inexistentes.
5. Verificação de comportamento em ambiente real e atualização do manual.

### X3 — adoção de extração congelada, candidato local inativo

O próximo bloco local coordena reserva com pendências atômicas, adoção de fatos
EXTRACTED, observações/draft e retomada autorizada. Não entrega RAW → primeiro
draft, não monta a jornada pública e não altera a confirmação financeira.
Os booleans obrigatórios por anexo distinguem conclusão nesta sessão de
elegibilidade atual. Após resposta incerta, consultar por GET antes de oferecer
retry explícito da referência ainda elegível; reload não inicia escrita.

`reviewBlockers`, somente na visão completa autorizada, produz um aviso persistente
por compra: **Verificação documental pendente**.

> O documento não contém informações suficientes para verificar esta compra com
> segurança. Corrigir o rascunho, por si só, não resolve esta pendência no fluxo atual.

Detalhes aplicáveis, combinados no mesmo aviso:

- Identidade: “Faltam dados originais necessários à identificação da compra.”
- Ocorrência: “Faltam dados originais necessários à correspondência desta cobrança
  com a compra ou parcela.”

Seleção mista permanece intacta: “Esta seleção contém uma compra com verificação
pendente. Retire-a da seleção para preparar as demais.” A retirada deve ser aceita
pelo EDIT existente e novas actions do servidor; não há desmarcação silenciosa.
A linha retirada permanece no draft/continuidade aplicável como
“Fora deste lote · verificação pendente”.

Aviso não é pergunta nem promessa de que repetir uma resposta fecha B3. Perguntas
genuínas podem coexistir: “Esta resposta atualiza o rascunho; a verificação documental
continua pendente.” Preservam-se compra inteira CREATE e KEEP unitário admitidos.
Estados terminais deixam de apresentar avisos, sem afirmar que fatos foram resolvidos.
Os contratos técnicos e gates estão em [Maria — adoção X3](maria-ia.md#adoção-documental-x3--contrato-local-inativo).

### #716 — complementação humana guiada implementada no candidato, inativa

Este contrato substitui a apresentação B3-A de múltiplas intenções concorrentes.
A implementação existe no candidato de backend GREEN
`5ce573e6a6de033c096389c2be8c7b52639f97d3`; isso não declara merge em `main`,
montagem pública, ativação, deploy ou release.

#### Pergunta e resposta

- A interface mostra uma única compra e uma única pergunta de cada vez. O cabeçalho
  usa a identidade reconhecível disponível — estabelecimento/descrição, data, valor
  e parcela/ciclo — sem linha, observação, revisão, UUID ou nome de campo interno.
- A resposta principal é estruturada e em português: **Total da compra / Valor da
  parcela**, calendário, moeda, quantidade ou número da parcela, além de
  `decision`, `targets`, `tipoDespesa` e `categoriaMaoDeObra` quando aplicável.
  O servidor fornece prompt, opções, rótulos humanos e posições **Compra N de M** /
  **Pergunta N de M**, deriva o campo e o contexto correntes e refaz a validação e
  a normalização canônicas; estado do cliente nunca é autoridade. A proveniência
  privada usada para validar os campos não integra a projeção nem a tela.
- `decision` permite somente as decisões autorizadas pelo servidor. Em `targets`,
  a opção **Somente em [PESSOAL]** envia `[]`; as demais enviam exatamente um
  REFORMA autorizado, com cômodo opcional e o valor integral da compra. Com
  REFORMA, os tipos vêm da taxonomia REFORMA; sem target, vêm da PESSOAL. Categoria
  de mão de obra só é perguntada quando o tipo selecionado é mão de obra.
- Conferir uma opção ainda não grava. **Guardar e continuar** envia o comando
  determinístico, faz zero chamadas ao provider e só avança após aceite do servidor.
- **Não sei informar** registra ausência para a pergunta atual. **Responder depois**
  adia a compra inteira no lote corrente. **Remover informação** revoga uma
  declaração já guardada. **Cancelar rascunho** encerra a sessão nos limites do
  contrato de retenção. As quatro ações não são equivalentes e não podem ser
  inferidas de texto ambíguo.
- Depois de uma resposta aceita, a próxima pergunta selecionada recebe o foco. Sem
  bloqueadores na seleção, aparece **Revisar as prontas agora**; não é obrigatório
  atravessar chat ou provider para chegar à revisão.

Digitar, ditar ou receber um candidato do modelo não grava. **Responder com
texto/voz** exige a divulgação de processamento externo definida no
[contrato #716](maria-ia.md#interpretação-externa-opcional), envia apenas o
literal e o mínimo do campo em foco e retorna candidato ou pedido de
esclarecimento. **Guardar informação** é a ação documental determinística
separada. Falha do provider mantém o texto, o foco e todos os controles
estruturados; não muda rascunho, seleção ou finanças.

#### Adiar, reativar e continuar

- **Responder depois** preserva originais, perguntas, observações e declarações,
  marca a decisão como adiada e retira somente aquela compra da seleção atual.
  Reload e retomada mostram que ela continua no rascunho, sem reaplicar respostas.
- Para voltar às perguntas de um lote pronto parcial, **Continuar respondendo** chama
  `POST /import-sessions/:id/current-lot/continue` com `version`, `requestId` e
  `expectedRevision`, sem `lineId` ou seleção indicada pelo cliente. O servidor deriva
  as compras pendentes do escopo de continuação da proposta selada, preserva as
  declarações aplicáveis e aceita também o caso de pendência apenas em anexo. Antes
  de qualquer nova resposta, muda para `NEEDS_INPUT` e invalida proposta, preflight,
  challenge e digest privados daquele lote; para revisar/confirmar depois, é preciso
  preparar e selar uma nova proposta.
- Uma continuação pós-execução começa sem seleção. **Continuar compra N de M** reativa
  explicitamente uma compra adiada, volta sua decisão para não resolvida e a
  seleciona em uma única operação do servidor. Se o limite do lote já tiver sido
  alcançado, a reativação falha sem alteração e orienta concluir ou retirar outra.
- Reenvio após resposta perdida reutiliza a identidade da mesma operação até
  receber recibo ou leitura definitiva. Replay exato não duplica declaração,
  adiamento ou reativação; conflito de revisão pede recarregar o estado.
- Na experiência visível, resultado incerto de **Responder depois** ou
  **Continuar compra N de M** oferece primeiro **Consultar estado guardado**, sem
  retry automático. Se a consulta comprovar que a operação não foi aplicada, a
  tela mostra exatamente **“A tentativa não foi guardada. Você pode repeti-la.”**
  e só então libera **Repetir esta tentativa**. O foco acessível acompanha o aviso
  ou CTA disponível; em 375/390 px, o CTA permanece alcançável acima do dock.
- Os verbos de continuidade não são intercambiáveis: **Guardar e continuar** salva
  a resposta corrente; **Continuar respondendo** volta à pergunta pendente;
  **Continuar compra N de M** reativa uma compra adiada; **Continuar na Maria**
  abre o contexto recuperado.

#### Lote pronto e confirmação

A revisão vem de uma projeção ready-only do servidor. Ela contém exclusivamente
as compras prontas do lote e os totais desse mesmo conjunto. Item adiado,
incompleto, inválido ou ignorado não aparece nem contribui para contagem, valor,
motivo ou total. Quando existir trabalho fora do lote, a tela pode informar apenas:

> Há outras compras fora deste lote. Elas continuam no rascunho para depois.

Não há lista parcial mais total global que permita descobrir valores por subtração.
Em `READY_WITH_PENDING`, o servidor oferece somente **Continuar respondendo** e
**Revisar as prontas agora**; a pergunta fica oculta até a escolha, e ambas preservam
o trabalho pendente no rascunho. **Revisar as prontas agora** é exclusivamente o
`GET /import-sessions/:id/current-lot`: não existe POST de revisão, a leitura não
altera estado/revisão e a mesma proposta produz a mesma projeção e o mesmo
`confirmationHash`. Revisar não confirma nada. A autorização financeira permanece
no card separado **Confirmar lote**, com revisão e proteção autenticada próprias;
resposta estruturada, candidato do provider, “sim”, adiamento e consentimento
documental não podem acioná-la. A confirmação cobre somente esse lote ready-only;
depois dela, **executar** aplica o lote e, se houver escopo pendente selado, cria e
devolve a continuação. Nem o GET nem a confirmação isolada criam essa sessão.

#### Evidência antes de release

Testes sintéticos devem provar resposta estruturada sem provider, contexto legível,
ausência de IDs, adiar/recarregar/reativar/continuar, revisão diferencial
ready-only, provider inválido/indisponível sem perda e confirmação separada em
375/390/1280 px. O eval de IA compara baseline × candidate e exige zero escrita
por inferência, zero vazamento e 100% para dinheiro/autorização.

Esses testes permitem avaliar o candidato local, não chamar a função de entregue.
Release requer provider Gemini explícito e alcançável no ambiente real, smoke de
interpretação livre com dados sintéticos/sanitizados, falhas reais seguras, tenant
e cofre reais, CI/deploy no SHA de `main` e QA produtiva conforme o
[runbook](../DEPLOY.md#release-da-entrada-csv-da-maria).

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
- 2026-09-29: cinco rotas candidatas de recuperação (criar, listar, ler, resultado, cancelar)
  compostas e testadas com escritas desligadas. Sem ativação, upload ou executor; os gates de
  rollout acima permanecem abertos.
