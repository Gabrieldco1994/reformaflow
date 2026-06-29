# Brief — Análise de reconciliação financeira do PESSOAL (ReformaFlow)

> **Para um agente Cowork que começa SEM contexto.** Tudo o que você precisa pra rodar a análise está aqui.
> Objetivo: **verificar se os dados financeiros do app em produção (projeto PESSOAL) batem com a
> planilha-master**, desconsiderando lançamentos manuais. Reportar divergências.
>
> 📎 **Se você recebeu estes 3 arquivos por upload (soltos, sem o repositório):** nos comandos abaixo
> **ignore o prefixo `tools/financial-analysis/`** — use só os nomes: `reconcile.py` e `export_prod.sql`
> (devem estar na mesma pasta onde você roda os comandos).

---

## 0. TL;DR (o caminho feliz)

A máquina do Fly fica **suspensa** e **não tem o binário `sqlite3`**. Por isso: acorde a VM por HTTP,
**baixe o arquivo `/data/dev.db`** por sftp e leia com Python (sqlite3 é embutido no Python).

```bash
# 0. flyctl autenticado pelo token (export no ambiente)
export FLY_API_TOKEN="FlyV1 ..."   # token de deploy escopado, fornecido por quem abriu a sessão

# 1. acordar a VM (SSH/sftp NÃO faz auto-start; uma requisição HTTP sim)
until curl -fsS -o /dev/null https://reformaflow-api.fly.dev/api/docs-json; do sleep 3; done

# 2. baixar o banco de prod (SQLite) — read-only
flyctl ssh sftp get /data/dev.db ./prod.db -a reformaflow-api

# 3. reconciliar direto do .db (usa o sqlite3 embutido do Python; não precisa do binário)
python reconcile.py --db prod.db
```
Leia a tabela PASS/FAIL e escreva o relatório (seção 7). Se algo der FALHA, investigue (seção 8).

---

## 1. Acessos necessários

| Recurso | Como | Pra quê |
|---|---|---|
| **Arquivos do pacote** (`reconcile.py` + este brief; `export_prod.sql` é referência opcional) | upload na sessão (ou repo) | rodar a análise |
| **`flyctl`** | `curl -L https://fly.io/install.sh \| sh` | baixar o banco de prod |
| **`FLY_API_TOKEN`** (token escopado no app, 24h) | gerado por quem abre a sessão: `flyctl tokens create deploy -a reformaflow-api -x 24h` | autenticar o `flyctl` |
| **Python 3** (sqlite3 já vem embutido) | — | ler o `.db` e reconciliar |
| `openpyxl` | `pip install openpyxl` | **só** se usar `--master` (xlsx) |
| Egress de rede pra `*.fly.dev` | (ambiente do Cowork) | falar com a máquina do Fly |

> ⚠️ **Segurança:** o token dá acesso de **leitura e escrita** a prod. Use um token **temporário**
> (`-x 24h`), **só leia** (apenas `sftp get` — nunca escreva em `/data/dev.db`), não comite o token,
> e **revogue ao terminar** (`flyctl tokens list` → `flyctl tokens revoke <id>`).

## 2. Como puxar os dados de produção (sftp + Python)

O banco de prod é um **SQLite** em `/data/dev.db` dentro da máquina do Fly (sem conexão externa).
A máquina **suspende** por inatividade e a imagem **não tem `sqlite3`** — então o caminho confiável é
**baixar o arquivo** e ler localmente com Python.

```bash
# acordar a VM e baixar o banco
until curl -fsS -o /dev/null https://reformaflow-api.fly.dev/api/docs-json; do sleep 3; done
flyctl ssh sftp get /data/dev.db ./prod.db -a reformaflow-api   # usa $FLY_API_TOKEN

# (sanidade) confirme que veio um SQLite com dados:
python - <<'PY'
import sqlite3; c=sqlite3.connect('prod.db')
print("projetos PESSOAL:", c.execute("SELECT name FROM projects WHERE type='PESSOAL' AND deleted_at IS NULL").fetchall())
PY

# reconciliar (nome do projeto default = 'Controle Financeiro Gab'; troque com --project se preciso)
python reconcile.py --db prod.db --project "Controle Financeiro Gab"
```

- O `reconcile.py --db` roda a query embutida (espelha `export_prod.sql`) com a lib `sqlite3` do Python.
- Abre o banco em **modo read-only**; ainda assim, **não** rode nada que escreva no `.db`.
- **(Opcional) Master pra recalcular alvos:** anexe `Consolidacao_Financeira.xlsx` e use `--master`
  (aí precisa de `openpyxl`). Sem ele, o script usa os alvos embutidos (retrato de 01/06/2026).

## 3. Conceitos e convenções (leia antes de interpretar números)

- **Sinais:** positivo = **entrada** (dinheiro entra), negativo = **saída**.
- **Resgate de investimento = ENTRADA** (dinheiro voltando da aplicação). **Aplicação = saída.**
  ⚠️ Bug histórico: resgate entrava como saída (negativo). Se aparecer resgate negativo no export, é
  dado desatualizado/bug de import — o script sinaliza.
