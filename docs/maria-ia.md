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
   origem/CSRF e nonce de curta validade vinculado à revisão e ao `confirmationHash` público,
   calculado somente sobre a tupla ready-only visível. O digest do plano executável completo
   permanece privado sob a chave legada `proposalHash` e nunca é serializado. O nonce não entra
   no contexto do modelo; nenhuma tool pode autorizar a si mesma com `confirmed: true`.
   Cada invocação HTTP de challenge, confirmação ou execução exige uma grant financeira
   fresca, emitida pelo servidor para aquela requisição autenticada e consumida uma vez,
   inclusive no replay exato de confirmação/execução. **Grant fresca não significa novo
   clique humano nem nova confirmação financeira:** o replay usa a tupla já persistida,
   nunca a grant antiga. `nonce: null` só pode recuperar uma confirmação exata já persistida,
   não criar a primeira. A grant documental não autoriza finanças, e a financeira não
   substitui o nonce ou a confirmação persistida.
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
   GET/leitura/resultado de recuperação não exigem grant financeira. O kill switch OFF não
   impede sua emissão nem o replay exato consultivo: após a admissão UI, reautorização atual,
   ACL completa e comparação da tupla persistida precedem os gates de primeira escrita.
   Retries internos conservam a admissão somente na invocação corrente, sem verificar,
   reemitir ou renovar a grant; cada tentativa reautoriza e usa novos handles transacionais.
9. **Limite transacional explícito:** cada lote financeiro confirmado tem efeitos atômicos;
   uma falha na aplicação não deixa efeitos financeiros parciais desse lote. Actions que não
   compartilhem transação atômica exigem resumos e confirmações próprios. Não estender essa
   garantia à jornada inteira nem aos importadores anteriores sem prova.
10. **Privacidade:** anexos, evidências e resultados permanecem isolados por autorização e
    minimizados. Parser local é preferido quando disponível; conteúdo necessário enviado a
    OCR/modelo exige informação e consentimento do fluxo. Não usar anexos em treinamento ou
    eval externo sem autorização específica; não expor dados pessoais, caminhos privados,
    nonces ou recibos internos em logs, evidências públicas ou contexto Maria.

### Primeiro rollout produtivo: entrada CSV de fatura

**Contrato aprovado em 2026-10-09; ainda não entregue nem ativo em produção.**
Código candidato, testes, tipos compartilhados ou configuração planejada não mudam esse status.
Somente merge do runtime seguido dos gates de release e da QA de produção permite declarar a
entrada disponível.

- Há um único modo de boot para nova entrada:
  `IMPORT_SESSION_INTAKE_MODE=off|csv`. Ausência da variável equivale a `off`; qualquer outro
  valor é configuração inválida e deve impedir o boot, em vez de degradar silenciosamente.
- `off` impede **novas** entradas, mas não desliga histórico, leitura de resultado ou recuperação
  autorizada de sessões já existentes. Desabilitar intake nunca pode esconder o que o usuário
  precisa consultar ou retomar.
- `csv` qualifica somente **fatura de cartão em CSV**, ponta a ponta. O perfil aceito é UTF-8,
  com BOM opcional e LF ou CRLF, usando um único perfil reconhecível com vírgula ou ponto e
  vírgula. O cabeçalho exige exatamente uma coluna de data (`date` ou `data`), descrição
  (`title`, `descricao`, `descrição`, `memo`, `historico`, `histórico`, `estabelecimento`,
  `lancamento` ou `lançamento`) e valor (`amount`, `valor` ou `value`). Decimal pt-BR no perfil
  com ponto e vírgula, delimitador entre aspas na mesma linha, BOM+CRLF e duplicatas são
  suportados. Os limites por arquivo são 10 MiB, 1.000 registros, 64 colunas e 1.000 bytes
  UTF-8 por campo.
- CSV com quebra de linha dentro de campo entre aspas, cabeçalho ausente/ambíguo/duplicado,
  colunas inconsistentes, delimitadores conflitantes ou UTF-8 inválido falha como
  `UNSUPPORTED_DOCUMENT`; excesso de limite falha como `LIMIT_EXCEEDED`. Arquivo declarado
  como PDF falha como `UNSUPPORTED_DOCUMENT` na reserva, antes de parser, cofre ou escrita,
  inclusive PDF textual de uma ou várias páginas e PDF escaneado. Magic de PDF disfarçado de
  `text/csv` é recusado depois pela extração CSV estrita. OFX, XLS, XLSX e imagens continuam
  indisponíveis neste rollout, mesmo que exista parser, tipo, fixture ou contrato parcial para
  eles. Suporte de parser isolado não é formato qualificado para produção.
- O catálogo de entrada usa motivos tipados, não um indisponível ambíguo:
  - `NOT_ENABLED` — o modo de nova entrada está `off`;
  - `RUNTIME_UNAVAILABLE` — o modo foi solicitado, mas o runtime obrigatório não está disponível;
  - `NO_QUALIFIED_FORMAT` — o runtime respondeu, mas nenhum formato completou a qualificação
    produtiva.
    A web deve tornar o motivo compreensível e oferecer a recuperação adequada sem apagar
    histórico, resultado ou retomada. Resposta malformada ou falha de catálogo permanece erro
    visível e recuperável; nunca vira lista vazia nem disponibilidade presumida.
- **Analisar e guardar rascunho** continua sendo consentimento documental. Ele não é
  `Confirmar lote`, não concede autorização financeira e não pode ser reaproveitado como tal.
  A confirmação financeira continua separada, vinculada à revisão e executada pela ação
  autenticada da UI descrita acima.

