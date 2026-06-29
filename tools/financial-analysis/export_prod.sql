-- Reproduz a aba "Transações" do export do PESSOAL a partir do SQLite.
-- NOTA: o caminho principal é `python reconcile.py --db prod.db` (o script já embute esta query).
-- Este .sql é REFERÊNCIA / uso manual com um sqlite3 LOCAL contra o banco baixado de prod:
--   flyctl ssh sftp get /data/dev.db ./prod.db -a reformaflow-api
--   sqlite3 -header -csv prod.db < export_prod.sql > transacoes-prod.csv   # (sqlite3 local, NÃO no prod)
--   python reconcile.py --prod transacoes-prod.csv
-- (A máquina de prod NÃO tem o binário sqlite3 — por isso baixamos o arquivo e lemos localmente.)
--
-- Datas no Prisma/SQLite são INTEGER (epoch ms) → dividir por 1000 e usar 'unixepoch'.
-- Ajuste o nome do projeto se necessário:
--   sqlite3 /data/dev.db "SELECT id,name FROM projects WHERE type='PESSOAL';"

SELECT
  p.name AS Projeto,
  date(COALESCE(e.data_pagamento, e.data_inicio_parcela, e.created_at) / 1000, 'unixepoch') AS Data,
  CASE
    WHEN e.bank_last4 IS NOT NULL THEN 'Conta Corrente'   -- inclui fatura paga pela conta (entra no §10)
    WHEN e.card_last4 IS NOT NULL THEN 'Cartao de Credito'
    ELSE 'Manual'
  END AS Origem,
  COALESCE(e.fornecedor, e.titulo, '') AS Fonte,
  COALESCE(e.titulo, e.fornecedor, '') AS Descricao,
  ROUND(-e.valor_total / 100.0, 2) AS Valor,              -- despesa = saida (negativo)
  'Saida' AS Tipo,
  e.tipo_despesa AS Categoria,
  e.status AS Status
FROM expenses e
JOIN projects p ON p.id = e.project_id
WHERE e.deleted_at IS NULL
  AND e.linked_expense_id IS NULL                          -- ignora espelho cross-project (evita dupla contagem)
  AND p.name = 'Controle Financeiro Gab'                   -- << ajustar p/ o projeto Pessoal real

UNION ALL

SELECT
  p.name,
  date(r.data / 1000, 'unixepoch'),
  CASE WHEN r.bank_last4 IS NOT NULL THEN 'Conta Corrente' ELSE 'Manual' END,
  COALESCE(r.descricao, ''),
  COALESCE(r.descricao, ''),
  ROUND(r.valor / 100.0, 2),                               -- recebimento = entrada (positivo)
  'Entrada',
  r.tipo,
  r.status
FROM receipts r
JOIN projects p ON p.id = r.project_id
WHERE r.deleted_at IS NULL
  AND r.linked_receipt_id IS NULL
  AND p.name = 'Controle Financeiro Gab';                  -- << mesmo projeto
