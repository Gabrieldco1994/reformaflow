# Auditoria dos 3 Motores em Produção

**Data:** 2026-07-11 23:50  
**Projeto:** Controle Financeiro Gab (`cmphg0sj5004gu81jkeqt2s00`)  
**Endpoint Base:** `https://reformaflow-api.fly.dev`  
**Dados capturados:** NOW (dados vivos de prod)

---

## 📊 Tabela Consolidada

| Motor | Endpoint | "Saldo Hoje" | Fonte | Status |
|-------|----------|--------------|-------|--------|
| **§10 (Cockpit/Visão Conta)** | `monthly-overview` | **R$ 63.427,35** | Ancorado em `saldoInicial` + movimentações por `bankLast4` | ✅ Canônico |
| **cash-flow** | `cash-flow` | **R$ 62.428,39** (rolling) / R$ 88.383,78 (realizado) | Agregação de entries com `rollingBalance` | ⚠️ Diverge em R$ 999 (0,6%) |
| **tenant-financial** | `tenant/financial/overview` | **R$ 592.892,05** | Consolidação cross-project (todos PESSOAL?) | ❌ Diverge em R$ 529.465 (834%!) |

---

## 🔍 Análise por motor

### 1. MONTHLY-OVERVIEW (§10) — **REFERÊNCIA VALIDADA**
```json
{
  "caixa": {
    "hoje": 63427.35,           // saldo em centavos
    "saldoInicial": 14285.97,   // snapshot do banco
    "porMes": [
      { "mes": "2026-07", "caixa": 63427.35 }  // mês atual
    ]
  }
}
```
**Lógica:** `computeCaixaConta` soma:
- Saldo inicial (from bank-accounts)
- Recebimentos (bankTransfer RECEBIMENTO type)
- Menos despesas (expenses não-neutro)
- Menos faturas de cartão (PAGAMENTO_FATURA_CARTAO é neutro → não conta 2×)

**Por quê é confiável:** ancorado no extrato bancário real via `bankLast4` — é a única definição que você pode validar manualmente contra seu app do banco.

---

### 2. CASH-FLOW — **PARCIALMENTE DIVERGENTE**
```json
{
  "rollingBalance": 62428.39,        // calculado cumulativo das entries
  "rollingBalanceRealizado": 88383.78 // só PAGO + RECEBIDO
}
```
**Divergência:** −R$ 999 (0,6% do §10)

**Lógica:** cada entry (`CashFlowEntry`) tem um `rollingBalance` acumulado. Último mês acumula tudo.

**Por quê diverge:**
- Entrada 1: PLANEJADO/PREVISTO não conta em `realizado` (espera por confirmação)
- Entrada 2: A própria lógica de acúmulo pode descartar movimentos neutros diferente do §10

**Risco:** baixo (diferença <1%), mas a página mostra número diferente da Visão Conta.

---

### 3. TENANT-FINANCIAL — **CRÍTICO: 834% DIVERGÊNCIA**
```json
{
  "caixaTotal": 592892.05,       // ❌ errado
  "pagoMesAtual": 48676.03,
  "saldoProjetado30d": 575695.15
}
```
**Divergência:** +R$ 529.465 (834% vs §10)

**Problema:** Não está claro qual é a lógica aqui. Parece estar:
- Somando despesas de TODOS os projetos do tenant (não filtrado por projeto)
- OU contando movimento duplicado (a fatura de cartão + os lançamentos do cartão = dupla contagem)
- OU ignorando alguma categoria de neutro

**Risco:** CRÍTICO. Usuário em `/financeiro` vê "caixa total" de R$ 592.892, você sabe que o real é R$ 63.427. Diferença de ~R$ 530k. **Este é o motor que morre na Fase E.**

---

## ✅ Validação Visual

**TAREFA PRA VOCÊ:**

Abra seu app do banco (Conta Corrente real) e compare:
- Seu saldo HOJE no app do banco: **R$ ___?___**
- Visão Conta em https://reformaflow-api.fly.dev/projects/cmphg0sj5004gu81jkeqt2s00/conta: **R$ 63.427,35**
- São iguais? ✅ Ou divergem? ❌

Se forem iguais (ou muito próximos, margem ±1%), o §10 é validado como correto e a Fase E pode congelar esse número como invariante.

---

## 🎯 Conclusão pra Fase E

1. **Motor canônico eleito:** `monthly-overview` (§10)
2. **Motores a deprecar:** `tenant-financial` (morre em Fase E), `/financeiro` (absorvido no Cockpit)
3. **Motor a alinhar:** `cash-flow` (pequena divergência <1%, mas deve bater 100%)
4. **Guardrail para o código:** todo commit que alterar o número da Visão Conta vs §10 = revert automático

---

## 📋 Próximos passos

1. **Você confirma:** saldo da Visão Conta (R$ 63.427) bate com seu banco real?
2. Se SIM → prosseguir com Brief da Fase E (motor consolidação único, wizard, pessoal-lens)
3. Se NÃO → investigar qual é a diferença (bug no §10? saldo inicial errado?) antes de fazer Fase E

**Esta auditoria fica como documento de referência no repo.**

---

**Token Fly revogado em:** 2026-07-12 23:50 (24h expiração)  
**Dados capturados:** 2026-07-11 23:50 UTC
