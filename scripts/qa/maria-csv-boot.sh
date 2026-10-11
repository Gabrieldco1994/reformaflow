#!/usr/bin/env bash
# Disposable Maria QA only. Never loads .env or starts against a default database.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
fail() { printf 'Maria CSV QA: %s\n' "$*" >&2; exit 1; }
: "${QA_RUNTIME_DIR:?Set an isolated absolute runtime directory}"
: "${QA_DB_PATH:?Set the disposable absolute SQLite path}"
: "${QA_VAULT_DIR:?Set the disposable absolute vault directory}"
: "${QA_ARTIFACTS_DIR:?Set the artifacts directory}"
export API_URL=${API_URL:-http://127.0.0.1:3011}
export WEB_URL=${WEB_URL:-http://127.0.0.1:3010}
# Resolve existing paths, reject symlinks/escapes and any dev.db before starting Node.
node - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.QA_RUNTIME_DIR;
if (!path.isAbsolute(root) || fs.realpathSync(root) !== root || root === '/')
  throw new Error('QA_RUNTIME_DIR must be canonical, isolated and absolute');
for (const key of ['QA_DB_PATH', 'QA_VAULT_DIR', 'QA_ARTIFACTS_DIR']) {
  const value = process.env[key];
  if (!path.isAbsolute(value) || fs.realpathSync(value) !== value || !value.startsWith(root + path.sep))
    throw new Error(`${key} must exist inside QA_RUNTIME_DIR without symlinks`);
}
if (path.basename(process.env.QA_DB_PATH) === 'dev.db' || !fs.statSync(process.env.QA_DB_PATH).isFile())
  throw new Error('Refusing a dev.db or non-file database');
NODE
export DATABASE_URL="file:$QA_DB_PATH"
export CORS_ORIGIN="$WEB_URL"
export NEXT_PUBLIC_API_URL="$API_URL"
export AUTH_ENABLE_REGISTER=1 AUTH_ENABLE_GUEST=0 ALLOW_TENANT_OVERRIDE=0
export NODE_ENV=development NEXT_TELEMETRY_DISABLED=1
# No production credentials/bootstrap or hosted-model keys. ANSWER uses ONLY the local loopback
# Ollama below (provider reads AGENT_LLM_PROVIDER, AGENT_MODEL, OLLAMA_BASE_URL). Hosted keys and
# any fallback provider are unset so a failure of the local model can never fall through silently.
unset ADMIN_USERNAME ADMIN_EMAIL ADMIN_PASSWORD GOOGLE_API_KEY GEMINI_API_KEY GROQ_API_KEY \
  CEREBRAS_API_KEY OLLAMA_API_KEY AGENT_LLM_FALLBACK AGENT_FALLBACK_MODEL
export QA_OLLAMA_HOST=${QA_OLLAMA_HOST:-127.0.0.1:11434}
model_lock="$ROOT/scripts/qa/maria-import-eval/model-lock.v1.json"
locked_model=$(node "$ROOT/scripts/qa/maria-import-eval-contract.cjs" model-name)
export QA_OLLAMA_MODEL=${QA_OLLAMA_MODEL:-$locked_model}
[[ "$QA_OLLAMA_MODEL" == "$locked_model" ]] || fail "QA_OLLAMA_MODEL must equal locked canonical model $locked_model"
export AGENT_LLM_PROVIDER=ollama AGENT_MODEL="$QA_OLLAMA_MODEL"
export OLLAMA_BASE_URL="http://$QA_OLLAMA_HOST/v1"
ollama_bin="$QA_RUNTIME_DIR/ollama/bin/ollama"
ollama_pid_file="$QA_ARTIFACTS_DIR/ollama.pid"
# Exact keys from vault.config.ts: only literal true enables the vault. No bypass flags.
export IMPORT_VAULT_ENABLED=true IMPORT_VAULT_LOCK_FD=9 VAULT_DIR="$QA_VAULT_DIR"
export IMPORT_VAULT_IDLE_TIMEOUT_MS=300000 IMPORT_VAULT_HEADROOM_BYTES=1048576
export IMPORT_VAULT_DRAIN_TIMEOUT_MS=5000
export UPLOADS_DIR="$QA_RUNTIME_DIR/public-uploads"
export PRIVATE_UPLOADS_DIR="$QA_RUNTIME_DIR/private-uploads"
# JWT_SECRET also derives the cursor signing key; there is no separate vault encryption key.
: "${JWT_SECRET:?Generate an ephemeral random JWT_SECRET before boot}"
api_pid_file="$QA_ARTIFACTS_DIR/api.pid"
web_pid_file="$QA_ARTIFACTS_DIR/web.pid"
port_for() {
  node -e 'const u = new URL(process.argv[1]); if (u.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(u.hostname) || !u.port) throw new Error("QA URLs must use explicit loopback HTTP ports"); console.log(u.port)' "$1"
}
free_port() {
  command -v lsof > /dev/null || fail 'lsof is required'
  if lsof -nP -iTCP:"$1" -sTCP:LISTEN > /dev/null; then
    fail "port $1 is occupied; refusing to reuse or kill another server"
  fi
}
wait_ready() {
  local url=$1 pid_file=$2 pid
  pid=$(cat "$pid_file")
  for ((attempt=0; attempt<120; attempt++)); do
    kill -0 "$pid" 2>/dev/null || fail "server PID $pid exited; inspect artifacts logs"
    if curl --silent --fail --max-time 3 "$url" > /dev/null; then return; fi
    sleep 2
  done
  fail "readiness timeout for $url"
}
ollama_env() {
  [[ "$QA_OLLAMA_HOST" =~ ^(127\.0\.0\.1|localhost):[0-9]+$ ]] || fail 'QA_OLLAMA_HOST must be loopback host:port'
  [[ -x "$ollama_bin" ]] || fail "verified Ollama binary missing: $ollama_bin"
  mkdir -p "$QA_RUNTIME_DIR/ollama-models" "$QA_RUNTIME_DIR/ollama-home"
  export OLLAMA_HOST="$QA_OLLAMA_HOST" OLLAMA_MODELS="$QA_RUNTIME_DIR/ollama-models" HOME="$QA_RUNTIME_DIR/ollama-home"
  # Modest CPU profile: one request, one resident model, 4k context, no telemetry/cloud features.
  # Per-request num_thread is not exposed by the OpenAI-compatible endpoint the provider uses.
  export OLLAMA_NUM_PARALLEL=1 OLLAMA_MAX_LOADED_MODELS=1 OLLAMA_CONTEXT_LENGTH=4096 OLLAMA_KEEP_ALIVE=30m
  export OLLAMA_NOPRUNE=1 OLLAMA_NO_CLOUD=1 OLLAMA_NOHISTORY=1
}
case "${1:-}" in
  ollama)
    ollama_env
    free_port "${QA_OLLAMA_HOST##*:}"
    printf 'Maria CSV Ollama · host=%s · model=%s · log=%s\n' "$QA_OLLAMA_HOST" "$QA_OLLAMA_MODEL" "$QA_ARTIFACTS_DIR/ollama.log"
    ( exec "$ollama_bin" serve ) > "$QA_ARTIFACTS_DIR/ollama.log" 2>&1 &
    printf '%s\n' "$!" > "$ollama_pid_file"
    ;;
  wait-ollama) wait_ready "http://$QA_OLLAMA_HOST/api/version" "$ollama_pid_file" ;;
  pull-model)
    ollama_env
    kill -0 "$(cat "$ollama_pid_file")" || fail 'Ollama is not running'
    "$ollama_bin" pull "$QA_OLLAMA_MODEL" 2>&1 | tee "$QA_ARTIFACTS_DIR/ollama-pull.log"
    ;;
  model-check)
    # Real API proof, no mocks: model listed, tool capability advertised, and one actual
    # completion through the exact endpoint/model the API provider will use. No fallback.
    kill -0 "$(cat "$ollama_pid_file")" || fail 'Ollama is not running'
    {
      node "$ROOT/scripts/qa/ollama-model-lock.cjs" verify "$model_lock" "$QA_ARTIFACTS_DIR/maria-model-provenance.json"
      node - <<"NODE"
const host = process.env.QA_OLLAMA_HOST, model = process.env.QA_OLLAMA_MODEL;
if (process.env.OLLAMA_BASE_URL !== "http://" + host + "/v1" || process.env.AGENT_LLM_PROVIDER !== "ollama" || process.env.AGENT_MODEL !== model)
  throw new Error("provider env does not match the locked loopback model under test");
(async () => {
  const res = await fetch("http://" + host + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, temperature: 0, max_tokens: 8, messages: [{ role: "user", content: "Reply with one word: ok" }] }), signal: AbortSignal.timeout(600000) });
  if (!res.ok) throw new Error("completion HTTP " + res.status);
  const chat = await res.json();
  const text = chat.choices?.[0]?.message?.content;
  if (chat.model !== model || typeof text !== "string" || !text.trim()) throw new Error("invalid locked-model completion");
  console.log("Ollama inference PASS: model=" + model + " response=non-empty");
})().catch(e => { console.error("Ollama inference FAIL:", e.message); process.exit(1); });
NODE
    } | tee "$QA_ARTIFACTS_DIR/ollama-model-check.log"
    ;;
  api)
    port=$(port_for "$API_URL")
    free_port "$port"
    [[ -f "$ROOT/apps/api/dist/main.js" ]] || fail 'build apps/api before boot'
    # Mirror vault-probe.ts/root.ts for ALL required nodes, not just existence.
    # "trash" has no leading dot; .trash is not the production vault layout.
    node - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const vault = process.env.VAULT_DIR;
