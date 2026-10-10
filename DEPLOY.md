# Deploy gratuito — ReformaFlow

> **Deploy canônico é automático:** push no `main` roda o CI (`.github/workflows/ci.yml`) que testa, builda e faz `flyctl deploy` da API (job **Deploy API to Fly**); o web acompanha via Vercel. Antes de publicar, o job deve rejeitar SHA stale dentro do lock de deploy; depois, deve comprovar machine iniciada, health e SHA publicado. Os passos manuais abaixo servem para o **setup inicial** (criar app/volume/secrets) ou para deploy de emergência — no dia a dia, mergear no main já publica.

Stack escolhido (zero migração de DB, custo R$ 0/mês para uso pessoal/demo):

| Camada | Onde |
|---|---|
| **Web (Next.js)** | Vercel |
| **API (NestJS) + SQLite + uploads/** | Fly.io com volume persistente |

Sem cold-start. O DB e os arquivos enviados ficam num **volume Fly de 3 GB** (free) montado em `/data`.

---

## Passo 1 — Pré-requisitos

```bash
# Fly CLI
brew install flyctl   # ou: curl -L https://fly.io/install.sh | sh
flyctl auth signup    # ou: flyctl auth login

# Vercel CLI (opcional, dá pra fazer pela UI)
npm i -g vercel
vercel login
```

Você também vai precisar:

- Conta no GitHub (push do repo)
- Cartão no Fly.io (zera no free tier, mas exige cadastro)

---

## Passo 2 — Deploy da API (Fly.io)

A partir da **raiz do repo**:

```bash
# 1) Criar app + volume (uma vez só)
flyctl apps create reformaflow-api --org personal
flyctl volumes create reformaflow_data --region gru --size 3 --app reformaflow-api

# 2) Configurar secrets (NUNCA commitar)
flyctl secrets set --app reformaflow-api \
  JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
  ADMIN_USERNAME="<seu-usuario-admin>" \
  ADMIN_PASSWORD="<senha-forte-aqui>" \
  CORS_ORIGIN="https://SEU-DOMINIO.vercel.app"

# (opcional) IA de plantas
flyctl secrets set --app reformaflow-api GEMINI_API_KEY="..."

# 3) Deploy
flyctl deploy --app reformaflow-api -c apps/api/fly.toml --dockerfile apps/api/Dockerfile
```

Depois do deploy a API fica em **`https://reformaflow-api.fly.dev`**. Testa:

```bash
curl -sI https://reformaflow-api.fly.dev/api/docs
```

> Se mudar o nome do app no `fly.toml`, ajuste em todos os comandos acima.

### Migrations
O `entrypoint.sh` normal roda `prisma migrate deploy` antes de iniciar o NestJS. Portanto, migration
falha impede a API de subir; job de deploy verde, sozinho, não prova que a aplicação ficou disponível.

Antes de publicar uma migration sobre schema persistido:

1. valide o caminho de upgrade sobre fixture legada estruturalmente equivalente ou cópia sanitizada
   de backup, além do teste em banco fresco;
2. crie backup restaurável e teste o restore;
3. confirme inventário antes/depois e que o entrypoint normal termina com a API saudável.

### Release da entrada CSV da Maria

**Contrato aprovado em 2026-10-09; ainda não lançado.** Não marque a entrada produtiva como
entregue ou ativa antes de o runtime estar mergeado e a QA de release abaixo passar no ambiente
real.

O único controle de boot é `IMPORT_SESSION_INTAKE_MODE=off|csv`:

- variável ausente ou `off`: nenhuma nova entrada; histórico, resultado e recuperação de sessões
  existentes continuam disponíveis;
- `csv`: pode anunciar somente CSV de fatura de cartão quando toda a cadeia real estiver
  qualificada;
- qualquer outro valor: configuração inválida, com falha de boot. Não fazer fallback silencioso
  para `off`.

OFX, PDF, XLS, XLSX e imagens não entram neste rollout, mesmo que a imagem contenha seus
parsers/contratos. O catálogo versionado deve publicar disponibilidade ou um dos motivos tipados
`NOT_ENABLED`, `RUNTIME_UNAVAILABLE` e `NO_QUALIFIED_FORMAT`; indisponibilidade de nova entrada
não pode derrubar as rotas de histórico/resultado/recuperação.

#### Provider exigido para este rollout

O runtime geral ainda assume Ollama quando `AGENT_LLM_PROVIDER` está ausente. Esse default é
conveniente para desenvolvimento, mas **não qualifica a revisão guiada CSV**. Neste rollout, o
ambiente de release deve definir explicitamente:

```text
AGENT_LLM_PROVIDER=gemini
GEMINI_API_KEY=<secret no gerenciador do ambiente>
AGENT_MODEL=<modelo/revisão Gemini aprovado, quando houver pin disponível>
```

Não registrar o valor de `GEMINI_API_KEY` em arquivo, comando, log, evidência, screenshot ou
argumento de processo. `GEMINI_BASE_URL` só deve existir quando houver endpoint aprovado
deliberadamente; ausente, o runtime usa o endpoint Gemini previsto pelo provider. Um
`AGENT_LLM_FALLBACK` só pode ser habilitado depois de qualificação própria com os mesmos limites
de minimização, schema e ausência de tools de escrita; para a evidência baseline × candidate,
deixe fallback de modelo desabilitado para não misturar resultados.

Essa configuração habilita somente a interpretação opcional de texto/voz. Resposta estruturada,
adiamento, reativação, preparação, revisão ready-only, confirmação e recuperação continuam
determinísticos. Falta, rejeição, timeout, quota ou resposta inválida do Gemini deve produzir
fallback explícito e recuperável, preservar a sessão e manter os controles estruturados; nunca
gravar uma declaração, incluir item não pronto ou declarar sucesso.

#### Pré-requisitos bloqueantes

1. Banco de produção migrado **antes do boot** da nova API, com backup/restore e upgrade legado
   validados conforme a seção Migrations.
2. Prova do cofre e de seu ciclo de vida na imagem e no host **Linux reais** usados em produção;
   prova local, mock ou unidade de contrato não substitui esse gate.
3. Gemini explicitamente selecionado conforme acima, alcançável a partir da imagem real e
   verificado com credencial allowlisted já provisionada, sem stub.
4. Tenant real de QA, capability real e runtime real autorizados e saudáveis, preservando ACL,
   isolamento e os limites operacionais.
5. Nenhum override de teste, provider sintético, DI override ou fixture conta como evidência de
   release.
6. Smoke do catálogo e da jornada CSV real, incluindo consentimento documental separado da
   confirmação financeira e a preservação de histórico/resultado/recuperação com o intake em
   `off`.
7. Produção deve falhar o boot se `ALLOW_TENANT_OVERRIDE=1`; confirmar que a configuração
   publicada está ausente/`0` e que os testes do interceptor global estão verdes. Esta correção
   de segurança pode viver em entrega separada, mas bloqueia ativar `IMPORT_SESSION_INTAKE_MODE=csv`.

#### Evidência de teste × evidência de release

Testes de PR não usam segredo nem rede externa. Com banco/cofre descartáveis e dados sintéticos,
devem provar: controles estruturados sem chamada ao provider; contexto em português sem IDs;
adiar/recarregar/reativar/continuar; projeção do servidor contendo somente compras prontas;
confirmação financeira separada; minimização do payload; falhas seguras; e layout/hit-testing em
375/390/1280 px. Provider `qa-local`, stub, fixture, caminho determinístico, override de DI ou
teste que apenas verifica `isConfigured()` prova contrato/orquestração, não Gemini.

Para liberar, execute separadamente o eval **baseline × candidate** e um smoke opt-in na imagem e
no tenant reais. O runner recebe `GEMINI_API_KEY` já exportada pelo processo pai: não aceita
`ENV_FILE`, não executa `source`, não abre o `.env` compartilhado e não imprime valor, tamanho,
prefixo, sufixo ou hash da credencial. A evidência sanitizada registra somente configuração sem
segredo, provider/modelo resolvido, SHA, dataset/hashes, resultado e métricas permitidas.

O smoke precisa incluir ao menos uma resposta livre realmente interpretada pelo Gemini e os casos
de indisponibilidade/credencial rejeitada, timeout, quota e saída inválida. A chamada retorna
somente candidato: o operador ainda confere e usa a ação documental determinística. A captura
deve provar que nenhum ID estável, CSV bruto, outra compra, filename, total oculto, grant, nonce,
recibo ou tool operacional chegou ao provider. `CONTINUE`, `READ_RESULT`, controles estruturados
e abertura determinística da revisão podem funcionar sem Gemini e, por isso, não comprovam esse
gate.

#### Ordem obrigatória para o wire versionado

1. Manter a web atual compatível e o intake em `off` enquanto os pré-requisitos são preparados.
2. Aplicar migrations e publicar **primeiro a API**, com o wire versionado e o modo configurado
   explicitamente. Confirmar boot, health, SHA e catálogo no runtime real.
3. Só depois publicar a **web** consumidora da mesma versão do wire.
4. Executar a QA de release ponta a ponta no tenant real. Até ela passar, o status continua
   “aprovado, não entregue/ativo”.
5. Para contenção, voltar o modo para `off` e redeployar/reiniciar a API; confirmar que novas
   entradas sumiram e que histórico, resultado e recuperação continuam utilizáveis.

Para o rollback de releases que carregam migração aditiva com trilha e guards (ex.: **#569 PR1**, em
validação), o critério de reversão vive no design — ver §3.3 de
[docs/569-invoice-undo-design.md](docs/569-invoice-undo-design.md). Em resumo: rollback é forward-only,
exige um novo HEAD compatível (por `git revert` ou fix) que preserve a trilha e os guards e passe o
pipeline SHA-strict; uma imagem antiga sem os guards não serve como alvo de rollback, mesmo com o ramo
`matchedCard` desativado. O `DROP` destrutivo da tabela/colunas não está autorizado; as pré-condições
ficam no design.

#### Runbook de recuperação de migration falha

O CLI-fonte é `node scripts/normalize-external-id-duplicates.mjs`; como a imagem runtime não contém
`scripts/`, na machine ele será executado como `node /app/normalize-external-id-duplicates.mjs`,
sempre com `DATABASE_URL` explícita. O manifest gerado é **CONFIDENCIAL**, modo `0600`: contém IDs de
linhas e chaves de tenant/projeto/external ID. Nunca o anexe a issue/PR, publique, copie para logs ou
inclua em evidência. O script emite o SHA-256 completo para a operação privada; o resumo público pode
conter somente contagens e hash truncado, sem PII, caminho completo de backup, IDs/chaves ou hash
completo.

1. **Conter:** mantenha o entrypoint temporário sem migration; não restaure ainda o
   `prisma migrate deploy` automático.
2. **Backup:** gere backup timestampado, valide que pode ser restaurado e registre sua referência
   sanitizada em controle operacional separado; não altere o formato canônico do manifest.
3. **Quiescer (fail-safe nativo, `deploy/quiesce/`):** a janela **não** depende de o processo do
   operador continuar vivo. Substitua o comando da machine por `watchdog.sh` (mesmo caminho vetado de
   envio do script de recovery — ver passo 4). O `watchdog.sh` usa só `timeout` + `setsid` + `flock`:
   grava um **deadline absoluto uma única vez** em `/data/quiesce/deadline` (restart relê, nunca
   renova; restart com lock livre **colapsa** a janela e devolve o Node na hora), roda a cadeia do
   operador sob um **supervisor fora do process group da cadeia** que segura o `flock` (fd 9) durante
   toda a vida da cadeia e de qualquer descendente, e ao fim faz **TERM grupo → grace → KILL grupo**
   apenas do pgid conhecido (recolhe órfãos reparentados que o `timeout` deixa). O Node-direto só sobe
   **depois de adquirir esse mesmo lock** — Node e uma cadeia viva nunca tocam `/data/dev.db` juntos.
   Nada mais é sinalizado; o watchdog só mata um process group que ele mesmo criou.

   **NUNCA abra `sqlite3`, `prisma studio`, `node` ou qualquer cliente de banco na machine fora do
   `op-wrap` enquanto a janela estiver armada.** O lock só protege a cadeia supervisionada e o
   Node-direto; um writer manual fura o lock e pode corromper a recuperação. Todo toque no banco passa
   por `op-wrap dryrun` / `op-wrap apply`.

   Toda operação vai pelo `op-wrap` no diretório persistente `$QUIESCE_DIR`. `flyctl ssh console --command`
   não abre shell: comandos simples continuam diretos (`sha256sum`, `cat`, `rm -f`, `rmdir`) e qualquer
   `QUIESCE_DIR=...`, `&&`, `;`, loop, redirecionamento ou substituição de comando começa explicitamente
   com `sh -lc`/`sh -ceu`:
   - `op-wrap status` — `flyctl ssh console --app reformaflow-api --machine "$MACHINE_ID" --command "sh -lc 'QUIESCE_DIR=\"${QUIESCE_DIR}\" exec sh \"${QUIESCE_DIR}/op-wrap.sh\" status'"`
   - `op-wrap dryrun` — `flyctl ssh console --app reformaflow-api --machine "$MACHINE_ID" --command "sh -lc 'QUIESCE_DIR=\"${QUIESCE_DIR}\" exec sh \"${QUIESCE_DIR}/op-wrap.sh\" dryrun'"`
   - `op-wrap apply <sha256> <expected-groups> <expected-updates>` — `flyctl ssh console --app reformaflow-api --machine "$MACHINE_ID" --command "sh -lc 'QUIESCE_DIR=\"${QUIESCE_DIR}\" exec sh \"${QUIESCE_DIR}/op-wrap.sh\" apply \"$MANIFEST_SHA\" \"$EXPECTED_GROUPS\" \"$EXPECTED_UPDATES\"'"`; os três argumentos entram
     já expandidos localmente e citados
   - `op-wrap disarm` — pós-deploy: Node-direto assim que o lock ficar livre

   Não existe verbo para "cancelar uma cadeia em andamento": o `timeout` dentro do supervisor é a
   única cancelação automática.

   Se houver qualquer write fora do `op-wrap` ou perda de quiescência, descarte a aprovação e reinicie
   pelo dry-run. Detalhes e invariantes: `deploy/quiesce/README.md`.
4. **Fase 1 — Transferir e conferir watchdog.sh e op-wrap.sh (ANTES de machine update):**
   a imagem runtime não contém `scripts/` nem `deploy/`, e `machine update` pode resetar o rootfs. Use um
   diretório único persistente no volume (nunca `/app`, que é efêmero): por exemplo `/data/quiesce-<RECOVERY_RUN>`
   onde `RECOVERY_RUN` é um timestamp como `20260828T210456Z`. Extraia, valide o checksum SHA-256 de
   `watchdog.sh` e `op-wrap.sh` — ambos do HEAD exato do PR que passou nos testes —
   e só com ambos os checksums idênticos local **e** remoto proceda ao `machine update` com `--skip-health-checks`.

   ```bash
   PR_HEAD_TESTADO="<sha-completo-testado>"
   MACHINE_ID="<id-da-unica-machine>"
   PRIVATE_DIR="<diretorio-privado>"
   RECOVERY_RUN="$(date -u +%Y%m%dT%H%M%SZ)"
   QUIESCE_DIR="/data/quiesce-${RECOVERY_RUN}"
   install -d -m 0700 "$PRIVATE_DIR"

   git show "${PR_HEAD_TESTADO}:deploy/quiesce/watchdog.sh"   > /tmp/watchdog.sh
   git show "${PR_HEAD_TESTADO}:deploy/quiesce/op-wrap.sh"    > /tmp/op-wrap.sh
   chmod 0500 /tmp/watchdog.sh /tmp/op-wrap.sh

   # Transferir para o diretório persistente no volume
   flyctl ssh console --app reformaflow-api --machine "$MACHINE_ID" \
     --command "mkdir -p -- $QUIESCE_DIR" &&
   flyctl ssh console --app reformaflow-api --machine "$MACHINE_ID" \
     --command "chmod 0700 -- $QUIESCE_DIR"

   for f in watchdog.sh op-wrap.sh; do
     LOCAL_SHA="$(shasum -a 256 "/tmp/$f" | awk '{print $1}')"
     flyctl ssh sftp put "/tmp/$f" "$QUIESCE_DIR/$f" \
       -a reformaflow-api --machine "$MACHINE_ID" --mode 0500
     REMOTE_SHA="$(flyctl ssh console --app reformaflow-api --machine "$MACHINE_ID" \
       --command "sha256sum '$QUIESCE_DIR/$f'" | awk '{print $1}')"
     [ "$LOCAL_SHA" = "$REMOTE_SHA" ] || { echo "ABORT: checksum mismatch em $f ($LOCAL_SHA != $REMOTE_SHA)"; exit 1; }
     echo "$f  $LOCAL_SHA  OK"
   done
   ```

   O watchdog lê `QUIESCE_DIR` da env (default `/data/quiesce`) e `QUIESCE_MIN_ADMISSION`
   (default `600`). Produção não define nem reduz esse knob; mantenha o default 600. Defina a env da
   machine ou o comando implícito usa o default — neste runbook, exporte a env antes:

   ```bash
   flyctl machine update "$MACHINE_ID" --app reformaflow-api \
     --skip-health-checks \
     --env "QUIESCE_DIR=${QUIESCE_DIR}" \
     --machine-config '{"init":{"entrypoint":null,"cmd":["sh","'"${QUIESCE_DIR}"'/watchdog.sh"]}}' --yes
   ```

   Só depois de ambos conferirem, arme a machine **com `--skip-health-checks`** (o watchdog
   não serve HTTP; uma verificação de health falharia).

4.1. **Verificação pós-arm — Confirmar watchdog ativo e API quiescida:**

    Antes de enviar o normalizer, capture o JSON uma única vez e valide a machine:

    ```bash
    MACHINE_JSON="$(flyctl machines list --json --app reformaflow-api)"
    printf '%s\n' "$MACHINE_JSON" | jq -e --arg id "$MACHINE_ID" --arg q "$QUIESCE_DIR" '
      length == 1 and
      .[0].id == $id and
      .[0].state == "started" and
      .[0].config.init.cmd == ["sh", ($q + "/watchdog.sh")] and
      .[0].config.env.QUIESCE_DIR == $q
    ' >/dev/null || {
      flyctl machine update "$MACHINE_ID" --app reformaflow-api \
        --machine-config '{"init":{"entrypoint":["/usr/local/bin/node"],"cmd":["apps/api/dist/main.js"]}}' --yes
      flyctl checks list --json --app reformaflow-api | jq -e --arg id "$MACHINE_ID" '
        has($id) and (keys | length == 1) and (.[$id] | length == 1) and (.[$id][0].status == "passing")
      ' >/dev/null || { echo "ABORT: emergency restore did not return health"; exit 1; }
      echo "ABORT: machine does not match expected watchdog config" >&2
      exit 1
    }

    flyctl ssh console --app reformaflow-api --machine "$MACHINE_ID" \
      --command "sh -lc 'QUIESCE_DIR=\"${QUIESCE_DIR}\" exec sh \"${QUIESCE_DIR}/op-wrap.sh\" status'" || {
      flyctl machine update "$MACHINE_ID" --app reformaflow-api \
        --machine-config '{"init":{"entrypoint":["/usr/local/bin/node"],"cmd":["apps/api/dist/main.js"]}}' --yes
      flyctl checks list --json --app reformaflow-api | jq -e --arg id "$MACHINE_ID" '
        has($id) and (keys | length == 1) and (.[$id] | length == 1) and (.[$id][0].status == "passing")
      ' >/dev/null || { echo "ABORT: emergency restore did not return health"; exit 1; }
      echo "ABORT: watchdog not confirmed operational or API not quiesced" >&2
      exit 1
    }

    flyctl ssh console --app reformaflow-api --machine "$MACHINE_ID" --command "sh -ceu '
      Q=\"${QUIESCE_DIR}\"
      [ -s \"\$Q/deadline\" ] || exit 1
      [ -e \"\$Q/lock\" ] || exit 1
      [ -f \"\$Q/watchdog.log\" ] || exit 1
      watchdog_found=0
      node_direct_found=0
      for cmdline in /proc/[0-9]*/cmdline; do
        [ -r \"\$cmdline\" ] || continue
        set -- \$(tr \"\\0\" \"\\n\" < \"\$cmdline\")
        argv0=\${1:-}
        argv1=\${2:-}
        case \"\$argv0\" in
          sh|/bin/sh)
            [ \"\$argv1\" = \"\$Q/watchdog.sh\" ] && watchdog_found=1
            ;;
        esac
        if [ \"\$argv0\" = \"/usr/local/bin/node\" ] && [ \"\$argv1\" = \"apps/api/dist/main.js\" ]; then
          node_direct_found=1
        fi
      done
      [ \"\$watchdog_found\" -eq 1 ] || exit 1
      [ \"\$node_direct_found\" -eq 0 ] || exit 1
    '" || {
      flyctl machine update "$MACHINE_ID" --app reformaflow-api \
        --machine-config '{"init":{"entrypoint":["/usr/local/bin/node"],"cmd":["apps/api/dist/main.js"]}}' --yes
      flyctl checks list --json --app reformaflow-api | jq -e --arg id "$MACHINE_ID" '
        has($id) and (keys | length == 1) and (.[$id] | length == 1) and (.[$id][0].status == "passing")
      ' >/dev/null || { echo "ABORT: emergency restore did not return health"; exit 1; }
      echo "ABORT: watchdog not confirmed operational or API not quiesced" >&2
      exit 1
    }
    echo "✓ Watchdog confirmed active, API quiesced"
    ```

    **Notas:**
    - Sem verificação de health HTTP enquanto armado
    - A machine está no estado de quiesce esperado: a cadeia pode rodar, Node-direto aguarda
    - Verificação de processo via `/proc/*/cmdline` usando `tr '\0' '\n'` (read-only, sem varredura por PID)
    - Só então proceda à Fase 2

4.2. **Transferir e conferir o normalizer (APÓS a validação pós-arm):**
   Após a verificação pós-arm acima confirmar que o watchdog está ativo e a API continua quiescida,
   transferir o normalizer:

   ```bash
   git show "${PR_HEAD_TESTADO}:scripts/normalize-external-id-duplicates.mjs" > /tmp/normalize-external-id-duplicates.mjs
   chmod 0500 /tmp/normalize-external-id-duplicates.mjs

   LOCAL_SHA="$(shasum -a 256 /tmp/normalize-external-id-duplicates.mjs | awk '{print $1}')"
   flyctl ssh sftp put /tmp/normalize-external-id-duplicates.mjs /app/normalize-external-id-duplicates.mjs \
     -a reformaflow-api --machine "$MACHINE_ID" --mode 0500
   REMOTE_SHA="$(flyctl ssh console --app reformaflow-api --machine "$MACHINE_ID" \
     --command "sha256sum /app/normalize-external-id-duplicates.mjs" | awk '{print $1}')"
   [ "$LOCAL_SHA" = "$REMOTE_SHA" ] || { echo "ABORT: checksum mismatch em normalizer ($LOCAL_SHA != $REMOTE_SHA)"; exit 1; }
   echo "normalizer  $LOCAL_SHA  OK"
   ```

   Registre `RECOVERY_RUN` e `QUIESCE_DIR` apenas na operação privada. Não copie o repositório inteiro
   nem instale dependências: `createRequire` resolve o `@prisma/client` já existente em `/app/node_modules`.
5. **Dry-run final:** com o `watchdog.sh` armado, emita o dry-run **por `op-wrap dryrun`**, o único
   toque autorizado no banco. O `op-wrap` gera um caminho de manifest novo desta tentativa (dentro de
   `$QUIESCE_DIR`), o imprime (`manifest=<caminho>`) e a **cadeia supervisionada** publica
   `$QUIESCE_DIR/manifest.current` apontando para ele **somente se o normalizer sair com 0** (fail-
   closed: normalizer que falha ou é morto não deixa `manifest.current` novo nem ponteiro parcial).
   Nunca rode o normalizer à mão numa janela armada. Baixe **exatamente** o manifest apontado por
   `$QUIESCE_DIR/manifest.current`, nunca um caminho inventado em `/tmp`.

   ```bash
   LOCAL_MANIFEST="$PRIVATE_DIR/manifest-local-$(date -u +%Y%m%dT%H%M%SZ).json"
   flyctl ssh console --app reformaflow-api --machine "$MACHINE_ID" \
     --command "sh -lc 'QUIESCE_DIR=\"${QUIESCE_DIR}\" exec sh \"${QUIESCE_DIR}/op-wrap.sh\" dryrun'"
   # aguarde a cadeia concluir (op-wrap status via sh -lc -> last rc = 0), então:
   REMOTE_MANIFEST="$(flyctl ssh console --app reformaflow-api --machine "$MACHINE_ID" \
     --command "cat '$QUIESCE_DIR/manifest.current'")"
   flyctl ssh sftp get "$REMOTE_MANIFEST" "$LOCAL_MANIFEST" \
     --app reformaflow-api --machine "$MACHINE_ID"
   chmod 0600 "$LOCAL_MANIFEST"
   ```

   Registre privadamente o SHA-256 completo e as contagens `expectedGroups`/`expectedUpdates` emitidas.
   O dry-run não escreve no banco. Guarde a cópia baixada em armazenamento privado; nunca anexe o
   manifest.

6. **Revisar:** compare inventário, escopo e invariantes do manifest. Pare se houver mutação de linha
   ativa, mudança fora do escopo ou diferença entre os inventários do dry-run e do backup.

7. **Normalize/apply:** ainda sem writers, use exatamente o hash completo e contagens aprovados no
   dry-run. O `op-wrap apply` reusa o mesmo manifest do dry-run (`$QUIESCE_DIR/manifest.current`) e
   enfileira `normalize --apply && migrate resolve && migrate deploy` numa única cadeia supervisionada:

   ```bash
   MANIFEST_SHA="<sha256-completo-privado>"
   EXPECTED_GROUPS="<contagem-aprovada>"
   EXPECTED_UPDATES="<contagem-aprovada>"
   flyctl ssh console --app reformaflow-api --machine "$MACHINE_ID" \
     --command "sh -lc 'QUIESCE_DIR=\"${QUIESCE_DIR}\" exec sh \"${QUIESCE_DIR}/op-wrap.sh\" apply \"$MANIFEST_SHA\" \"$EXPECTED_GROUPS\" \"$EXPECTED_UPDATES\"'"
   # acompanhe: op-wrap status via sh -lc  (op ... RUNNING -> last rc)
   ```

   Preserve o manifest `0600` apenas no armazenamento operacional privado.

8. **Resolve:** faz parte da cadeia do `op-wrap apply` (`prisma migrate resolve --rolled-back`), que só
   roda **após** o `normalize --apply` retornar 0 — a tentativa falha nunca é marcada como aplicada
   antes de o SQL concluir. Confira o estado real da migration no `op-wrap status` / log.

9. **Migrate:** também na mesma cadeia (`prisma migrate deploy`, só após o resolve). Confirme que a
   migration consta como aplicada (`last rc` = 0) e só então encerre a janela sem writers.

10. **Disarm:** rode `op-wrap disarm`; o `watchdog.sh` sobe o Node-direto assim que o lock ficar livre
   (ou já teria subido pelo deadline absoluto / por um restart com lock livre).

11. **Restaurar entrypoint:** depois que o `op-wrap apply` retornar `rc 0` e a migration/índices
   tiverem sido validados, limpe o override **sem** `--skip-health-checks` e espere a saúde:

   ```bash
   flyctl machine update "$MACHINE_ID" --app reformaflow-api \
     --machine-config '{"init":{"entrypoint":null,"cmd":null}}' --yes

   MACHINE_JSON="$(flyctl machines list --json --app reformaflow-api)"
   printf '%s\n' "$MACHINE_JSON" | jq -e --arg id "$MACHINE_ID" '
     length == 1 and
     .[0].id == $id and
     .[0].state == "started" and
     (.[0].config.init.entrypoint // null) == null and
     (.[0].config.init.cmd // null) == null
   ' >/dev/null || { echo "ABORT: machine did not recover after restore"; exit 1; }

   CHECKS_JSON="$(flyctl checks list --json --app reformaflow-api)"
   printf '%s\n' "$CHECKS_JSON" | jq -e --arg id "$MACHINE_ID" '
     has($id) and (keys | length == 1) and (.[$id] | length == 1) and (.[$id][0].status == "passing")
   ' >/dev/null || { echo "ABORT: machine checks are not exactly one passing check"; exit 1; }

   docs_code="$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' https://reformaflow-api.fly.dev/api/docs-json)"
   auth_code="$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' https://reformaflow-api.fly.dev/auth/me)"
   [ "$docs_code" = 200 ] || { echo "ABORT: /api/docs-json returned $docs_code"; exit 1; }
   [ "$auth_code" = 401 ] || { echo "ABORT: /auth/me returned $auth_code"; exit 1; }

   flyctl logs --no-tail --machine "$MACHINE_ID" --app reformaflow-api
   ```

   O Dockerfile `CMD` volta então a governar e o boot migrate-first fica comprovado pelo override
   limpo, pelas migrations/índices validados e pela API saudável.

12. **Encerrar:** preserve primeiro as evidências. Capture o path do manifest remoto antes de qualquer
   limpeza:
   ```bash
   REMOTE_MANIFEST="$(flyctl ssh console --app reformaflow-api --machine "$MACHINE_ID" \
     --command "cat '$QUIESCE_DIR/manifest.current'" 2>/dev/null || echo)"
   # Preserve REMOTE_MANIFEST in your operational evidence store (mode 0600, separate from this runbook)
   ```

   Valide que `QUIESCE_DIR` segue o formato esperado e `REMOTE_MANIFEST` é um filho de `QUIESCE_DIR`:

   ```bash
   case "$QUIESCE_DIR" in
     /data/quiesce-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
     *) echo "ABORT: QUIESCE_DIR format invalid: $QUIESCE_DIR"; exit 1 ;;
   esac
   case "$REMOTE_MANIFEST" in
     "$QUIESCE_DIR"/manifest.*.json) ;;
     *) echo "ABORT: REMOTE_MANIFEST not in $QUIESCE_DIR or wrong format: $REMOTE_MANIFEST"; exit 1 ;;
   esac
   ```

   Depois do entrypoint normal estar ativo, remova o normalizer de `/app` (tolerante após reset do
   rootfs):

   ```bash
   flyctl ssh console --app reformaflow-api --machine "$MACHINE_ID" \
     --command "rm -f -- /app/normalize-external-id-duplicates.mjs"
   ```

   Então remova da machine os caminhos efêmeros exatos do `QUIESCE_DIR`, sem wildcard e sem `rm -rf`:

   ```bash
   flyctl ssh console --app reformaflow-api --machine "$MACHINE_ID" \
     --command "rm -f -- $QUIESCE_DIR/watchdog.sh $QUIESCE_DIR/op-wrap.sh $REMOTE_MANIFEST $QUIESCE_DIR/manifest.current $QUIESCE_DIR/deadline $QUIESCE_DIR/lock $QUIESCE_DIR/RUN $QUIESCE_DIR/RUN.active $QUIESCE_DIR/DISARM $QUIESCE_DIR/op.pgid $QUIESCE_DIR/op.pgid.raw $QUIESCE_DIR/op.rc $QUIESCE_DIR/.publish.lock $QUIESCE_DIR/watchdog.log $QUIESCE_DIR/op.log" &&
   flyctl ssh console --app reformaflow-api --machine "$MACHINE_ID" \
     --command "rmdir -- $QUIESCE_DIR"
   ```

   O comando é fail-closed: qualquer arquivo inesperado que reste no volume faz `rmdir` falhar e
   aborta a limpeza. Nada — scripts, manifest confidencial, deadline, lock, logs ou artefatos da
   janela — pode permanecer no rootfs ou no volume depois da recuperação.

Não adicione `[processes] app="/entrypoint.sh"` ao `fly.toml`: isso não remove o override por machine.
O `http_service.processes = ["app"]` existente basta depois que SRE limpa `init.entrypoint` e
`init.cmd`.

### Bootstrap admin
O `main.ts` cria o admin a partir das envs `ADMIN_USERNAME`/`ADMIN_PASSWORD` em cada start (idempotente — se já existir, só sincroniza senha).

---

## Passo 3 — Deploy do Web (Vercel)

### Pela UI (recomendado)

1. Push o repo pro GitHub.
2. https://vercel.com/new → "Import Project" → escolha o repo.
3. **Root Directory**: `apps/web`
4. Framework: Next.js (detecta sozinho).
5. **Environment Variables**:
   - `NEXT_PUBLIC_API_URL` = `https://reformaflow-api.fly.dev`
6. Deploy.

### Pela CLI

```bash
cd apps/web
vercel link    # primeira vez
vercel env add NEXT_PUBLIC_API_URL production
# cole: https://reformaflow-api.fly.dev
vercel --prod
```

Vai sair um domínio tipo `reformaflow-xyz.vercel.app`.

---

## Passo 4 — Finalizar CORS

Depois que souber o domínio Vercel definitivo, **volte e ajuste o CORS_ORIGIN** da API:

```bash
flyctl secrets set --app reformaflow-api \
  CORS_ORIGIN="https://reformaflow-xyz.vercel.app"
```

Aceita lista separada por vírgula se quiser permitir preview deploys:

```bash
flyctl secrets set --app reformaflow-api \
  CORS_ORIGIN="https://reformaflow.vercel.app,https://reformaflow-git-main-<usuario>.vercel.app"
```

---

## Cookies cross-domain (já configurado)

Em `NODE_ENV=production`, o auth controller usa:
- `sameSite: 'none'` (permite cross-site)
- `secure: true` (exigido pelo browser para sameSite=none)

`trust proxy=1` está ativado no `main.ts` pra Express reconhecer o HTTPS passado pelo Fly.

Se for testar no Safari/iOS, garanta que ambos (web e API) estão em HTTPS — local não vai funcionar com `secure=true`.

---

## Comandos úteis

```bash
# Logs em tempo real
flyctl logs --app reformaflow-api

# SSH na máquina (acessa o volume)
flyctl ssh console --app reformaflow-api
# dentro: ls /data, sqlite3 /data/dev.db ".tables", etc.

# Backup do SQLite via SSH
flyctl ssh console --app reformaflow-api -C "sqlite3 /data/dev.db .dump" > backup-$(date +%F).sql

# Restart
flyctl apps restart reformaflow-api

# Re-deploy
flyctl deploy --app reformaflow-api -c apps/api/fly.toml --dockerfile apps/api/Dockerfile
```

---

## Custo

- **Vercel Hobby**: gratuito (100 GB tráfego/mês).
- **Fly.io**: 1 VM shared-cpu-1x 512 MB **sempre ligada** (`min_machines_running = 1`, `auto_stop_machines = "off"`) — trocado do modo suspend/resume (`min_machines_running = 0`) porque este último causava lentidão/timeouts intermitentes reais em produção ao "acordar" a máquina sob tráfego real. Isso sai do free allowance (256 MB) e gera cobrança proporcional — defina um spend limit em https://fly.io/dashboard/<org>/billing.

---

## Troubleshooting

**Deployment checklist (documentado — executado por Copilot CLI)**

1. Commit e push para branch `main` (ex.: `git push origin main`). Pre-commit hooks rodam TypeScript checks em `packages/domain`, `apps/api`, `apps/web` (bloqueiam commit se falhar). Veja `package.json` scripts e hooks.
2. Se o push falhar por permissão (403), rodar: `unset GH_TOKEN && gh auth switch -u <your-github-username>` e então `git push origin main`.
3. O GitHub Actions `CI` é disparado automaticamente. Verificar status: `gh run list --repo <owner>/<repo> --branch main` e `gh run view <run-id>` para log.
4. No job de deploy, o lock de concorrência apenas serializa execuções: já dentro dele e imediatamente
   antes de publicar, compare o SHA completo do run com o SHA completo atual de `main`. Se divergir,
   encerre como stale sem chamar o deploy. Mantenha `cancel-in-progress: false`.
5. Vercel detecta push e inicia deploy automático (se projeto conectado). Verificar no painel Vercel ou `vercel --prod`/`vercel ls` com CLI autenticada.
6. Após deploy, validar:
   - `flyctl machine list` retorna exatamente uma machine, com `state=started` e
     `.[0].image_ref.labels.GH_SHA == GITHUB_SHA`;
   - `flyctl checks list` retorna exatamente um check `passing` para o ID dessa machine;
   - a release mais recente está `complete`; remova o sufixo `@digest` de `machine.config.image` e
     compare o valor normalizado com o `ImageRef` da release;
   - `curl` em `/api/docs-json` retorna 200 e em `/auth/me` retorna 401.
   Machine `stopped` ou qualquer divergência bloqueia a release, mesmo que o job esteja verde. O SHA
   já vem de `image_ref.labels.GH_SHA`: não crie `/health` nem build arg para expô-lo.
7. Depois dos checks e smokes, compare novamente o SHA completo do run com o SHA completo atual de
   `main`. Se `main` avançou durante o deploy, falhe o gate pós-smokes: a release não pode ficar verde.
8. Se algo falhar, ver logs do GitHub Actions (build) e Fly/Vercel logs (flyctl logs / Vercel UI).

> **Cicatriz de 2026-08-28 (#629):** um deploy antigo terminou depois do novo e sobrescreveu `main`;
> outro deploy verde aceitou uma machine `stopped`; e a migration de #570 falhou sobre dados legados,
> impedindo o entrypoint de subir a API por cerca de 35 horas. Lock não garante ordem, banco fresco
> não representa upgrade real e sucesso do comando de deploy não substitui health + SHA.

> Observação de segurança: nunca comitar tokens ou secrets. Use `flyctl secrets set` e `vercel env add`.


**"Database locked" no Fly**
- SQLite não suporta múltiplas réplicas. Mantenha `min_machines_running = 0` ou `1` (nunca 2+).

**Cookies não persistem entre web → API**
- Conferir `CORS_ORIGIN` no Fly inclui exatamente o domínio do Vercel (incluindo o `https://`).
- Conferir que está em HTTPS dos dois lados (browser bloqueia `sameSite=none` sem `secure`).

**"Module not found: @reformaflow/domain" no build**
- A pasta `packages/domain` precisa estar no contexto do Docker build. O `.dockerignore` na raiz já está liberando — só não exclua a pasta.

**Volume ficou sem espaço**
- `flyctl volumes extend <id> --size 10` (até 3 GB grátis; acima cobra USD 0.15/GB/mês).
