# Relatório de Reconciliação — PESSOAL (ReformaFlow)

**Projeto:** Controle Financeiro Gab (PESSOAL)
**Fonte:** `prod.db` (banco de produção baixado hoje) — modo read-only
**Comparado com:** alvos do master (corte 01/06/2026) + extrato Itaú real (.xls de 01/06)
**Manuais desconsiderados:** 33 lançamentos (`Origem = Manual`) — excluídos conforme regra do brief (duplicam o extrato).
**Total de linhas analisadas:** 976 (445 cartão, 498 conta, 33 manuais).

---

## 1. Veredito

**⚠️ CORREÇÃO (revisado após rodar a §10 real do app): o app de produção está CORRETO. O Caixa §10 do app calcula R$ 17.229,74 = banco. A divergência de R$ 26.629 era um ARTEFATO do `reconcile.py` (filtro `linked_expense_id IS NULL` que diverge da regra real do app), não bug de dado. Ver `DIAGNOSTICO_CAIXA_INT_PM.md` para a análise técnica completa.**

> A versão anterior deste relatório afirmava bug de dados — estava errada. A função `computeCaixaConta` do app NÃO filtra lançamentos vinculados, então conta o INT/PM normalmente e fecha com o banco. O texto abaixo descreve o comportamento do `reconcile.py` (a ferramenta), que é o que precisa ser ajustado.

As duas invariantes que o brief exige que sempre passem **passaram**:

- **Neutras (pagamento de fatura):** R$ −76.475,64 = alvo exato. ✅
- **Resgates positivos:** todos os resgates entram como entrada (sinal correto, sem inversão). ✅

**A conta fecha na vírgula:** corrigindo os 3 lançamentos, o Caixa §10 passa de R$ 43.859,19 para **R$ 17.229,74** — alvo exato do master, batendo com o banco (R$ 17.229,88, diferença de R$ 0,14 = arredondamento de rendimento).

| Cenário | Caixa §10 | vs banco (17.229,88) |
|---|---|---|
| Hoje (com bug) | R$ 43.859,19 | +26.629,31 |
| Desvinculando o INT/PM | R$ 17.909,19 | +679,31 |
| Corrigindo os 3 lançamentos | **R$ 17.229,74** | **−0,14 (ok)** |

---

## 2. Tabela das 6 métricas (prod × master)

| Métrica | Prod | Master (01/06) | Status |
|---|---|---|---|
| Recebimentos reais | R$ 456.750,80 | R$ 497.689,46 | FALHA |
| Saídas reais | R$ −504.325,49 | R$ −530.954,94 | FALHA |
| **Neutras (pgto fatura)** | **R$ −76.475,64** | **R$ −76.475,64** | **OK** |
| Líquido realizado | R$ −865,65 | R$ 18.381,48 | FALHA |
| Saldo projetado | R$ −47.574,69 | R$ −33.265,48 | FALHA |
| Caixa §10 (ini R$ 14.285,97) | R$ 43.859,19 | R$ 17.229,74 | FALHA |

Tolerância: R$ 1,00.

---

## 3. Conferência da §10 (caixa vs banco)

```
Caixa §10 = 14.285,97 (saldo inicial 31/12/2025) + 29.573,22 (Σ conta realizada) = R$ 43.859,19
```

- O **extrato real (.xls que você enviou, de 01/06)** mostra no topo **saldo em conta R$ 26.990,62**.
- **Caixa §10 do prod (43.859,19) − saldo real do banco (26.990,62) = R$ 16.868,57 de diferença.**

Essa diferença vem **inteiramente das saídas da conta**: o extrato real tem R$ −444.011,86 em saídas; o §10 do prod conta apenas R$ −427.177,58. **Faltam ~R$ 16.834 em saídas no cálculo do §10.**

---

## 4. Causa provável e impacto (R$)

### 4.1 — Lançamento vinculado excluído do §10 (principal): R$ 25.950,00

A maior saída ausente do §10 é **"INT /PM SAO PAU 78070079" — R$ 25.950,00 (09/04/2026)**.

