# #711 — revisão do backend CSV isolado

Esta evidência é local, não prova de deploy, UI integrada ou validação operacional
do vault em produção. Banco dos testes: `prisma/test.db`, workers descartáveis e
fixture estrutural temporária `test-upgrade.db`. Nenhum teste usa `dev.db`.

## Escopo e justificativa dos arquivos compartilhados

| Grupo                                                             | Necessidade do recorte                                                                                                                                                                                                                        |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `imports/import-session` e vault                                  | Consentimento documental separado da autoridade financeira; ACL revalidada no writer; sessão, receipt, cancelamento, expiração, transferência/release de refs e purga cercada por leases.                                                     |
| `AppModule`, `AgentModule`, JWT, guard de projeto e uploads roots | Registro real do módulo; claims JWT verificadas (versão e expiração); autorização por proprietário estável; vault privado fora de uploads estáticos.                                                                                          |
| Maria controller/service/admission/tools e providers LLM          | Entrada `START_CARD_INVOICE_IMPORT` gerada pelo servidor; interpretação contextual estrita sem conceder confirmação financeira ao modelo. O decoder estrito é opt-in somente para turnos de importação. Respostas comuns não viram controles. |
| CSV e tipos documentais                                           | Normalização de evidência imutável, referência de linha, significado monetário explícito e ordinais; não cria finanças nem trata texto CSV como autoridade.                                                                                   |
| Identidade/dedupe                                                 | Busca tenant/project-scoped com orçamento de enumeração, identidades fortes e natural duplicates explícitos antes da confirmação. O sentinel NUL é escapado e o diff Git é forçado como texto.                                                |
| Expense e cronograma                                              | Writer nativo planejado, centavos inteiros e cronograma exato, inclusive parcelas irregulares; proteção contra alteração financeira genérica e projeções preservadas.                                                                         |
| Cartões                                                           | Catálogo mantém `closingDay`/`dueDay` (1..31 ou null), configuração explícita existente e cálculo de limite pelas ocorrências documentadas.                                                                                                   |
| Monthly overview / domínio caixa                                  | Faturas, origens anuais, quitação e caixa usam ciclo documentado sem deslocamento por recálculo do calendário; espelhos e rateios não duplicam consumo. Compras planejadas não debitam conta real.                                            |
| Bank account / card-invoice-match                                 | Matching de planejadas usa o cronograma real; matching da fatura considera o ciclo documentado também quando difere do mês da data.                                                                                                           |
| Category budget                                                   | Comprometimento expande os centavos/datas efetivos, não divide novamente o total nem cria meses intermediários.                                                                                                                               |
| Conciliação / additive settlement                                 | Regeneração, snapshots e rollback preservam labels, ciclos e cronograma. Sem cronograma documentado, o reset legado de `paidParcelas` no rateio continua null.                                                                                |
| Schema/migrations                                                 | Quatro adições: cronograma documentado, bootstrap de sessões/vault, retenção do vínculo financeiro e descarte de identidade de artefatos órfãos; upgrade 68→72 preserva registros legados e integridade FK.                                   |

Dashboard e tenant-financial não receberam mudanças nesta recuperação: consomem
CashFlowEntry persistido, não recalculam parcelas. Os testes existentes desses
leitores devem permanecer verdes. Nenhuma feature #703, #704 ou nova restauração
CARD foi habilitada. Foram removidos o ramo novo de inspeção RESTORE, runner
binário nativo e helpers de intake PDF/XLS/XLSX/OFX sem consumidor CSV; rotas e
parsers legados já existentes permanecem intactos.

Seleção da primeira CASA/CARRO para recorrências ganhou ordem explícita por
`createdAt`: o novo índice `(tenantId, id)` muda o plano SQLite e não pode mudar
o destino legado por ordem lexicográfica de IDs. O teste OWNER mantém o destino
esperado e agora representa os dois instantes de criação explicitamente, sem
depender de inserts sequenciais caírem em milissegundos diferentes.