O rollout usa wire versionado e exige **API antes da web**. Seus pré-requisitos operacionais são:
database migrado antes do boot; prova do cofre no Linux real da imagem/ambiente de produção;
provider real configurado; tenant, capability e runtime reais; e QA de release sem override de
teste como evidência. O runbook e a ordem estão em
[`DEPLOY.md`](../DEPLOY.md#release-da-entrada-csv-da-maria).

O recorte e a sequência da jornada estão na
[experiência de importação](experiencia-importacao.md#importação-conversacional-na-maria).
Este contrato não habilita uma tool nem atesta conformidade do runtime.
O checkpoint M1 continua candidato inativo. Adapter, workflow, autoridade e writer
compostos não representam entrega da jornada nem ativação.

### Revisão guiada do CSV — contrato candidato #716

**Verificado na baseline funcional #716
`3bb5c28b9129388944374e9291f3426ef226699d` em 2026-10-10; ainda não mergeado,
implantado, ativo nem qualificado para produção.** Este contrato substitui, para a
jornada guiada candidata, o caminho amplo pelo chat e a filtragem de revisão no
cliente. A implementação no candidato não altera o status de release: merge, gates
verdes, deploy SHA-strict e QA de produção continuam necessários. Commits documentais
posteriores descrevem essa baseline sem redefinir qual código funcional foi verificado.

#### Controles estruturados e continuidade

- A ação primária é sempre um controle estruturado em português: opções fechadas,
  calendário, valor monetário ou número de parcela conforme a pergunta. A superfície
  guiada cobre também `decision`, `targets`, `tipoDespesa` e, somente quando o tipo
  for mão de obra, `categoriaMaoDeObra`, nessa ordem por compra. A compra é
  reconhecível por estabelecimento/descrição, data, valor e parcela/ciclo quando
  disponíveis; UUID, revisão, nome de campo interno e outros identificadores nunca
  são texto visível ou acessível.
- Pergunta, opções, rótulos humanos e posições **Compra N de M** / **Pergunta N de M**
  vêm da projeção autorizada do servidor. O navegador não fabrica opções a partir de
  IDs ou catálogos locais e só pode enviar uma resposta que esteja na allowlist
  corrente. A proveniência privada dos campos continua guardada para validação e
  auditoria, mas não aparece na projeção, nos rótulos nem na tela.
- O controle estruturado primeiro mostra a conferência da escolha. **Guardar e
  continuar** envia a resposta ao comando documental autenticado e avança somente
  após o aceite do servidor; essa ação faz **zero chamadas ao provider**. O servidor
  resolve a pergunta, linha, observação, campo e contexto correntes e refaz a
  normalização canônica. Preview do navegador e candidato de modelo não são
  autoridade. O comando tem `requestId`, hash canônico do payload, CAS de revisão e
  grant documental de uso único vinculada à operação; replay exato devolve o mesmo
  recibo, enquanto o mesmo `requestId` com outro conteúdo falha sem efeito.
- Toda compra de cartão/fatura efetivamente incluída no lote cria ou mantém
  **exatamente uma despesa-fonte no projeto PESSOAL proprietário do cartão**.
  `TARGETS []` significa somente essa fonte. `TARGETS [um REFORMA]` conserva a mesma
  fonte e acrescenta exatamente um destino REFORMA autorizado, pelo valor integral,
  usando o vínculo/espelho/alocação financeiro já existente. Nunca há REFORMA sem
  fonte PESSOAL, mais de um REFORMA neste rollout ou dupla contagem de fonte +
  espelho no caixa/fatura.
- As opções de `targets` são fechadas pelo servidor: **Somente em [PESSOAL]** ou um
  projeto REFORMA autorizado, opcionalmente com seu cômodo, sempre pelo valor integral
  da compra. Com um REFORMA, `tipoDespesa` usa a taxonomia canônica de REFORMA
  (por exemplo, **Material de construção**); com `TARGETS []`, usa a taxonomia
  canônica PESSOAL. Tipo ausente ou incompatível vira pergunta — nunca mapeamento
  silencioso. `categoriaMaoDeObra` é obrigatória apenas para **Mão de obra** e deve
  ficar ausente nos demais tipos.
- **Responder depois** adia somente a compra em foco: preserva perguntas,
  declarações, observações e referência documental, retira a compra do lote atual e
  não cria efeito financeiro. **Continuar compra N de M** reativa uma compra adiada,
  muda sua decisão para não resolvida e volta a selecioná-la atomicamente; não basta
  esconder ou selecionar a linha apenas no cliente.
- Em um lote pronto parcial, **Continuar respondendo** usa o comando documental
  `POST /import-sessions/:id/current-lot/continue`. Seu corpo contém somente
  `version`, `requestId` e `expectedRevision`: não aceita `lineId` nem seleção do
  cliente. O servidor mantém na seleção o subconjunto já pronto e acrescenta, em ordem
  de rascunho, as linhas pendentes retomáveis derivadas do escopo de continuação selado;
  preserva as declarações aplicáveis e cobre também pendência apenas em anexo. O aceite
  muda a sessão para `NEEDS_INPUT` e invalida proposta pronta, preflight, challenge e
  digest privado antes de qualquer resposta nova; uma revisão posterior exige nova
  preparação.
- A continuação criada somente depois de executar um lote ready-only conserva o
  escopo adiado e as decisões documentais aplicáveis. O servidor preseleciona, em ordem
  de rascunho, até dez linhas retomáveis; somente uma sucessora com pendência exclusiva
  de anexo começa sem seleção. **Continuar compra N de M** reativa explicitamente uma
  compra adiada que esteja fora da seleção corrente. Abrir a revisão ou confirmar sem
  executar não cria sucessora. Reload, retomada e resposta perdida consultam o estado
  autoritativo antes de repetir; uma decisão já aceita não é perdida nem enviada
  novamente com nova identidade.
- Os rótulos de continuidade têm funções únicas: **Guardar e continuar** salva a
  resposta em foco; **Continuar respondendo** volta às perguntas quando já existe
  um lote pronto; **Continuar compra N de M** reativa uma compra adiada; e
  **Continuar na Maria** apenas abre um contexto recuperado. Um rótulo não pode
  executar a função de outro.
- Para `DEFER` e `REACTIVATE`, a recuperação segue estritamente
  `NORMAL → VERIFY_REQUIRED → RETRY_READY`. Resultado incerto leva a
  `VERIFY_REQUIRED`: a UI bloqueia as ações da compra, oferece somente
  **Consultar estado guardado** e não repete o comando automaticamente. A leitura
  autoritativa que comprova a aplicação encerra a recuperação sem reenvio; se
  comprovar que nada foi aplicado, entra em `RETRY_READY`, mostra exatamente
  **“A tentativa não foi guardada. Você pode repeti-la.”** e libera
  **Repetir esta tentativa**. Somente esse CTA reenvia a mesma operação com o mesmo
  `requestId`; outro resultado incerto retorna a `VERIFY_REQUIRED`. O foco acessível
  acompanha o aviso ou CTA vigente e, no mobile, o CTA permanece alcançável acima
  do dock.
- Declaração, resolução, adiamento, reativação e preparação usam comandos dedicados.
  A UI guiada candidata não usa o `PATCH /:id/draft` genérico nem `/agent/chat` para
  essas mutações. Grants documentais não autorizam challenge, confirmação, execução
  ou qualquer escrita financeira.

#### Interpretação externa opcional

**Responder com texto/voz** é alternativa secundária e opcional. Antes do primeiro
envio daquele texto, a UI apresenta:

> Seu texto será enviado ao provedor de IA apenas para interpretar esta resposta.
> Nenhuma compra será alterada até você conferir e guardar.

Cada envio exige aceite explícito dessa divulgação e autoriza somente a interpretação
solicitada; não substitui o consentimento documental do arquivo, não vale para outro
texto e não confirma finanças. Os controles estruturados, adiamento, reativação,
preparação, revisão, confirmação e consulta de resultado fazem **zero chamadas ao
provider**.

A interpretação é read-only e produz apenas um **candidato** para o controle em
foco. O usuário ainda confere e aciona **Guardar informação**, que usa o comando
determinístico com novo `requestId`. O modelo nunca recebe tool de declaração,
edição, adiamento, preparação, confirmação ou escrita financeira.

O payload externo é fechado, específico para interpretação e minimizado: literal
enviado conscientemente, semântica do único campo, limites necessários e aliases
aleatórios válidos só naquela requisição. Não contém IDs estáveis, tenant, usuário,
sessão, projeto, cartão, sufixo do cartão, filename, hash, referência, CSV bruto,
outras linhas/compras, estado selecionado/adiado, totais, proposta, recibo, nonce ou
grant. Texto do usuário, conteúdo documental e saída do modelo são não confiáveis;
a resposta exige schema estrito, alias correspondente, trecho exato do literal e
nova validação determinística contra pergunta, autorização e revisão correntes.

Timeout, quota, indisponibilidade, recusa, tentativa de tool, injeção no documento
ou resposta inválida geram falha recuperável explícita. Não há fallback para tool
genérica nem gravação parcial: texto e foco permanecem, os controles estruturados
continuam utilizáveis e a sessão segue retomável.

#### Revisão ready-only e confirmação

- **Revisar as prontas agora** usa uma projeção separada produzida pelo servidor para
  o lote atual. Ela inclui somente compras selecionadas e prontas e totais calculados
  exclusivamente sobre elas. O cliente não recebe a proposta completa para esconder
  itens localmente nem deriva a revisão de linhas em cache.
- Essa revisão é exclusivamente `GET /import-sessions/:id/current-lot`. Não existe
  mutação `REVIEW_READY`: a leitura não avança revisão nem altera estado, e chamadas
  repetidas retornam a mesma projeção e o mesmo `confirmationHash` enquanto a
  proposta selada e sua revisão permanecerem iguais.
- Quando o servidor responde `READY_WITH_PENDING`, as únicas escolhas guiadas são
  **Continuar respondendo** (`CONTINUE_ANSWERING`) e **Revisar as prontas agora**
  (`REVIEW_READY`). A pergunta em foco fica oculta até a pessoa escolher; continuar
  preserva respostas e pendências, mas invalida a proposta pronta antes de reabrir
  perguntas; revisar não descarta nem altera o que ficou no rascunho.
- Compras adiadas, incompletas, inválidas, ignoradas por política ou sem autorização
  não contribuem com título, valor, identificador, contagem, motivo, total global ou
  qualquer resto calculável. Pagamento de fatura `IGNORED_POLICY` permanece somente
  como evidência auditável, sem pergunta ou seleção, e é terminal: sozinho não produz
  `READY_WITH_PENDING`, continuação ou a mensagem genérica. `EXCLUDED` também é
  terminal. Somente observação/anexo deferido ou linha `DEFERRED` torna verdadeiro o
  booleano que permite: **“Há outras compras fora deste lote. Elas continuam no
  rascunho para depois.”**
- Abrir a revisão não autoriza finanças. O card separado **Confirmar lote** continua
  exigindo clique explícito, releitura atual, grant financeira, nonce e proposta
  vinculados à revisão. Texto, voz, “sim”, consentimento externo, consentimento
  documental e grant documental nunca substituem essa confirmação.
- A confirmação vincula somente o lote ready-only. A execução posterior aplica esse
  lote e, quando a proposta selada conserva trabalho pendente, cria a sessão indicada
  por `continuationSessionId`; o GET de revisão e a confirmação isolada não criam a
  continuação.
- Depois de resposta financeira incerta, **Consultar estado guardado** consulta primeiro
  `GET /import-sessions/:id/result`. Se houver `APPLIED` com recibo, a recuperação termina
  sem repetir `execute` e sem consultar `current-lot`: limpa a identidade financeira local,
  deixa indisponível a ação financeira antiga e informa o sucesso persistido. Só resultado
  `READY` ou `CONFIRMED` permite então reler `current-lot`; falha do GET de resultado não cai
  adiante para outra chamada.
- A projeção ready-only publica `confirmationHash` sobre a tupla que a pessoa vê:
  compras e destinos exibidos, cronogramas, totais econômicos, delta bancário e
  deltas de fatura, preservando a ordem dos arrays. Challenge e confirmação usam
  esse hash público. O digest privado do plano completo conserva a chave legada
  `proposalHash` apenas internamente e nunca integra proposta, confirmação ou recibo
  serializados para o navegador.

#### Gates de teste e de release

Os gates de código usam dados sintéticos e banco/cofre descartáveis, sem credencial
externa: normalização e respostas estruturadas, ausência de chamada ao provider,
adiar/retomar/continuar, replay e concorrência, isolamento de grants, projeção
ready-only diferencial, nenhum identificador interno e geometria/foco/hit-testing em
375/390/1280 px. Devem manter **100%** de exatidão de dinheiro/autorização,
**zero** escrita por inferência ou item não pronto e **zero** violação do payload
minimizado.

Isso prova o candidato, não a release. Ativação exige separadamente:

1. merge em `main`, CI e deploy SHA-strict verdes;
2. pré-requisitos do [runbook](../DEPLOY.md#release-da-entrada-csv-da-maria),
   inclusive bloqueio de produção para `ALLOW_TENANT_OVERRIDE=1`;
3. `AGENT_LLM_PROVIDER=gemini` explícito e credencial Gemini já provisionada no
   ambiente, sem ler, copiar ou publicar `.env`;
4. evidência **baseline × candidate** sanitizada, com provider/modelo/configuração,
   dataset e hashes, mais smoke real de ao menos uma interpretação livre;
5. fallback real por credencial ausente/rejeitada, timeout, quota e resposta inválida,
   sem perda da sessão nem falso sucesso;
6. QA da jornada CSV no tenant e imagem reais. Caminhos determinísticos, provider
   sintético, fixture, override de DI e `qa-local` não satisfazem esse gate.

#### Composição HTTP/DI privada — candidato local inativo P06/P07

O candidato local P06/P07 registra o adapter e o workflow existentes, sem nova
lógica financeira nem dependência do cofre. A barreira exige literalmente as
18 rotas abaixo, verificadas na baseline funcional
`3bb5c28b9129388944374e9291f3426ef226699d`; isso não declara merge, deploy,
ativação ou release. Os antigos caminhos genéricos `PATCH /:id/draft` e
`POST /:id/prepare` não integram essa superfície: a jornada guiada usa comandos
dedicados e a projeção ready-only descritos acima.

| Método | Caminho relativo a `/import-sessions` | Resposta                                |
| ------ | ------------------------------------- | --------------------------------------- |
| POST   | `/`                                   | Sessão; 201 na criação, 200 no replay   |
| GET    | `/`                                   | Página de resumos; 200                  |
| GET    | `/:id`                                | Sessão; 200                             |
| GET    | `/:id/result`                         | Resultado; 200                          |
| POST   | `/:id/cancel`                         | Sessão; 200                             |
| POST   | `/:id/declarations`                   | Recibo documental; 200                  |
| POST   | `/:id/resolutions`                    | Recibo documental; 200                  |
| POST   | `/:id/defer`                          | Recibo documental; 200                  |
| POST   | `/:id/reactivate`                     | Recibo documental; 200                  |
| POST   | `/:id/current-lot/prepare`            | Recibo documental; 200                  |
| POST   | `/:id/current-lot/continue`           | Recibo documental; 200                  |
| GET    | `/:id/current-lot`                    | Projeção ready-only; 200                |
| POST   | `/:id/interpretations`                | Candidato de interpretação; 200         |
| GET    | `/:id/observations`                   | Página de observações; 200              |
| GET    | `/:id/candidates`                     | Página de candidatos por `lineId`; 200  |
| POST   | `/:id/confirmation-challenge`         | Nonce e expiração; 200                  |
| POST   | `/:id/confirm`                        | Referência e estado da confirmação; 200 |
| POST   | `/:id/execute`                        | Recibo completo, sem wrapper; 200       |

Cada handler mantém a autorização de projeto no serviço; os 12 mutantes
exigem admissão UI, os seis GETs não. Somente o controller existente pode
emitir grants financeiras, após validar id e corpo com os três parsers estritos
do workflow e usando request/auth originais. CHALLENGE vincula sessão, revisão
e `confirmationHash`; CONFIRM acrescenta `financialRequestId`; EXECUTE vincula
sessão e `financialRequestId`. O nonce nunca integra o scope da grant nem o modelo.

As duas factories privadas compõem o port com `ExpenseService`,
`ConciliacaoService` e relógio reais, e o workflow com `PrismaService`, relógio,
capability, verificador runtime existente e port. Não há novo token de
autoridade, provider vazio ou export Nest. A constante de escrita continua OFF,
sem override de ambiente; `actions` continua anunciando somente recuperação
e cancelamento. Não antecipar o gate financeiro: admissão UI, reautorização,
ACL e replay exato preservam a precedência existente. OFF impede novas mutações
documentais/financeiras, não a reserva SQLite no-op nem a telemetria HTTP.

O wiring local não comprova QA HTTP independente e não entrega upload, extração,
Maria contextual, UI montada, durabilidade Linux ou ativação. Para este rollout,
o limite é normativo: somente zero ou um destino REFORMA integral, sempre além
da fonte PESSOAL do cartão; não há promessa de quatro destinos executáveis.

O cliente FE candidato consome os handlers guiados registrados de declaração,
resolução, adiamento, reativação, preparação e leitura ready-only, além de
observações e candidatos. Mutações usam o header UI; as páginas têm leitura
estrita, cursor opaco e candidatos vinculados ao `lineId` obrigatório. Observações
aceitam somente `cursor`; não há filtro por anexo. Não há retry automático nem
inferência de pesquisa completa pelo fim da paginação. Essa composição continua
inativa e seus testes não comprovam ativação, deploy ou release da jornada Maria.

#### Contrato público conversacional P08 — checkpoint prospectivo inativo

O checkpoint de tipos compartilhados prevê somente `ImportFocusV1`,
`ImportChatTurnV1`, `ImportScopeReviewV1`, `ImportClarificationReason`,
`ImportChatErrorCode` e `ImportChatOutcomeV1`, exportados pelo domínio.
Este registro prospectivo antecede sua implementação. Os tipos reutilizam os
identificadores, revisões, perguntas e erros de sessão existentes; não constituem
validação de JSON, prova de acesso, admissão de escrita ou confirmação financeira.
Os contratos de tipos devem ser compilados pelo comando de testes do domínio,
não apenas apagados pelo transpiler de testes.

Esta fatia não conecta DTO, transporte contextual, bridge, tools ou UI. Projeções
para o modelo e bindings de autoridade permanecem internos ao futuro backend.
O produtor de actions da visão completa e a integração conversacional ainda
dependem de checkpoints próprios; recuperação, consentimentos, retenção, regras
monetárias e escrita OFF permanecem inalterados. Tipos compilados não comprovam
o fluxo em runtime nem autorizam sua ativação.

Nota factual P08 FE: há um consumidor conversacional candidato, **inativo e
não montado por callers públicos**, com leitura estrita do wire, resposta literal
focada, revisão explícita de alcance e recuperação por GET sem replay automático.
O modo genérico continua sendo o padrão. Revisão/execução reutilizam o card e o
hook existentes; texto/voz não confirmam finanças. Fixtures e browser offline
verificam somente o consumidor, não ACL, admissão, produtor de actions, anexos
ou jornada M1 real. O runtime contextual e a ativação continuam pendentes.

Contrato aprovado para a composição contextual P08, **ainda em implementação
inativa**: a presença de `importTurn`, inclusive inválido, impede fallback
genérico. O guard registra somente admissão pendente sobre o request/JWT
original; o handler ativa após guards/pipes e revoga em `finally`. O loop inteiro
usa a allowlist contextual e o provider estrito, sem emissão financeira, prosa
de sucesso como acknowledgment ou dispensa de quota. Recuperação direta continua
disponível sob sua autorização normal.

A ponte privada terá somente os exports Nest `ImportChatGuard` e
`ImportChatBridge`. Edit/prepare compartilharão o workflow existente, com a
mesma admissão viva antes de cada tentativa, após reserva, imediatamente antes
da mutação e antes do retorno transacional. O guard síncrono já existente no
writer não cancela SQL emitido nem desfaz commit concluído. Actions de workflow
serão produzidas pelo servidor somente na visão completa autorizada; summaries,
recuperação, `UPLOAD` e o padrão de escritas OFF permanecem preservados.

Essa composição contextual também é baseline anterior à #716. A UI guiada final
não chama edit/prepare pela ponte ou por `/agent/chat`: usa declaração/resolução,
adiamento/reativação e preparação do lote atual por comandos documentais
dedicados. A única chamada opcional ao provider é a interpretação read-only que
retorna candidato, sem tool operacional.

Esta composição não materializa documentos, não monta UI nem ativa o piloto.
`ATTACHED` não prova extração completa. Declarações sobre fatos originalmente
incompletos não ganham nova persistência ou uso financeiro por este contrato;
edições do draft já suportadas não substituem identidade documental.

#### Preparação e evidência privadas — checkpoint inativo M1

O adapter e o coordenador compartilham um único cálculo puro de proposta, continuidade
AC18 e orçamento. Não há nova autorização, endpoint, produtor de extração ou ativação
neste checkpoint. Os fatos recebidos precisam cobrir integralmente o scope da mãe:
observações, referências e artefatos devem ter identidades coerentes de tenant/âncora,
sem completar ou reduzir silenciosamente o scope.

- PREPARE publica a revisão seguinte; uma repreparação confirmada usa a revisão aprovada,
  não a revisão corrente da sessão. Preparar não renova a retenção.
- O hash compromete a proposta completa sem seu próprio hash e o plano privado:
  observações deferidas com `claimVersion`, referências ordenadas com geração de upload,
  identidade/hash do artefato, estado/fase semântica e limite de escritas.
  RAW_READY/ANALYZING compartilham NOT_EXTRACTED; EXTRACTED, FAILED e UNAVAILABLE
  são distintos. Relógio técnico, timestamps de lease e geração de parsing não entram.
- A continuidade preserva observações sem linha editável e referências FAILED pendentes.
  Transfere somente referências necessárias aos deferidos; copia apenas linhas/perguntas
  remanescentes inteiras e válidas, com seleção vazia e prazo herdado. Nunca reescreve uma
  pergunta para ajustar seu alcance. Reserva cleanup de todos os artefatos distintos da
  mãe, mesmo sem lease atual; a futura escrita exige `leaseSessionId=mãe`.
- Referências RESERVED/UPLOADED impedem preparação concluída. Hash/custo não autorizam
  efeitos financeiros nem substituem reautorização, pesquisa completa ou CAS.

O limite conservador de escritas é derivado do plano, nunca informado pelo caller:
`S + 4T + P + N + (S + T) + C + K + R + L + 3`, onde S são fontes CREATE,
T seus destinos, P fontes com destino, N ocorrências das fontes e destinos,
C observações selecionadas distintas, K a existência de sucessora (0/1),
R referências transferidas e L artefatos distintos com cleanup potencial.
O termo final reserva writer, audit e UPDATE único de recibo/APPLIED.
Gêmeas com S=2/T=2/P=2/N=40/C=2/K=0/R=0/L=1 reservam 62;
um anexo adicional deferido, com K=1/R=1/L=2, leva a 65.
São limites aprovados, não contagens de execução. O teto é 512; ultrapassá-lo
retorna o erro existente com `WRITE_BUDGET_EXCEEDED`. Permanecem os limites de
dez linhas selecionadas, vinte observações por linha, 24 parcelas por compra,
240 CFEs expandidos e 5.000 visitas globais de pesquisa. A instrumentação futura
deve provar que as escritas reais não excedem a reserva.

A evidência original tem envelope privado versionado com `reference`, `text`,
`amountMeaning`, `amountCents`, `installmentCount`, `installmentIndex`, `dataCompra`
e `identity` (`merchant`, `externalId`, `fitId`, `ordinal`, `fileContentHash`).
Todos os campos são obrigatórios, sem chaves extras; ausência de um fato usa `null`,
não um default. Centavos assinados, zero, UNKNOWN e parcelas acima de 24 continuam
sendo fatos documentais, não compras executáveis. Datas/textos respeitam os limites
públicos; o ordinal pertence à extração completa congelada. `fileContentHash` usa os
32 hex minúsculos do helper canônico, não o SHA-256 de 64 hex do artefato.
DTO público ou `{"version":1}` não são evidência válida.

A projeção exige sessão/tenant/âncora, scope e referência ATTACHED coerentes antes
de interpretar conteúdo. IDs e referência pública vêm do banco; a referência no JSON
deve coincidir. Texto/valores vêm apenas da evidência, nunca do draft editável.
Conteúdo incompatível gera corrupção sanitizada, sem eco documental. Os futuros
produtores e consumidores devem usar esse mesmo parser.

No adapter inativo M1, o mês do primeiro vencimento explícito prevalece sobre
a inferência de fechamento, tanto antes quanto depois do mês inferido. A data
não pode anteceder a compra; fechamento e vencimento do cartão continuam
obrigatórios. O dia deve corresponder ao vencimento do cartão, com o clamp de
mês curto do helper canônico, também usado nas ocorrências seguintes. Isso não
ativa o fluxo nem dispensa os gates de integração.

#### Claims e vínculo privado A→W — emenda inativa M1

O writer SQLite e a reautorização atual precedem os efeitos. Na mesma transação,
o coordenador relê sessão/ACL e todas as observações selecionadas, suas identidades,
versões e tuplas de claim integralmente vazias; reprepara e compara proposta,
preflight e limites. O adapter então aplica as fontes/destinos/CFEs usando essa
mesma transação. **O binding CAS completo ocorre depois de existirem as entidades
financeiras**, não antes: as FKs imediatas precisam encontrá-las.

Há um único UPDATE por observação: o predicado inclui id, tenant, âncora,
artefato, referência, `claimVersion` esperado e todos os campos de claim nulos.
A atualização incrementa a versão e preenche conjuntamente projeto/Expense/índice,
sessão, recibo discriminado SESSION e `claimedAt`; `canonicalReceiptId` continua
nulo neste caminho CARD. Exige `count === 1`. Não há reserva preliminar nem segundo
UPDATE: o orçamento continua **C, não 2C**, sem mudança de FK ou schema.

Os itens retornados pelo adapter são conferidos por `lineId`, nunca por posição:
cobertura exata, sem ausentes/extras/duplicatas, resultado compatível e fonte KEEP
igual à aprovada. O vínculo aponta para a fonte na âncora autorizada, não para um
destino. Qualquer falha após os efeitos lança erro e reverte integralmente finanças,
claims, continuidade, transferências, leases, audit e recibo. Não retorna uma
transição que comite REVIEW_REQUIRED com efeitos. Somente drift anterior aos
efeitos pode persistir a transição discriminada já aprovada. Continuidade/cleanup,
audit e UPDATE final de recibo/APPLIED continuam dentro da mesma transação.

Cada `SelectedImportObservation` privado passa a exigir `lineId` e
`canonicalIndex: number | null`. `null` representa a compra inteira; zero é a
primeira ocorrência **local** da agenda fonte. O produtor A comprova a semântica:
um total sem indicação de ocorrência pode usar null; uma ocorrência exige
correspondência inequívoca. KEEP copia o helper canônico: 2/10 na agenda completa
tem índice 1, mas numa agenda iniciada em 2/10 tem índice 0. Não inferir
`printedIndex - 1`, não usar null para contornar NEEDS_INPUT nem ampliar KEEP.

A fábrica exige linhas da proposta iguais às selecionadas, observações exatamente
uma vez nas respectivas linhas do draft locked, sem extras/ausentes/deferidas,
identidades/versões válidas e índice obrigatório, nulo ou inteiro seguro dentro
da agenda **fonte**, correspondente ao índice canônico. Observações distintas
podem compartilhar o mesmo índice. Clone e deep-freeze incluem os novos campos.
Essa validação estrutural não substitui a prova documental do produtor.

A lista ordenada por id `{id,lineId,canonicalIndex,claimVersion}` integra somente
o **preflight privado** do adapter e sua repreparação. H8, proposta e recibo
públicos não mudam. O checkpoint de tipos/guard não prova execução financeira:
rollback real, concorrência e a instrumentação de 188 claims como 188 escritas
no limite global de 512 continuam sendo gates de integração, sem ativação.

### Extração documental local X1-L1 — inativa

O entrypoint privado `extractCardStatementDocument`, em
[`statement-document.ts`](../apps/api/src/credit-card/parsers/statement-document.ts),
extrai apenas CSV Nubank/Itaú com cabeçalho reconhecido e OFX no contexto solicitado
`CARD_INVOICE`. CSV sem prova documental permanece `UNKNOWN`; contexto não prova
tipo. OFX inequivocamente bancário e estruturas não suportadas são recusados.
As capturas anteriores aos filtros são compartilhadas com os normalizadores
legados, sem reconstruir fatos a partir de `ParseResult`.

O DTO `card-local-text-v1` preserva ocorrências incompletas, referências físicas,
campos crus (inclusive vazio e espaços), zero, créditos e parcela impressa.
Não multiplica cobrança de parcela, inventa data/ano, gera `externalId` ou agenda,
nem promove `UNKNOWN` a total da compra. Os ordinais usam todas as identidades
conhecidas antes de qualquer seleção. `invoiceDueMonth` e `cycle` saem `null`
nesta fatia. Merchant acima do limite normalizado fica nulo com diagnóstico;
o texto cru não é truncado.

`validateDocumentExtraction` exige schema fechado, referências/ordens/métricas
coerentes e devolve cópia profundamente congelada. A entrada continua limitada
a 10 MiB e 1.000 ocorrências. **Novo mapeamento privado X1-L1:** o DTO completo
também tem teto de 10.485.760 bytes em JSON compacto UTF-8, reutilizando
`IMPORT_SESSION_LIMITS.bytesPerFile`. Não há teto individual dos quatro campos
`raw`; chaves, escapes, fatos normalizados, repetições e diagnósticos contam no
envelope. A contagem incremental ocorre antes de clonar/congelar o resultado,
sem executar getters ou `toJSON`. Excesso gera `LIMIT_EXCEEDED`, nunca resultado
parcial; shape inválida gera `INVALID_RESULT`. Esse teto não é o de 1 MiB dos
drafts/propostas, nem prova de isolamento de RSS.

**Sem caller, rota, provider registrado ou ativação.** A API pura não autoriza
executá-la no event loop de produção. Cofre/executor, consentimento, isolamento e
gates de runtime continuam separados. PDF, XLS/XLSX, BANK, Carteira, comprovantes
e OCR permanecem fora deste checkpoint, não removidos do programa. Regressões
legadas e contrato próprio estão em
[`statement-document.spec.ts`](../apps/api/src/credit-card/parsers/statement-document.spec.ts).

### Extração binária documental X2 — candidato local inativo

O entrypoint privado assíncrono `extractCardStatementBinaryDocument`, em
[`statement-document.ts`](../apps/api/src/credit-card/parsers/statement-document.ts),
é separado do X1 síncrono. Aceita somente PDF textual de cartão e planilhas
XLS BIFF8/XLSX ZIP com uma única aba, no contexto `CARD_INVOICE`. Aba extra,
inclusive oculta ou vazia, exige reexportação de uma única aba. PDF protegido
exige uma cópia desbloqueada localmente; este helper não recebe senha. PDF
sem camada textual, página ilegível e estrutura não suportada recusam o
documento inteiro, sem OCR, truncamento ou resultado parcial.

As capturas compartilhadas precedem os filtros e heurísticas legados. O DTO
preserva posições físicas, gêmeos, lacunas, zero, créditos e fatos incompletos.
Datas sem ano completo ficam desconhecidas; seriais Excel respeitam 1900/1904,
sem conversão por timezone local. Ciclos vêm somente do bloco explícito da
fatura; entrar em futuro ou seção desconhecida limpa a âncora anterior.
Cobrança de parcela não vira total multiplicado. O X1 e os resultados legados
mantêm seus contratos, inclusive peculiaridades já caracterizadas.

Os tetos de aceitação são 10 MiB de entrada e do DTO JSON compacto UTF-8,
1.000 ocorrências, 30 páginas PDF e 10 MiB de texto decodificado acumulado.
Planilhas percorrem células reais esparsas, com no máximo 4.096 linhas e
256 colunas populadas. O inventário **após** leitura da biblioteca limita
1.000 membros e 50 MiB expandidos: OLE conta streams físicos, inclusive seu
sentinel; ZIP exclui apenas a raiz e o sentinel sintéticos exatos validados.
Diretórios e arquivos vazios contam; raiz estrutural e padding não. Inventário
ausente/incoerente falha com `INVALID_RESULT`, excesso com `LIMIT_EXCEEDED`.

**Sem caller, rota, provider ou ativação.** SheetJS já descomprime antes da
contagem; pdf-parse não oferece orçamento interrompível de CPU/alocação.
Essas verificações não provam proteção pré-alocação, inventário bruto de todo
contêiner malformado nem completude visual de páginas híbridas texto/imagem.
A validação local usa fixtures sintéticos controlados; o gate coeso com QA
independente e a admissão de arquivos arbitrários continuam separados.
Não entrega BANK, recibos, todos os formatos do programa, composição X3/P08
nem decisões financeiras sobre fatos declarados pelo usuário.

### Executor nativo X2-N1 — fontes locais inativas

O candidato separado usa um launcher C/libc+libseccomp, sem setuid, em
`/usr/local/libexec/reformaflow-x2`, e runner/worker privados. Nao ha caller,
provider, rota, flag de ativacao ou integracao X3. Fontes, testes TS com peer
sintetico e receita de build nao comprovam isolamento Linux.

O protocolo `X2N1` tem header big-endian de 12 bytes. FD0 leva START/DOCUMENT,
FD1 somente RESULT e FD3 e controle duplex independente; FD2 e `/dev/null`.
HELLO/START/ARMED/DOCUMENT/RESULT/DONE/ERROR/CANCEL/WORKER_INIT/WORKER_READY
tem kinds 1..10. ERROR tem seis u16 fechados; CANCEL leva nonce e causa.
O worker recebe somente INIT/perfil, documento e EOF: nenhuma identidade
externa, configuracao operacional ou descritor de controle.

O runner copia e confere SHA-256 antes de spawn e mede 60 segundos monotonicos
desde a entrada da funcao. Nao ha retry ou fallback irrestrito. Sucesso exige
DTO/perfil validos, DONE, EOFs, exit zero e aceite antes do prazo. `result`
pode falhar antes do cleanup; `settled` nao declara CLEAN sem confirmacao
nativa coerente. START enfileirado nao prova que o supervisor o aceitou.

A configuracao operacional e explicita, sem defaults de memoria/CPU/PIDs.
Memory v1 e memsw recebem o mesmo M, nesta ordem, com releitura; isso limita
RAM+swap e nao e prova isolada de zero swap. CPU usa quota/período e orçamento
agregado monitorado, sem promessa de overshoot zero. O binding usa namespaces
PID/mount/network, pidfd, barreira pre-exec, privdrop, PDEATHSIG e seccomp
default-deny; sua compatibilidade real com Node/threads continua sem prova.

O registro privado fica em `/data/reformaflow-x2` (0700, arquivos 0600),
fora da raiz do worker. Bootstrap e autorizacao operacional sao separados:
o helper nao cria uma instalacao ausente. Dois slots fisicos e nonce-CAS
nao substituem fencing/ACL/transacao de publicacao de X3. Registro perdido,
identidade ambigua ou cleanup inconclusivo nao liberam capacidade.

O primeiro runtime nao tem scratch gravavel. Node, loader, bibliotecas,
modulos e assets devem pertencer a uma closure somente leitura; nunca se
montam app completo, cofre, banco, home ou procfs do host. O manifesto/seal
e a selecao de canvas GNU/fontes/WASM ainda exigem qualificacao da imagem.

**Gates pendentes:** compilacao/linkagem Linux real, QA independente de
protocolo, qualificacao da closure, prova funcional v1 e bootstrap/perfil
operacional aprovado. Perfil inicial de build proposto: Linux/amd64 glibc,
Node 20.20.2; nao afirma arquitetura Fly. Nenhum valor produtivo foi aprovado.

A receita fixa `npm@11.6.2` no estagio comum `base`, com checagem de versao
e falha explicita antes dos dois `npm ci` (`builder` e `runtime-base`).
`packageManager` sozinho nao seleciona a CLI; esse pin ainda nao foi executado.

O target test-only `x2-runtime-smoke` e o harness
[`x2-runtime-smoke.cjs`](../apps/api/native/x2-runtime-smoke.cjs) estao
implementados, **nao executados no Linux**. O comando interno e
`/bin/node --require /test/scripts/test-db-env.cjs /test/x2-runtime-smoke.cjs`.
SRE controla a futura execucao sem rede/mounts, read-only, sequencial ao build:
60 s/worker, 210 s/container, janela total 30 min, 2 CPU, 4 GiB de memoria e
memory+swap de 4 GiB. Sao limites experimentais, nao M/V1 ou prova de isolamento.
Os tres goldens geram registros limitados; cleanup incerto deixa os demais
`NOT_RUN`. O target nao contem launcher nem substitui a imagem API.

#### Validacao TS local, sem isolamento

Os specs proprios sao `statement-document.runner.unit.spec.ts` e
`statement-document.worker.spec.ts`, descobertos pelo Jest canonico da API.
O peer do runner nao inicia o launcher. O worker exercita fixtures sinteticas
PDF/XLS/XLSX; o processo Node do PDF usa `ts-node/register` da propria arvore,
o guard `scripts/test-db-env.cjs` e configuracao TS explicita. Nao depende de
`dist` preexistente, nao inicia Nest e nao testa cgroups, namespaces ou seccomp.
Os testes rejeitam ordem/duplicacao no header antes de alocar o corpo e
exigem um unico terminal mesmo quando input e parser falham concorrentemente.
EOF de controle sem terminal, controle truncado e erro no canal sao falhas
de protocolo, nao prova de cleanup. RESULT truncado e classificado no
desfecho: EOF em FD1 nao antecipa nem apaga ERROR ainda drenando em FD3.
DONE/exit continuam insuficientes antes da drenagem completa.

O spec independente `statement-document.runner.contract.spec.ts` foi
transportado byte-exato apos mediacao; seu transporte nao equivale a GREEN.
Divergencias de instrumento/semantica voltam para mediacao, sem alterar a QA
para passar, trocar o relogio produtivo ou presumir tamanho de pagina.

Na raiz, com dependencias proprias, Prisma gerado do schema proprio e dominio
reconstruido limpo, a verificacao de tipos e
`node node_modules/typescript/bin/tsc -p apps/api/tsconfig.json --noEmit`;
`npm --workspace @reformaflow/api run build` confere emissao TS, nao compila C.
Os specs usam o guard mesmo no perfil unitario privado sem `globalSetup`
migrador: esse perfil e valido somente porque nao usam cliente/servico/DB,
com `TEST_DATABASE_URL` explicito para um alvo descartavel proprio nao usado.
Nao se remove o guard nem se altera o runner canonico/CI por isso. O Jest
canonico conserva seu preparo de banco descartavel quando usado normalmente.
As receitas e recibos locais registram exatamente o perfil usado.

O gate Linux precisa de ambiente/profile CI separado e mediado: testes
de mecanismo nao podem virar skips silenciosos ou PASS de stubs no Mac.
Node local diferente do Node 20.20.2 proposto nao qualifica a imagem final.

#### Guarda aritmetica C11, sem integracao Linux

A guarda de memoria compartilhada fica em
[`x2-memory-limit.h`](../apps/api/native/x2-memory-limit.h); `load_config`
lhe passa a pagina real retornada por `sysconf(_SC_PAGESIZE)`. Para o perfil
64-bit v1, `U = INT64_MAX - (INT64_MAX % P)` e uma barreira reservada:
exigir `P > 0`, `0 < M < U` e `M % P == 0`. Nao e cota produtiva nova,
e readback igual a M nao permite admitir U.

[`x2-memory-limit.spec.c`](../apps/api/native/x2-memory-limit.spec.c)
inclui a mesma funcao produtiva, com oraculos literais para P=4096/65536.
A unidade acumula falhas e exercita todos os casos. Os valores gigantes
sao apenas inteiros; nenhum cgroup e escrito, nenhuma memoria desse
tamanho e alocada e o readback da fixture e sintetico.

Invocacao explicita na raiz, com `R` apontando para um diretorio privado
novo de recibos e o compilador local previamente autorizado:

```sh
/usr/bin/clang -std=c11 -O2 -Wall -Wextra -Werror -pedantic \
  -I apps/api/native apps/api/native/x2-memory-limit.spec.c \
  -o "$R/x2-memory-limit-test"
chmod 0700 "$R/x2-memory-limit-test"
"$R/x2-memory-limit-test"
```

Jest e CI atuais **nao descobrem nem executam** essa unidade C. Nao ha
compilacao do launcher por esse comando, nem headers Linux/libseccomp.
RED/GREEN/mutante no Mac verificam somente a guarda aritmetica compartilhada,
nao a integracao C executada, ABI, controller, namespace ou admissao real.
A ligacao com `load_config` permanece verificacao de fonte ate o gate Linux.

#### Artefatos e registro privado do candidato

A receita esta em [`native/Makefile`](../apps/api/native/Makefile), com a lista
finita [`x2-runtime-files.txt`](../apps/api/native/x2-runtime-files.txt).
`make -C apps/api/native build` compila somente C; `inspect` acrescenta
readelf/hash, sem executar o binario. `stage IMAGE_ROOT=<raiz-da-imagem>
STAGE=<saida-nova>` exige raiz explicitamente selecionada, Python3/readelf
existentes e ownership root autorizado. Nao instala dependencias.
O Dockerfile declara estagios separados de build e empacotamento estatico;
nao executa o launcher nem provisiona o registro.

O manifesto contem `sha256  /caminho-logico` por arquivo. `.x2-seal` e o
SHA-256 do manifesto, seguido de LF. O binding compara a identidade esperada
com esse stamp root-owned e verifica ownership/nao-escrita da arvore; nao
implementa SHA-256 em C. A qualificacao externa deve conferir o manifesto
contra os arquivos da imagem. Isso nao autentica software root comprometido.
DSOs sao enumerados estaticamente por readelf; `dlopen`, fontes e comportamento
do runtime continuam gates independentes. Nenhum shell/ldd e copiado.

O layout operacional abaixo e **especificacao para bootstrap futuro**, nao
instrucao para executar bootstrap nesta entrega:

- `admission.lock`: arquivo regular exclusivo 0600; flock por admissao/CAS.
- `installation`: 61 bytes packed; magic `X2INS1` + dois bytes zero,
  identidade aleatoria de 16 bytes e boot UUID ASCII de 36 bytes + NUL.
- `ready`: os mesmos 16 bytes de identidade, publicado por ultimo.
- `slot-0` e `slot-1`: 324 bytes packed little-endian, definidos por
  `struct record` no C; nenhuma serializacao de pidfd.

| Offset | Campo                                                              |
| -----: | ------------------------------------------------------------------ |
|      0 | Magic `X2SLT1` + dois bytes zero (8 bytes)                         |
|      8 | slot, state, profile, owner_pid, init_pid: cinco u32               |
|     28 | owner_birth, init_birth, pid_namespace: tres u64                   |
|     52 | boot UUID + NUL: 37 bytes                                          |
|     89 | nonce: 16 bytes                                                    |
|    105 | tenantKey: 32 bytes                                                |
|    137 | seal hex + NUL: 65 bytes                                           |
|    202 | memory, quota, period, budget, poll_ms, pids, cleanup_ms: sete u64 |
|    258 | uid, gid: dois u32                                                 |
|    266 | devices[3], inodes[3]: seis u64                                    |
|    314 | primary, resource, document_code, reason, cleanup: cinco u16       |

Estados privados: CLEAN=0, INTENT=1, OWNED=2, READY=3, RUNNING=4,
TERMINATING=5, QUARANTINE=6. Slot inicial: magic/slot/boot, cleanup=1 e
demais campos zero. Grupos derivam exclusivamente de `reformaflow-x2-`
mais nonce hex. Atualizacao usa arquivo temporario exclusivo, fsync,
rename e fsync do diretorio sob lock, comparando o registro anterior
inteiro. Corrupcao/identidade insuficiente nao autoriza adocao destrutiva.
Fencing financeiro e geracoes de X3 nao fazem parte desse formato.

### Adoção documental X3 — contrato local inativo

Nota de composição RAW local/inativa: o caller privado conecta RAW_READY ao
runner X2 existente e publica a extração congelada junto da materialização X3.
O upload continua sem parsing. A configuração nativa registrada é literalmente
null, writes permanece OFF, novos formatos permanecem vazios e a seleção pública
de canAnalyze continua restrita a EXTRACTED. Não há nova interface pública.

Admissão local e lease A pertencem à tentativa até a fase final do caller e
ausência/cleanup nativo comprovado; CLEAN sozinho não libera durante publicação.
QUARANTINED/UNCONFIRMED retêm a ocupação, sem TTL ou reparo por GET. Cancelamento,
reaper e continuidade AC18 capturam tuplas na transação vencedora e sinalizam
somente essas gerações após commit. AC18 acompanha execute, que chama continuation;
confirm não recebe efeitos de continuação. STOP impede nova tentativa/cleanup SQL.

Os testes próprios usam PrismaService/cofre reais e runner real com subprocessos
sintéticos somente na fronteira de spawn. Essa prova não qualifica launcher,
cgroups, helpers instalados ou Linux. A allowlist de composição acrescenta os JS
do domínio B3 demonstrados no build local; seal/imagem e qualificação operacional
continuam gates externos, sem ativação.

O candidato X3 adota fatos EXTRACTED já congelados; não executa RAW_READY ou
ANALYZING, não chama parser no HTTP e não entrega o primeiro upload analisável.
O comando documental UI é `POST /import-sessions/:id/attachments/:attachmentId/analyze`,
com corpo exato `{expectedRevision}`. Usa auth original, consentimento persistido,
Origin/header e grant documental `ANALYZE_ATTACHMENT`, sem autoridade financeira.

Reserva inclui referências e `scope.pendingAttachmentIds` atomicamente. Publicação
converge observações sem sobrescrever evidências aplicadas e remove somente a
pendência concluída, junto do draft e da revisão. Isso inclui extração válida vazia
ou já reivindicada. Replay não reabre pendências, muda IDs ou renova retenção.
Cancelamento, edição, ACL, prazo, transferência e gerações invalidam publicação
tardia. Limites do consumidor rejeitam o documento inteiro, sem truncamento.

Cada anexo da visão completa exige `materializedInSession` e `canAnalyze`, além
dos quatro campos existentes. A action `ANALYZE` existe somente quando alguma
referência é elegível. OFF preserva conclusão e elimina elegibilidade. GET/reload
não analisam, reparam ou fazem backfill. Ausência de pendência em dado anterior
ao protocolo não prova conclusão; cobertura ou tratamento explícito é gate de release.

A visão completa exige `reviewBlockers: Array<{lineId, code}>`, com os códigos
`ORIGINAL_IDENTITY_INCOMPLETE` e `ORIGINAL_OCCURRENCE_INCOMPLETE`. Não integra
PATCH/draft, summary ou novo ledger. Somente originais autorizados determinam
o aviso. Identidade exige data, valor, merchant e ordinal originais conhecidos.
Ocorrência distingue CREATE, KEEP e UNRESOLVED: compra inteira CREATE permanece
admitida; KEEP unitário com quantidade 1 e índice nulo não recebe bloqueio genérico.
UNRESOLVED exige impedimento documental em ambas as alternativas, agregado sobre
todas as observações. Valores divergentes, agenda/candidato/CFE ausentes e vínculos
ambíguos continuam nos checks canônicos, não viram fatos ausentes.

Avisos independem da seleção; somente os selecionados suprimem PREPARE. Terminais
APPLIED/CANCELLED/EXPIRED exibem lista vazia, sem certificar resolução factual.
Lista vazia também não comprova compatibilidade, pesquisa completa ou READY.
Correções do draft não substituem originais; o uso de declarações para busca e
vínculo continua pendente da decisão B3.

O ciclo privado por observação restringe a preparação existente pelo índice
canônico vinculado, nunca pelo índice impresso menos um. Ciclo desconhecido fica
nulo; divergência invalida a prévia, não reescreve agenda. Contexto documental entra
no hash/preflight e é revalidado antes dos efeitos. Nenhum campo novo na observação
pública, claim adicional, matcher ou cálculo financeiro é autorizado.

Este contrato antecede implementação e testes pareados BE/FE/QA. Não comprova
extração integrada, executor seguro, runtime público, Linux/Fly ou ativação.

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
