# Diagnóstico — Caixa §10, lançamento "INT /PM SAO PAU R$ 25.950" e divergência do reconcile.py

**Projeto:** Controle Financeiro Gab (PESSOAL) — `project_id = cmphg0sj5004gu81jkeqt2s00`
**Banco analisado:** `prod.db` (dump de produção, read-only)
**Data da análise:** 09/06/2026

---

## TL;DR (para o dev)

- ✅ **O app de produção está CORRETO.** A função `computeCaixaConta` (§10) calcula **R$ 17.229,74**, que bate com o saldo do banco (R$ 17.229,88; dif. R$ 0,14 = arredondamento de rendimento).
- ❌ **O bug está na ferramenta de auditoria `reconcile.py`**, não no app nem nos dados. O script exclui `linked_expense_id IS NOT NULL` na query, e por isso **não conta** o INT/PM de R$ 25.950 → calcula caixa errado (R$ 43.859,19, inflado em R$ 26.629).
- ⚠️ **Não há duplicação de valor.** O INT/PM aparece "fisicamente" 1× (ver seção 3). A questão é só **qual cópia conta em qual cálculo**.
- 🧹 **Lixo de teste em produção:** existe um expense `[E2E test bug2] NT /PM SAO PAU` no projeto "Minha Casa" (está soft-deleted, mas vazou de um teste E2E pra base de prod).

---

## 1. O lançamento

"INT /PM SAO PAU 78070079" = pagamento de R$ 25.950,00, débito real da **conta corrente Itaú** (bank_last4 = `3636`), categoria MORADIA, data de pagamento 09/04/2026. (Provável pagamento à Prefeitura de São Paulo.)

## 2. A pergunta original: "está duplicando em prod?"

**Não.** O valor entra **uma única vez** em cada cálculo. Verificação empírica abaixo.

## 3. As 3 cópias no banco (todos os projetos)

| expense_id | projeto | bank_last4 | linked_expense_id | deleted | conta na §10 do PESSOAL? |
|---|---|---|---|---|---|
| `cmq4d7gux01a5nyrx7su0tbs9` | Controle Financeiro Gab (PESSOAL) | **3636** | `cmq5l1pg9...` (SIM) | não | **SIM** (app conta; reconcile.py NÃO) |
| `cmq5l1pg90001klmoeblcmutx` | Minha Casa (CASA) | null | null | não | não (sem bankLast4 e outro projeto) |
| `cmq5koy4g0005qlc2knn7i7w2` | Minha Casa — `[E2E test bug2]` | null | null | **SIM (soft-deleted)** | não |

- A cópia do **PESSOAL** é a que tem `bank_last4=3636` (o débito real da conta). É vinculada (`linkedExpenseId`) à cópia "pai" do projeto Casa.
- A cópia "pai" no **Casa** não tem bankLast4 (não é lançamento de conta corrente; é a despesa de obra no projeto Casa).
- A terceira é **lixo de teste E2E** soft-deleted.

## 4. Causa-raiz da divergência (app × reconcile.py)

### App (produção) — CORRETO
`apps/api/src/monthly-overview/monthly-overview.service.ts`, função `computeCaixaConta`:

```ts
this.prisma.expense.findMany({
  where: { tenantId, projectId, deletedAt: null, bankLast4: { not: null } },
  // ⚠️ NÃO filtra linkedExpenseId
})
```

A §10 do app pega **todos** os expenses com `bankLast4 != null` e status PAGO. O INT/PM do PESSOAL tem `bank_last4=3636` e status PAGO → **entra no cálculo**. Resultado validado contra o `prod.db`:

```
saldo inicial            14.285,97
+ Σ conta realizada       2.943,77   (inclui o INT/PM −25.950)
= Caixa §10              17.229,74   ✅ bate com banco (17.229,88; dif 0,14)
```

### reconcile.py — FONTE DO ERRO
A query do `reconcile.py` (`DB_QUERY`) tem:

```sql
WHERE e.deleted_at IS NULL AND e.linked_expense_id IS NULL AND p.name = ?
```

O `linked_expense_id IS NULL` **exclui** o INT/PM (que é vinculado). Sem ele, a §10 do script perde R$ 25.950 e calcula **R$ 43.859,19** (inflado). **É discrepância entre a regra da ferramenta e a regra real do app** — o app é a fonte de verdade e está certo.

## 5. Por que o reconcile divergiu em R$ 26.629

| Lançamento | expense_id | Valor | Por que o reconcile não contou |
|---|---|---|---|
| INT /PM SAO PAU | `cmq4d7gux01a5nyrx7su0tbs9` | R$ 25.950,00 | `linked_expense_id` preenchido (excluído pela query) |
| PAGTO IPVA parcela 4/5 | `cmq4d7gsn011nn...` | R$ 348,09 | idem (vinculado) |
| PIX QRS PORTOSEG | `cmq4d7gqp00vjn...` | R$ 331,36 | idem (vinculado) |
| **Total** | | **R$ 26.629,45** | = diferença observada |

(O app conta os três normalmente porque não filtra `linkedExpenseId` na §10.)

## 6. Ações recomendadas

### 6.1 — Corrigir o reconcile.py (prioridade)
Alinhar a query do `reconcile.py` à regra real do app na §10: **não excluir `linked_expense_id`** para o cálculo do caixa da conta (ou, no mínimo, não excluir quando `bank_last4 IS NOT NULL`). Hoje a ferramenta dá falso positivo de "caixa inflado".

> Atenção: o filtro de `linked` provavelmente faz sentido para **outras** métricas (evitar dupla contagem de despesa-espelho cross-project no resultado/fluxo). A correção é cirúrgica: só a §10 (caixa da conta) deve ignorar esse filtro, espelhando o `computeCaixaConta`.

### 6.2 — Limpar lixo de teste em produção
Remover (hard-delete) o expense `cmq5koy4g0005qlc2knn7i7w2` `[E2E test bug2] NT /PM SAO PAU` do projeto "Minha Casa". Está soft-deleted, mas é dado de teste E2E que vazou pra prod. Investigar por que um teste E2E escreveu na base de produção (risco de mais lixo).

### 6.3 — Validar a semântica do vínculo (opcional, revisar)
Confirmar que o desenho está correto: a cópia do PESSOAL (bank=3636, vinculada) é o débito da conta e deve contar na §10 (✅ está); a cópia do Casa é a despesa do projeto de obra. Se a intenção é que o gasto apareça nos dois projetos sem dupla contagem no consolidado, o mecanismo de `linkedExpenseId` está cumprindo isso — só garantir que nenhuma métrica do consolidado some as duas pontas.

## 7. Conclusão

**Os dados de produção e o cálculo de caixa do app estão corretos.** O caixa §10 do app bate com o banco na vírgula. A divergência de R$ 26.629 era um **artefato do `reconcile.py`** (filtro `linked_expense_id IS NULL` que diverge da regra do app), não um bug de dado nem duplicação. Itens a tratar: corrigir o filtro no reconcile.py e limpar o expense de teste E2E.

---
*Análise read-only sobre `prod.db`. Nenhum dado de produção foi alterado.*