## Provas

- Registro do módulo e resolução DI; claims JWT/ImportAuthGuard verificadas.
- Scheduler: escopos persistidos via SQL GROUP BY e limite; kill switch, erro
  opaco observável e reaper transacional. Purger revalida ausência de refs após
  fencing e limpa `extractionJson`, sem apagar observações/receipt.
- Workflow persistido com parser/materializer reais e fixture de extração:
  prepare/challenge/confirm não criam finanças; execute usa adapter e writer
  reais, limpa `draftJson`/`searchJson`/`proposalJson`, libera refs e mantém receipt.
  Replay não cria outra compra; outro request ID conflita; reserve/upload após
  APPLIED falham sem consumir bytes; receipt de outro tenant é NOT_FOUND.
- Mutation check: retirar os três campos de limpeza do UPDATE APPLIED faz a
  asserção persistida falhar, mesmo com a projeção pública terminal ocultando-os.
  A mutação foi restaurada antes da validação final.
- Writer exato: 101/207/301 centavos, labels 2/4–4/4, datas não consecutivas e
  ciclos explícitos; invoice aggregate, matching, origem anual e budget leem o
  mesmo cronograma. Total inválido/cartão de outro tenant e falha posterior
  revertem efeitos; source permanece PLANEJADO e sem bankLast4.
- Writer rejeita ocorrência zero/negativa mesmo com soma positiva válida:
  os dois casos foram RED (criação efetiva), depois GREEN com rejeição atômica.
  O parser documental geral permanece inalterado; isso não habilita refunds.
- RED→GREEN adicionais: source NUL, autoridade RAW não-CSV pelo broad switch,
  reserva PDF, SQL GROUP BY do scheduler e reset legado do rateio.
- Entrada Maria: verbo exato somente em turno servidor; conteúdo LLM normal e
  pedido negado não produzem `importEntryAction`.
- Upgrade estrutural temporário: 68 migrations com compra legada e override;
  deploy das três novas preserva todos os campos anteriores e passa FK check.
- Fixtures de upgrades anteriores continuam exercitando o mesmo banco legado
  e backup. Snapshots usam colunas realmente existentes, não a projeção completa
  do client Prisma 72 contra schemas antigos. A prova isolada #702 termina antes
  de aplicar migrations posteriores para chamar os serviços atuais; a fixture
  #569 exige NULL nas três novas colunas e igualdade em todos os campos legados.

## Validação final local

### Checkpoint antes da revisão de identidade (2026-10-09)

Baseline local `44b754965f6aa2957bc01a523690ed2568738932`: três suítes
(`canonical-retention`, `canonical-retention-orphan-upgrade`,
`vault/session-retention`) passaram, 23 testes. A revisão de identidade
nullable/PURGING ainda não está implementada neste checkpoint.
O deploy da fixture descartável encontrou 72 migrations; isso não é evidência
de aplicação em produção.

### Revisão de identidade nullable/PURGING (#711)

- RED inicial: a última claim apagada com anexo ativo mantinha hash/cache;
  a cópia de tabela apagava hash/cache de `PURGING` com claim viva; finalize
  não chamava a purga e terminava em conflito de escrita. Esses casos foram
  materializados e falharam antes das mudanças de produção.
- `canonical-retention.integration.spec.ts`: aposentadoria com anexo ativo,
  duas claims (somente a última encerra o hash), bloqueios de ressurreição,
  storage replacement, parser/cache/lease e novas observações/associações;
  intake nunca reclamado conserva identidade quando ainda está ativo.
- `vault/session-retention.integration.spec.ts`: Vault/Prisma/parser reais;
  original privado de tombstone acessível somente pela ref ATTACHED autorizada,
  sessão em revisão sem análise e novo upload com IDs novos; cancelamento e
  expiração compartilhados terminam em remoção física cercada. Claim viva
  sobrevive a PURGING→PURGED→RAW_READY, reextração não duplica finanças.
  Barreiras cobrem dois uploaders, perdedor da mesma ref, cancelamento/deleção
  durante espera e indisponibilidade/timeout com limpeza temporária pendente.
