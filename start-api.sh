#!/bin/bash
# Script para iniciar a API do ReformaFlow de forma persistente.
# Uso: ./start-api.sh
#
# A API roda em http://localhost:3001
# O frontend (Next.js) roda em http://localhost:3000 (via: cd apps/web && npx next dev)
#
# Para parar a API:
#   kill $(lsof -i :3001 -t)
#
# Para ver logs:
#   tail -f /tmp/reformaflow-api.log

cd "$(dirname "$0")"

# Matar processo anterior na porta 3001
OLD_PID=$(lsof -i :3001 -t 2>/dev/null)
if [ -n "$OLD_PID" ]; then
  echo "Parando API anterior (PID: $OLD_PID)..."
  kill "$OLD_PID" 2>/dev/null
  sleep 1
fi

# Iniciar API
echo "Iniciando API..."
node apps/api/dist/main > /tmp/reformaflow-api.log 2>&1 &
API_PID=$!
disown $API_PID

sleep 2

# Verificar
if lsof -i :3001 -t > /dev/null 2>&1; then
  echo "✅ API rodando em http://localhost:3001 (PID: $API_PID)"
  echo "   Logs: tail -f /tmp/reformaflow-api.log"
else
  echo "❌ Falha ao iniciar API. Verifique os logs:"
  cat /tmp/reformaflow-api.log | tail -20
  exit 1
fi
