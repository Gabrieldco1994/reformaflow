# Maria CSV — contrato delimitado do servidor

**Estado em 2026-10-11: comportamento presente na árvore candidata atual; merge,
ativação, produção, jornadas Linux/Journey e release não verificados.** `881e9b5c`
foi uma base histórica de implementação, não o candidato final atual. Antes de
merge ou release, o SHA exato da composição final **MUST** ser atestado por checks
externos correspondentes da PR #718; enquanto eles não corresponderem ao SHA
final, este documento não o atesta nem fixa um SHA final futuro ou circular. O
documento define o contrato do candidato, não capacidades implantadas.
O [ledger #711](https://github.com/Gabrieldco1994/reformaflow/issues/711) é a referência de
aceite; o contrato prospectivo M1/M2 já aprovado não comprova entrega funcional.

**Integração local em 2026-10-10:** transplante feature-only sobre
`f814819231e98ada11cda9a6972401ad0a01673d` (#714), com donor
`7933ca9f` e correção PDF estreita `ad9acfa9`. O main continua dono dos
cronogramas, import/restore legado, liquidação, banco e cálculos canônicos.
Os helpers de identidade Maria ficam em `imports/import-session/card-import-identity.ts`;
a API IMPORT/RESTORE legada não é substituída. Nenhuma ativação em produção.
Os 69 migrations main são preservados; os três migrations de importação são
aditivos. A prova de upgrade local usa o mesmo banco main populado e verifica
IDs, centavos, cronogramas documentais, trilhas de fatura e `foreign_key_check`.

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
  Gramática numérica de data das linhas: `D/M/AAAA` (dia/mês com 1–2 dígitos,
  ano com 4) ou `AAAA-MM-DD` (4–2–2). `D/M` sem ano permanece evidência
  `UNKNOWN_DATE`, sem ano inventado; datas nessa gramática mas impossíveis no
  calendário permanecem evidência `INVALID_CALENDAR_DATE`. Linha não capturada que
  começa com token numérico de data (grupos de dígitos separados por `/`, `-` ou
  `.`), seguido de descrição, rejeita o arquivo inteiro com
  `DOCUMENT_UNREADABLE`, nunca publica só as demais ocorrências. Isso inclui ano
  curto/longo, separadores alternativos/mistos e tokens malformados. A detecção não
  interpreta essas datas nem amplia identidade; não é um parser de layouts
  arbitrários. A cerca independe de valor legível: valor ausente ou ilegível não
  permite descartar a linha. Cabeçalhos/totais com data interna não são
  classificados indiscriminadamente como transações. Após data não suportada,
  apenas o rótulo completo `Vencimento` (sem conteúdo adicional) é excluído como
  cabeçalho documental; não há exclusão por prefixo de descrição.

- Somente **CSV suportado ou PDF textual sem raster de compras de cartão** na jornada guiada
  da Maria. Ambos passam pela mesma seleção local e pelo mesmo consentimento explícito antes do
  upload privado. Banco/Carteira, imagens, OCR, outros formatos e actions R2 não são parte desta
  entrega nem requisitos antecipados.
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
- #709/#710 continuam donos dos contratos/fundação e #716 da UX guiada. A sessão ativa é
  manual/determinística e não depende de qualificação por modelo.
  Esta entrega não fecha automaticamente esses ledgers, #711/R2, H1–H5 ou todo E5.

### Consentimentos, privacidade e autoridade

1. Selecionar CSV ou PDF textual é local e não persiste remotamente. **Analisar e guardar
   rascunho** informa finalidade, processamento e retenção; consentimento explícito autoriza
   apenas upload privado, sessão e preparação documental. Não usar storage público nem URL
   pública de anexo.
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

- O switch amplo `IMPORT_SESSION_WRITES_ENABLED` continua constante e **OFF**. A admissão
  delimitada de CSV/PDF usa a capacidade qualificada e suas revalidações próprias; não transforma
  o switch amplo em ON nem libera outros formatos/operações.
- O vault continua OFF por padrão e fail-closed: somente `IMPORT_VAULT_ENABLED=true`, junto de
  configuração e verificações físicas válidas, permite a inicialização privada. Ausência, valor
  diferente ou falha devolve o estado OFF; os controles focados não mudam esse comportamento.
  Este documento não afirma vault ON em produção.
- Verificação e ativação são mudanças separadas. PR/check de verificador não configura o vault
  nem autoriza operação. Depois de um deploy corrigido de `main` inteiramente verde, somente
  `platform-sre` autorizado pode executar a ativação operacional, com preflight e rollback do
  [runbook de startup do vault](../deploy/vault-startup/README.md#operational-activation-profile).
  O perfil ON não altera o switch amplo, que permanece constante de compilação em OFF. O preflight
  também exige `SIGTERM` explícito, dez segundos de margem além do drain e boot do rollback v749
  contra restore descartável do banco corrente pós-migrations; snapshot sem owner/restore test
  não fecha o gate.
- Consentimento e confirmação não são substituídos por habilitação. Contrato inativo/default-OFF
  não satisfaz a jornada funcional nem autoriza ativação em produção para obter evidência.
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
  Este documento não declara que a jornada Linux ou qualquer gate de release passou.

## Referência de implementação

A árvore candidata atual contém o subsistema import-session e os controles
determinísticos descritos aqui. Isso identifica o comportamento inspecionado, sem
afirmar merge, ativação, jornada Linux, release ou produção. Locatores principais:

- contrato wire: `packages/domain/src/import-session.ts` e
  `packages/domain/src/import-focused-answer.ts`;
- parsing/grant do PATCH focado:
  `apps/api/src/imports/import-session/import-session.focused-draft-answer.ts`;
- controller e writer:
  `apps/api/src/imports/import-session/import-session.controller.ts` e
  `apps/api/src/imports/import-session/import-session-workflow.service.ts`;
- controles/serialização:
  `apps/web/src/app/projects/[projectId]/maria/_components/ImportFocusedDraftQuestion.tsx` e
  `apps/web/src/app/projects/[projectId]/maria/_lib/import-focused-draft-transport.ts`;
- capability/vault:
  `apps/api/src/imports/import-session/import-session.disabled.ts`,
  `import-session.capability.ts` e `vault/vault.config.ts`.

Fontes complementares: [contrato Maria](maria-ia.md#importação-consentimentos-confirmação-e-retenção),
[jornada de importação](experiencia-importacao.md#importação-conversacional-na-maria),
[status do cockpit](estado-atual-cockpit-pessoal.md), [caixa](cockpit-caixa-real.md),
[faturas](visao-conta-faturas.md), [datas](politica-datas-timezone.md) e [índice](README.md).
O manual da experiência permanece sob ownership frontend; este documento não substitui sua
atualização e verificação na entrega funcional.

### Resposta documental nativa da UI (candidato, não prova de entrega)

`POST /import-sessions/:id/documentary-answer` recebe exatamente:

```ts
{
  version: 1;
  answerRequestId: string; // UUID
  expectedRevision: number;
  questionId: string; // oq_… da pergunta documental atual
  input: ImportDeclarationUiInputV1;
  answer: ImportDeclarationAnswerV1; // preview aceito pelo usuário
}
```

Retorna `ImportSessionViewV1`, sem outcome conversacional novo. Somente os campos
documentais existentes `dataCompra`, `merchant`, `amountMeaning`, `amountCents`,
`installmentCount` e `installmentIndex` são admitidos. Não autoriza destinos, seleção,
decisão, preparação, challenge, confirmação ou execução financeira.

`ImportAuthGuard`, `ImportUiGuard` e acesso de projeto resolvido pelo serviço protegem
a ação. O controller faz parsing estrito antes de emitir o grant opaco
`DOCUMENTARY_ANSWER`, vinculado ao ator, sessão, revisão, pergunta e hash canônico
do pedido. O writer reautoriza dentro da transação bloqueada e resolve a pergunta,
fingerprint, claim e contexto de significado atuais. Recalcula a declaração a partir
do input literal; preview divergente, chaves extras e valores inválidos são rejeitados.

O caminho reutiliza normalização/encoding e `recordImportDeclaration`, sem admissão
de chat fictícia nem substituição genérica de linhas. Para `VALUE`, `literalHash`
é SHA-256 do `input.text` original exato, não do literal codificado; não há coluna
extra de texto bruto. `answerRequestId` identifica a atestação no `turnId` existente.
Registros legados conservam seu hash do literal e comportamento anterior.

`UNKNOWN`/`REMOVE` conservam a declaração nula e a pergunta não resolvida; REMOVE
não vira exclusão. No-op não renova revisão/expiração. Concorrência na mesma revisão
tem no máximo uma edição vencedora; uma resposta perdida exige GET autorizado e
verificação do fato, nunca reaplicação cega. O teste
`apps/api/src/imports/import-session/documentary-answer.integration.spec.ts` cobre
esse caminho com guards, issuer e writer reais e sem compor provider/LLM.

#### Coalescência documental e perguntas legadas

Uma pergunta genérica de rascunho não pode eclipsar a pergunta `oq_…` correspondente.
O servidor coalesce somente tarefas de uma linha com uma observação, mesmo campo e
contexto compatível. Perguntas de decisão, destinos, primeiro vencimento e escopos
agrupados conservam sua autoridade e escopo existentes. Valor de parcela não cobre
pedido de total da compra; nunca multiplicar parcela por quantidade para inventar total.

Na edição documental, fatos atestados preenchem somente campos de rascunho ausentes
e compatíveis e retiram as tarefas cobertas na mesma transação. Um significado
`TOTAL_PURCHASE` explicitamente atestado permite usar o valor original exato já
extraído como total, sem nova interpretação. Correções independentes do rascunho
não são sobrescritas; nova declaração atualiza apenas valores herdados da anterior.
GET coalesce tarefas legadas sem renovar revisão/expiração nem escrever; prepare
persiste a mesma derivação dentro do writer antes de validar prontidão.

Coalescência não concede prontidão financeira. PDF com data sem ano mantém o
ordinal original nulo: a atestação de data não inventa identidade de busca. O gate
`SEARCH_IDENTITY_UNAVAILABLE` existente permanece; removê-lo exige decisão separada.
`documentary-coalescing.integration.spec.ts` cobre upload/análise CSV/PDF reais,
resposta nativa, recuperação legada e preparação sem nenhum efeito financeiro.

### Respostas focadas do rascunho sem modelo/tool

`PATCH /import-sessions/:id/draft` admite a variante focada exata
`ImportSessionFocusedDraftAnswerRequestV1`:

```ts
{
  version: 1;
  answerRequestId: string; // UUID
  expectedRevision: number;
  questionId: string; // pergunta genérica atual, não oq_…
  channel: "TEXT" | "VOICE"; // proveniência, nunca grant
  answer:
    | { field: "amountMeaning"; literal: string;
        value: "TOTAL_PURCHASE" | "INSTALLMENT_CHARGE" }
    | {
        field: "amountCents" | "installmentCount";
        literal: string;
        value: number;
      }
    | { field: "dataCompra" | "firstDueDate"; literal: string; value: string }
    | { field: "tipoDespesa"; value: ExpenseType }
    | { field: "categoriaMaoDeObra"; value: LaborCategory }
    | {
        field: "decision";
        value:
          | { kind: "CREATE"; acceptNaturalDuplicate: boolean }
          | { kind: "KEEP_EXISTING"; expenseId: string };
      }
    | {
        field: "targets";
        value:
          | { kind: "NO_TARGETS" }
          | {
              kind: "TARGET";
              projectId: string;
              roomId: string | null;
              amountCents: number;
              literal: string;
            };
      };
}
```

Essa variante representa escolhas humanas do rascunho, **não atestações do original**.
O controller valida conjunto exato de chaves, UUID, revisão, literal, valor, enums e IDs antes
de emitir o grant
`FOCUSED_DRAFT_ANSWER`, vinculado ao ator, sessão, revisão, pergunta e hash canônico.
No writer bloqueado, o serviço reautoriza o projeto proprietário e resolve a pergunta
genérica atual; constrói somente a mudança do campo permitido nas linhas do servidor.
Não aceita substituições de linhas nem seleção nesse envelope. Decisão e destino só entram
pelas variantes exatas acima: candidato `KEEP_EXISTING` precisa estar autorizado; destino é
`NO_TARGETS` explícito ou um único `TARGET` pelo valor integral da compra, nunca parcial,
múltiplo ou presumido. O projeto-alvo precisa ser REFORMA ativa do mesmo tenant, diferente do
projeto proprietário e autorizada; eventual cômodo precisa estar ativo e pertencer a ela.
Retorna `ImportSessionViewV1`.

O envelope legado do mesmo PATCH é **selection-only**: exige `questionId: null`,
`replaceLines: []` e apenas a lista `selectedLineIds` com IDs únicos e dentro do limite.
Qualquer tentativa de responder pergunta ou substituir linha por esse formato é rejeitada.

Dinheiro aceita um único token monetário não negativo; quantidade, um único inteiro positivo
dentro do limite; datas, somente `AAAA-MM-DD` ou `DD/MM/AAAA` completas e válidas;
significado, somente os literais inequívocos de total da compra ou valor da parcela.
Literais vazios, não NFC,
ambíguos, múltiplos ou divergentes do valor são rejeitados. Datas não recebem ano/ciclo
inferido nem ajuste automático. `MAO_DE_OBRA` não preenche categoria implicitamente.
No-op não renova revisão/expiração; resposta incerta exige GET autorizado, sem reaplicação cega.

`focused-draft-answer.integration.spec.ts` cobre guards/grants/writer/preparação reais,
OUTROS, literal estrito, decisões, destinos/sem destino, isolamento do campo, ACL,
falsificação/expiração, concorrência, no-op e ciclo incompatível, com zero efeitos
financeiros antes da confirmação.

A métrica de projeção de contexto elegível do corpus puro mede somente o resultado
e a projeção de contexto do avaliador. Ela não prova autenticação, isolamento de
tenant, passagem pela API nem revalidação do servidor. Essas garantias exigem
checks externos correspondentes da PR #718. Antes de merge ou release, esses
checks **MUST** atestar o SHA exato da composição final; o avaliador puro não
concede autorização nem substitui essa evidência.

Na UI, voz apenas fornece a transcrição ao parser determinístico e abre a mesma prévia manual.
Ela nunca envia automaticamente nem cai para LLM/tool. O usuário ainda precisa conferir e
guardar. Para estabelecimento, separadores, alternativas, múltiplos nomes e expressões de
incerteza falham fechados e permanecem no controle. A sessão ativa não chama `/agent/chat`;
a Maria genérica continua disponível fora desse subfluxo, e seu `metadata.channel` aninhado
preserva apenas a proveniência.

Preparação e resultado também não passam por modelo/tool:
`POST /import-sessions/:id/prepare` prepara a proposta sob as validações do servidor e
retorna `READY` somente com proposta completa; `NEEDS_INPUT` persiste o rascunho/perguntas
atualizados sem proposta, confirmação, execução ou resultado. `GET /import-sessions/:id/result`
lê o estado/recibo autorizado. Nenhum deles confirma. Challenge, confirmação financeira
autenticada e execução permanecem ações separadas. O vault OFF por padrão e a retenção de sete
dias sem edição permanecem exatamente como definidos acima.

Não existe arquitetura contextual de importação na árvore candidata atual: o contrato público
contextual, seus leitores/cópias na UI, portas de texto livre e aprovação de escopo foram
removidos. A Maria genérica detecta deterministicamente apenas o pedido inicial e pode devolver
`START_CARD_INVOICE_IMPORT` com os formatos habilitados antes de consultar provider; isso não é
um turno contextual da sessão nem uma tool.

## Apêndice histórico

- 2026-10-09: documentado o recorte CSV independente de `main` conforme ledger #711, separado
  da PR #714. Aprovação do contrato não marca AC funcional, conclusão de código ou produção.
- 2026-10-11: o marco histórico de implementação `881e9b5c` removeu o caminho de interpretação
  por modelo e a arquitetura contextual da sessão ativa, restringiu o PATCH legado à seleção e
  adotou controles focados determinísticos. Nenhum pass de Linux, Journey, release ou produção
  é inferido deste registro.