const uid = process.geteuid();
for (const [name, kind, mode] of [['', 'dir', 0o700], ['t', 'dir', 0o700], ['trash', 'dir', 0o700], ['.lock', 'file', 0o600]]) {
  const target = path.join(vault, name);
  const stat = fs.lstatSync(target);
  const correctKind = kind === 'dir' ? stat.isDirectory() : stat.isFile();
  if (!correctKind || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o7777) !== mode || fs.realpathSync(target) !== target)
    throw new Error(`Invalid vault node ${target}: require ${kind}, owner ${uid}, mode ${mode.toString(8)}, canonical and no symlink`);
  console.log(`Vault preflight: ${name || 'root'} owner=${stat.uid} mode=${(stat.mode & 0o7777).toString(8)}`);
}
const related = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
for (const key of ['UPLOADS_DIR', 'PRIVATE_UPLOADS_DIR']) {
  const raw = process.env[key];
  const resolved = fs.realpathSync(raw);
  if (resolved !== raw || related(vault, resolved))
    throw new Error(`${key} must be canonical and disjoint from vault`);
}
NODE
    printf 'Maria CSV API · db=%s · port=%s · vault=%s · log=%s\n' "$QA_DB_PATH" "$port" "$VAULT_DIR" "$QA_ARTIFACTS_DIR/api.log"
    if [[ $(uname -s) == Linux ]]; then
      command -v flock > /dev/null || fail 'Linux util-linux flock is required'
    else
      printf 'Non-Linux probe: no lock emulation; vault MUST fail closed with NO_FDINFO.\n'
    fi
    (
      cd "$ROOT/apps/api"
      # FD 9 survives exec; locking the FD (not flock -c) preserves the Node PID for lsof.
      exec 9<>"$VAULT_DIR/.lock"
      if [[ $(uname -s) == Linux ]]; then flock --exclusive --nonblock 9; fi
      export PORT="$port"
      exec node dist/main.js
    ) > "$QA_ARTIFACTS_DIR/api.log" 2>&1 &
    printf '%s\n' "$!" > "$api_pid_file"
    ;;
  web)
    port=$(port_for "$WEB_URL")
    free_port "$port"
    printf 'Maria CSV web · db=%s · port=%s · vault=%s · API=%s\n' "$QA_DB_PATH" "$port" "$VAULT_DIR" "$API_URL"
    (
      cd "$ROOT/apps/web"
      exec node "$ROOT/node_modules/next/dist/bin/next" dev --hostname 127.0.0.1 --port "$port"
    ) > "$QA_ARTIFACTS_DIR/web.log" 2>&1 &
    printf '%s\n' "$!" > "$web_pid_file"
    ;;
  wait-api) wait_ready "$API_URL/auth/config" "$api_pid_file" ;;
  wait-web) wait_ready "$WEB_URL/login" "$web_pid_file" ;;
  gate)
    [[ $(uname -s) == Linux ]] || fail 'vault-enabled QA requires Linux fdinfo; macOS NO_FDINFO is intentional'
    pid=$(cat "$api_pid_file")
    kill -0 "$pid" || fail 'API is not running'
    # Health alone does not prove vault ON. Allow the five-second boot deadline to settle.
    sleep 6
    # vault-boot.ts emits vault_boot only for errors; settle({state: ON}) is silent.
    if grep -q 'vault_boot' "$QA_ARTIFACTS_DIR/api.log"; then
      fail 'vault boot reported an error; inspect api.log (never weaken the vault checks)'
    fi
    cat "/proc/$pid/fdinfo/9" > "$QA_ARTIFACTS_DIR/vault-fdinfo.log"
    grep -Eq '^lock:[[:space:]]+[0-9]+:[[:space:]]+FLOCK[[:space:]]+ADVISORY[[:space:]]+WRITE[[:space:]]' "$QA_ARTIFACTS_DIR/vault-fdinfo.log" || fail 'missing inherited Linux FLOCK WRITE proof'
    lsof -p "$pid" | grep '\.db' | tee "$QA_ARTIFACTS_DIR/sqlite-open-files.log"
    lsof -Fn -p "$pid" > "$QA_ARTIFACTS_DIR/api-open-files.log"
    node - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const names = fs.readFileSync(path.join(process.env.QA_ARTIFACTS_DIR, 'api-open-files.log'), 'utf8')
  .split('\n').filter(line => line.startsWith('n') && line.includes('.db')).map(line => line.slice(1));
const db = process.env.QA_DB_PATH;
if (!names.includes(db) || names.some(name => ![db, db+'-journal', db+'-wal', db+'-shm'].includes(name)))
  throw new Error('ABORT: API must have ONLY the disposable SQLite DB open: ' + JSON.stringify(names));
console.log('SQLite process gate PASS: ' + db);
NODE
    ;;
  stop)
    for file in "$web_pid_file" "$api_pid_file" "$ollama_pid_file"; do
      if [[ -f "$file" ]]; then
        pid=$(cat "$file")
        [[ "$pid" =~ ^[0-9]+$ ]] || fail 'invalid PID file'
        kill "$pid" 2>/dev/null || true
      fi
    done
    ;;
  *) fail 'usage: maria-csv-boot.sh ollama|wait-ollama|pull-model|model-check|api|web|wait-api|wait-web|gate|stop' ;;
esac