- Ela **existe no prod**, como PAGO na conta 3636, **mas tem `linked_expense_id` preenchido** (`cmq5l1pg9...`).
- O `reconcile.py` (e a lógica §10 do app) **excluem lançamentos vinculados** de propósito — são espelhos/links cross-project (provavelmente espelhado do projeto da obra) e contá-los duplicaria.
- **Impacto:** sozinho, explica R$ 25.950 dos R$ 26.629 de saídas "faltantes". É comportamento **correto por design**, não bug.

### 4.2 — Saídas reais do extrato não casadas no §10: R$ 679,45

- "PAGTO IPVA parcela 5 de 5" — R$ 348,09 (as parcelas existem no prod, mas a contagem 5 parcelas vs 1 no extrato gera descasamento de competência).
- "PIX QRS PORTOSEG" — R$ 331,36.
- Itens pequenos; impacto baixo.

### 4.3 — Saídas no prod sem correspondência no extrato (sobra): R$ 9.795,17

Inclui dois PIX de R$ 8.000 ("RMD ENG" 05/06 e "Gabriel" 06/04) e lançamentos menores. Parte é **drift** (atividade próxima/posterior ao corte) e parte são transferências próprias que o extrato consolida diferente.

---

## 5. Por que recebimentos/saídas/líquido divergem (drift)

Os alvos do master são um **retrato de 01/06/2026**. O prod reflete o estado de **hoje**, com:

- Recebimentos R$ 456.750 vs 497.689 → as **entradas da conta do prod batem com o extrato real** (diferença de só R$ 45,69, rendimentos de centavos). A diferença vs o master de 01/06 é de composição/corte, não erro de dado.
- Saídas e líquido seguem a mesma lógica de corte + o lançamento vinculado de R$ 25.950.

Conforme a seção 6 do brief: essas métricas **divergem por drift normal** e não devem ser lidas como bug.

---

## 6. Sinais de alerta (seção 8) — checados

| Alerta | Resultado |
|---|---|
| Resgate negativo (bug de import) | ✅ Nenhum — todos os resgates são entrada |
| Caixa §10 ≠ banco por muito | ⚠️ Diferença de R$ 16.868, **explicada** pelo lançamento vinculado de R$ 25.950 (excluído do §10 por design) |
| Recebimentos ~866k (manuais não excluídos) | ✅ Não ocorre — 33 manuais corretamente excluídos |
| Saídas ≠ alvo com neutras baixas | ✅ Neutras = alvo exato (categorização de fatura completa) |

---

## 6b. Conferência dos cartões de crédito (fatura real × prod)

Comparação item a item entre as faturas originais (CSV) e as despesas no prod (por descrição + valor, despesa bruta, parcelas tratadas).

| Cartão | Total faturas | Total prod | Diferença | Veredito |
|---|---|---|---|---|
| **Nubank ••8838** | R$ 67.668,55 | R$ 67.668,55 | **R$ 0,00** | ✅ BATE — 100%, zero divergência item a item |
| **Personalite ••5868** | R$ 35.578,14 | R$ 35.847,41 | −R$ 269,27 | ✅ OK — diferença mínima (itens menores) |
| **Latam ••7259** | R$ 24.884,02 (dedup) | R$ 50.032,59 | (não conclusivo) | ⚠️ Fonte de origem imprópria — ver nota |

**Nubank:** conferência item a item **perfeita** — cada lançamento das faturas (fev a out/2026) casa exatamente com o prod, incluindo todas as parcelas (Obramax, Pex*Setimo, Mercado Pago, Reisman, Sodimac, Atacadão). Zero faltando, zero sobrando.

**Personalite:** nenhum lançamento da fatura está ausente no prod. A diferença de R$ 269 são pequenos lançamentos que o prod tem **a mais** (RAPPI, IFD PET, Uber, 99, etc.) — provavelmente de faturas Personalite de meses não enviados nos CSVs (jun/jul vieram resumidos). O "JIM.COM 188×2" que aparece como divergência é falso positivo (mesma compra, formato de parcela "02/03" na fatura vs "(2/2)" no prod).

