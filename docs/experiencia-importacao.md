# Experiência completa de importação

**Status em 2026-09-11: aprovado, em implementação; ainda não entregue.**

Entrega [#689](https://github.com/Gabrieldco1994/reformaflow/issues/689):
[A — criação cross-project](https://github.com/Gabrieldco1994/reformaflow/issues/690) e
[B — fluxo visual](https://github.com/Gabrieldco1994/reformaflow/issues/691).
Reutiliza as PRs #687/#688, mergeadas na base `9587a19f`; este documento não
comprova deploy. A verificação de toque também cobre a #662, sem encerrá-la por antecipação.

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
- Não incluir criação inline via cartão/Carteira/Maria, vários destinos,
  novos parsers, dashboard global ou recuperação durável de rascunhos.
- Os contratos de [caixa](cockpit-caixa-real.md), [faturas](visao-conta-faturas.md)
  e [datas](politica-datas-timezone.md) continuam vigentes.

### Criação: rascunho até confirmar

O editor guarda apenas uma decisão local. Nenhum POST financeiro cria despesa
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

## Referência de implementação

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

## Apêndice histórico

- 2026-09-11: PO aprovou os dois pacotes e o undo somente de destino próprio
  intacto. Design desktop/mobile e contrato transacional foram consolidados
  antes da implementação. Verificação futura: testes reais de origem →
  destino → leitura → undo, concorrência/ACL/drift e jornada em banco isolado.
