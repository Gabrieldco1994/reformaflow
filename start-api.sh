#!/bin/bash
# Script para iniciar a API do ReformaFlow de forma persistente (sobrevive ao shell).
#
# Uso:
#   ./start-api.sh                 # porta 3001 (padrão)
#   PORT=3011 ./start-api.sh       # outra porta (para rodar em paralelo com outro agente)
#   ./start-api.sh 3011            # idem, por argumento
#
# Seguro para worktrees:
#   - carrega o .env do PRÓPRIO diretório do script (nunca o do checkout principal);
#   - respeita um DATABASE_URL já exportado no ambiente (nunca sobrescreve);
#   - NUNCA mata processo de outro agente: se a porta estiver ocupada, aborta;
#   - log por instância (worktree + porta).
#
# Para parar esta API:
#   kill $(lsof -ti tcp:${PORT:-3001})

set -uo pipefail

cd "$(dirname "$0")"
ROOT_DIR="$(pwd -P)"
WORKTREE_NAME="$(basename "$ROOT_DIR")"
PORT="${1:-${PORT:-3001}}"

# Diretório do checkout principal (para detectar worktree e dar mensagens úteis)
MAIN_DIR="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
MAIN_DIR="${MAIN_DIR%/.git}"
IS_WORKTREE=0
if [ -n "$MAIN_DIR" ] && [ "$MAIN_DIR" != "$ROOT_DIR" ]; then
  IS_WORKTREE=1
fi

# ---------------------------------------------------------------------------
# 1. Ambiente
# ---------------------------------------------------------------------------
# Um DATABASE_URL já exportado pelo usuário SEMPRE vence o .env.
PRE_DATABASE_URL="${DATABASE_URL:-}"

ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
ENV_SOURCE=""
ENV_DB_IGNORED=0

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  ENV_SOURCE="$ENV_FILE"
elif [ "$IS_WORKTREE" = "1" ] && [ -f "$MAIN_DIR/.env" ]; then
  # Worktree sem .env próprio: aproveitamos as chaves do checkout principal,
  # mas NUNCA o DATABASE_URL dele — foi assim que um agente abriu o dev.db real.
  set -a
  # shellcheck disable=SC1090
  source "$MAIN_DIR/.env"
  set +a
  ENV_SOURCE="$MAIN_DIR/.env (checkout principal — DATABASE_URL ignorado)"
  ENV_DB_IGNORED=1
  DATABASE_URL="$PRE_DATABASE_URL"
else
  ENV_SOURCE="(nenhum)"
fi

# Regra de ouro: DATABASE_URL exportado no ambiente nunca é sobrescrito pelo .env.
if [ -n "$PRE_DATABASE_URL" ] && [ "${DATABASE_URL:-}" != "$PRE_DATABASE_URL" ]; then
  DATABASE_URL="$PRE_DATABASE_URL"
  ENV_SOURCE="$ENV_SOURCE (DATABASE_URL do ambiente prevaleceu)"
fi
export DATABASE_URL="${DATABASE_URL:-}"

DB_ORIGIN="ambiente (export)"
if [ -z "$PRE_DATABASE_URL" ]; then
  DB_ORIGIN="$ENV_SOURCE"
fi

LOG_FILE="/tmp/reformaflow-api-${WORKTREE_NAME}-${PORT}.log"

# ---------------------------------------------------------------------------
# 2. Resumo ANTES de subir qualquer coisa
# ---------------------------------------------------------------------------
echo "── start-api ─────────────────────────────────────────────"
echo "  Diretório   : $ROOT_DIR$([ "$IS_WORKTREE" = "1" ] && echo "  (worktree de $MAIN_DIR)")"
echo "  .env        : $ENV_SOURCE"
echo "  DATABASE_URL: ${DATABASE_URL:-<vazio>}  [origem: $DB_ORIGIN]"
echo "  Porta       : $PORT"
echo "  Log         : $LOG_FILE"
echo "──────────────────────────────────────────────────────────"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "❌ DATABASE_URL não definido."
  if [ "$ENV_DB_IGNORED" = "1" ]; then
    echo "   Este é um worktree sem .env próprio. Por segurança, o DATABASE_URL do"
    echo "   checkout principal (que aponta para o dev.db REAL) foi ignorado."
  fi
  echo "   Escolha uma das opções:"
  echo "     export DATABASE_URL=\"file:$ROOT_DIR/prisma/dev.db\" && ./start-api.sh"
  echo "     echo 'DATABASE_URL=\"file:$ROOT_DIR/prisma/dev.db\"' >> $ROOT_DIR/.env"
  exit 1
fi

# Aviso alto quando um worktree está apontando para o banco do checkout principal.
# (worktrees vivem DENTRO do checkout principal, então checamos ROOT_DIR primeiro)
DB_PATH="${DATABASE_URL#file:}"
if [ "$IS_WORKTREE" = "1" ] && [ -n "$MAIN_DIR" ] \
   && [[ "$DB_PATH" == "$MAIN_DIR/"* ]] && [[ "$DB_PATH" != "$ROOT_DIR/"* ]]; then
  echo "⚠️  ATENÇÃO: você está em um worktree, mas o DATABASE_URL aponta para o banco"
  echo "    do checkout principal ($MAIN_DIR). Dados reais podem ser alterados."
  echo "    Continuando em 5s — Ctrl-C para abortar."
  sleep 5
fi

# ---------------------------------------------------------------------------
# 3. Porta: nunca matar processo alheio
# ---------------------------------------------------------------------------
OLD_PID="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null | head -1)"
if [ -n "$OLD_PID" ]; then
  OLD_CMD="$(ps -o command= -p "$OLD_PID" 2>/dev/null | head -1)"
  echo "❌ A porta $PORT já está ocupada pelo PID $OLD_PID:"
  echo "     $OLD_CMD"
  echo "   Pode ser a API de OUTRO agente/worktree — este script não mata nada."
  echo "   Opções:"
  echo "     PORT=$((PORT + 10)) ./start-api.sh     # subir em outra porta"
  echo "     kill $OLD_PID                          # se a API for sua"
  exit 1
fi

if [ ! -f "$ROOT_DIR/apps/api/dist/main.js" ]; then
  echo "❌ Build da API não encontrado em apps/api/dist/main.js."
  echo "   Rode: npx turbo run build --filter=@reformaflow/api"
  exit 1
fi

# ---------------------------------------------------------------------------
# 4. Subir
# ---------------------------------------------------------------------------
echo "Iniciando API..."
PORT="$PORT" node apps/api/dist/main > "$LOG_FILE" 2>&1 &
API_PID=$!
disown "$API_PID"

sleep 2

if kill -0 "$API_PID" 2>/dev/null && lsof -ti "tcp:$PORT" -sTCP:LISTEN > /dev/null 2>&1; then
  echo "✅ API rodando em http://localhost:$PORT (PID: $API_PID)"
  echo "   Logs: tail -f $LOG_FILE"
else
  echo "❌ Falha ao iniciar API. Últimas linhas do log:"
  tail -20 "$LOG_FILE"
  exit 1
fi