- **Desconsiderar `Origem = Manual`**: são despesas/recebimentos lançados à mão que **duplicam o extrato**
  (salários, obra). Não entram na comparação com o master.
- **Neutras** (não são gasto real, ficam fora do resultado): `Categoria = PAGAMENTO_FATURA_CARTAO`.
  Pagar a fatura = pagar de uma vez os itens do cartão; contar os dois = contar em dobro.
- **Status realizado** = `PAGO` (saída efetivada) ou `EM_CAIXA` (entrada efetivada). `PLANEJADO`/`PREVISTO` = futuro.

## 4. A reconciliação §10 (o teste que prova que está certo)

```
saldo da conta hoje = saldo inicial (14.285,97 em 31/12/2025)
                    + Σ lançamentos REALIZADOS da CONTA CORRENTE  (Origem = "Conta Corrente", status PAGO/EM_CAIXA)
```
Só conta corrente (cartão fica de fora — está na fatura, não na conta). Resultado esperado ≈ **R$ 17.229,74**,
que bate com o saldo do banco (extrato R$ 17.229,88; diferença R$ 0,14 = arredondamento de rendimento, ok).
Se o caixa §10 não bate com o banco, **tem bug nos dados da conta** (tipicamente sinal de resgate).

## 5. Alvos do master (corte 01/06/2026)

| Métrica | Alvo |
|---|---|
| Recebimentos reais (pago+previsto) | **497.689,46** |
| Saídas reais (pago+planejado) | **−530.954,94** |
| Neutras (pgto fatura) | **−76.475,64** |
| Líquido realizado | **18.381,48** |
| Saldo futuro projetado | **−33.265,48** |
| Caixa da conta (§10) | **17.229,74** (banco 17.229,88) |

Tolerância: R$ 1,00. Diferença de centavos no caixa = arredondamento de rendimento (esperado).

## 6. Como rodar o reconcile

Três fontes possíveis (use **`--db`** com o arquivo baixado de prod — é o caminho principal):

```bash
# A) direto do banco de prod baixado (recomendado)
python reconcile.py --db prod.db                       # projeto default 'Controle Financeiro Gab'
python reconcile.py --db prod.db --project "Outro Nome"

# B) de um export do app (.xlsx) ou um CSV
python reconcile.py --prod reformaflow-pessoal-prod-AAAAMMDD.xlsx

# opcional em qualquer modo: recalcular alvos do master (precisa openpyxl) / ajustar refs
python reconcile.py --db prod.db --master Consolidacao_Financeira.xlsx
python reconcile.py --db prod.db --opening 14285.97 --opening-date 2025-12-31 --bank 17229.88
```
O script imprime uma tabela `prod vs master` com PASS/FAIL por métrica, a diferença vs. banco e
um alerta se houver resgate com sinal invertido. Exit code 0 = tudo bate, 1 = divergência.

> ⏱️ **Os alvos embutidos são um retrato de 01/06/2026.** Se prod tiver dias de atividade a mais,
> as métricas sensíveis a tempo (recebimentos/saídas/líquido/caixa) vão divergir por **drift normal** —
> não é bug. O que é **invariante no tempo** e deve sempre passar: **neutras** (categorização de fatura)
> e **resgates positivos**. Pra um veredito "ao vivo", compare o **Caixa §10** com o **saldo ATUAL** do
> app do banco (não com o 17.229,88, que é de 01/06), ou gere um master novo e use `--master`.

## 7. Relatório esperado (o que devolver)

- **Veredito:** bate / não bate.
- Tabela das 6 métricas (prod × master × OK/FALHA).
- Se houver divergência: **causa provável e impacto em R$** (ex.: "5 resgates invertidos = R$ 226.441,30;
  conta não reconcilia com o banco"). Liste as linhas-problema.
- A conferência da §10 (caixa vs banco).
- Sempre dizer explicitamente que os **manuais foram desconsiderados** (e quantos eram).

## 8. Sinais de alerta conhecidos

- **Resgate negativo** → bug de import (deveria ser entrada). Impacto = 2× o valor de cada resgate.
- **Caixa §10 ≠ banco por muito** → dado da conta corrompido (sinal/duplicidade).
- **Recebimentos ~866k** → manuais (salários) não foram excluídos ou estão duplicando o extrato.
- **Saídas reais ≠ −530.954,94 mas neutras baixas** → categorização de fatura (PAGAMENTO_FATURA_CARTAO) incompleta.

---
*Contexto do app:* monorepo (Next.js em `apps/web`, NestJS+SQLite em `apps/api`, regras em `packages/domain`).
A lógica de caixa §10 também está implementada no app em `apps/api/src/monthly-overview/monthly-overview.service.ts`
(`computeCaixaConta`) — útil como referência da regra.
