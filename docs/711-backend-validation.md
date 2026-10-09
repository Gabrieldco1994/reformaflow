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
| Schema/migrations                                                 | Duas adições: cronograma documentado e bootstrap de sessões/vault; upgrade 68→70 preserva registros legados e integridade FK.                                                                                                                 |

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
  deploy das duas novas preserva todos os campos anteriores e passa FK check.
- Fixtures de upgrades anteriores continuam exercitando o mesmo banco legado
  e backup. Snapshots usam colunas realmente existentes, não a projeção completa
  do client Prisma 70 contra schemas antigos. A prova isolada #702 termina antes
  de aplicar migrations posteriores para chamar os serviços atuais; a fixture
  #569 exige NULL nas três novas colunas e igualdade em todos os campos legados.

## Validação final local

- API afetada: **179 suites / 2.019 testes aprovados**, incluindo importação,
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