- `claimed-purging-upgrade.integration.spec.ts`: fixture QA `f2d4c90`, agora
  explicitamente 71→72 em banco guardado dentro deste worktree: Expense e Receipt
  vivos conservam SHA/cache/observações/comprovante APPLIED; PURGING sem claim
  perde identidade; intake ativo nunca reclamado fica intacto.
- `canonical-retention-orphan-upgrade.integration.spec.ts`: órfãos legados,
  claims mortas, referências compartilhadas e os dois controles PURGING;
  `migration-upgrade.integration.spec.ts` mantém a prova estrutural 68→72.
- Port QA: timeout real do drain retorna `RETRYABLE_WRITE_CONFLICT` fora da
  transação, mantendo finance/claims/flows. Replay APPLIED após deleção canônica
  mantém receipt, atividade e fluxo; READY perde proposta/nonce sem renovar prazo.
  As expectativas de revisão usam a seam de capability somente no teste;
  o gate CSV default continua negando prepare após aposentadoria.
- O primeiro run da suíte QA sem adaptação revelou seis fixtures passando
  RAW_READY/parser null ao materializer (substituídas por análise real),
  três expectativas legadas de linhas já descartadas pela migration 72
  (cobertas pelas fixtures terminais atuais) e a precedência do gate default
  antes de revisão. Não houve alteração no worktree QA.
- Prova final focada: **5 suítes / 43 testes**; domínio/API/web `tsc --noEmit`
  verdes. Template fresco e worker: 72 migrations em ordem, todos os checksums
  conferem, `foreign_keys=1`, `foreign_key_check=[]`. Migrations 1–71 byte-idênticas
  a `44b7549`; SHA-256 da 72:
  `0c437c8bb831d18416295c8a91f58b42e67c8c0c63d2c3c4fca41b353e0e3971`.
- Run final ampliado: **194 suítes / 2.179 testes aprovados**, com importação,
  Maria/agent, auth, cartões, despesas, monthly overview, bancos, budgets,
  conciliação, dashboard, tenant-financial, recebimentos, Prisma e common.
  Prettier e `git diff --check` verdes. Sem configuração ESLint neste worktree;
  SQL foi validado pelo deploy SQLite fresco/upgrade e checks de constraints/FKs.
- Templates descartáveis anteriores foram arquivados, não apagados. `dev.db`
  e os dois diretórios temporários pré-existentes permaneceram intocados.

- API antes desta revisão: **179 suites / 2.019 testes aprovados**, incluindo importação,
  Maria, auth, cartões, despesas, dedupe, monthly overview, bancos, budgets,
  conciliação, dashboard, tenant-financial e todas as fixtures Prisma.
- Domínio: build aprovado; **30 arquivos / 396 testes aprovados**.
- `tsc --noEmit`: domínio, API e web aprovados.
- Schema Prisma validado com datasource explicitamente descartável.
- Lint API indisponível: comando do projeto termina com
  `eslint: command not found` (exit 127). Não foram instaladas dependências.
- Prettier executado em arquivos novos e trechos alterados dos legados. Check
  final: 116 arquivos TS/MD, 27 avisos de arquivo inteiro já presentes no baseline
  e nenhum aviso novo (comparação com `git show` do HEAD base). Fixtures editadas
  foram formatadas por inteiro; não houve reescrita ampla dos serviços legados.
  `git diff --check` aprovado.

## Limites desta rodada

O workflow financeiro usa grants substituídos na fixture positiva, mas a prova
negativa usa o verifier real e rejeita uma chamada direta sem grant. A entrada
CSV/vault completa por HTTP e disco real, QA de navegação/UI e operação do cron
em um processo persistente ainda não foram certificados por esses testes.
O bootstrap e os testes unitários de purge não equivalem a um ensaio operacional
do armazenamento. Integração na branch limpa/PR fica com o orquestrador.