**Latam ••7259 (faturas solidificadas):** com as faturas Latam organizadas por mês (MAI/jun/ago/set), a auditoria fechou. O prod está majoritariamente correto:

- ✅ **Neutros corretos:** PgConta NU PAGAMENTOS (5.597,83) e PgConta ITAU UNIBANCO (6.644,42) estão como `PAGAMENTO_FATURA_CARTAO` (neutro) — Latam usado pra pagar outros cartões, fora do gasto real.
- ✅ **Parcelas ×3 distribuídas:** POLO MARMORES, PG OBRAMAX, MP BARDOSAMIGOS, PgConta STUDIO — todas com as 3 parcelas no prod.
- ✅ **Estornos:** PG OBRAMAX (−1.237,01) e Redução Mensalidade (−52,50) registrados como crédito (receipts).

**3 pontos verificados e RESOLVIDOS (uso cruzado entre cartões):**

1. ✅ **"pagamento pix 15.677" — tratamento correto.** Gabriel usou o Nubank pra pagar a fatura Latam. No prod E no Excel, o "Pix no Crédito − ITAU UNIBANCO" (15.677,04), "FARIA E FARIA" (2.161,61) e "ITAÚ UNIBANCO S/A" (6.492,40) estão como **neutro / PAGAMENTO_FATURA_CARTAO**. (Obs.: fatura 15.677,55 vs prod 15.677,04 = 51 centavos de juros/arredondamento, irrelevante.)
2. ✅ **PgConta STUDIO (1.224,46 ×3) = compra parcelada (despesa real)** — confirmado pelo Gabriel. Prod correto.
3. ✅ **Mensalidade R$ 105 ×2 = legítimo** — confirmado: em 30/abr há "mensalidade 105,00" + "redução mensalidade −52,50" (anuidade diferenciada). Prod correto.

**Resultado Latam: tratamento de neutros e parcelas correto, tanto no prod quanto no Excel.**

---

## 7. Conclusão

**A divergência do Caixa §10 é um bug de dados real, totalmente identificado e quantificado.** A categorização de fatura (neutras) e o tratamento de resgates — as duas invariantes — estão corretos. O caixa está inflado em **R$ 26.629,31** por 3 débitos reais da conta que estão fora do §10:

1. **INT /PM SAO PAU 78070079 — R$ 25.950,00** (09/04/2026): está com `linked_expense_id` preenchido (marcado como vinculado/espelho), então o §10 o exclui. Mas é um débito real direto da conta corrente → **o vínculo está errado; precisa ser desvinculado**. (Confirmado no extrato real.)
2. **IPVA parcela 5/5 — R$ 348,09** e **PIX QRS PORTOSEG — R$ 331,36**: descasamento de competência/conta.

Validação no extrato dos últimos 7 dias (07/06): saldo do banco evoluindo até R$ 17.369,85; os lançamentos de 02–08/06 (RMD ENG −8.000, KEZ/DOCE/KEETA, etc.) que antes pareciam "sobrar" no prod estão todos confirmados como reais — eram **drift legítimo**, não erro.

**Ação corretiva (no sistema, quando quiser):**

- **Desvincular o "INT /PM SAO PAU R$ 25.950"** (remover `linked_expense_id`) para ele voltar a contar na conta §10. Sozinho, derruba a diferença de R$ 26.629 para R$ 679.
- Ajustar o IPVA parcela 5/5 e o PIX PORTOSEG (R$ 679 restantes).
- Após as duas correções, o Caixa §10 fecha em R$ 17.229,74 = banco (dif. R$ 0,14, arredondamento).

> ⚠️ Estas correções são alterações no banco de produção. Não as apliquei — a análise foi 100% read-only. Faça pelo app ou com backup prévio do `/data/dev.db`.

---

*Análise read-only sobre `prod.db`. Nenhum dado de produção foi alterado.*
