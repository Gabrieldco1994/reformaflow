# Autocadastro e onboarding SaaS

## Configuração

- `AUTH_ENABLE_REGISTER="1"` habilita `POST /auth/register`; qualquer outro valor responde como rota indisponível.
- `AUTH_ENABLE_GUEST="1"` habilita o cadastro temporário e o fluxo de claim.
- `APP_MODE="demo"` habilita o seed idempotente de demonstração por tenant.
- `ALLOW_TENANT_OVERRIDE="0"` mantém o tenant preso ao JWT e é o valor obrigatório em produção.

## Cadastro público

`POST /auth/register` recebe:

```json
{
  "tenantName": "Minha empresa",
  "ownerName": "Maria",
  "username": "maria",
  "password": "mínimo 8 caracteres",
  "projectTypes": ["REFORMA", "PESSOAL"]
}
```

`projectTypes` aceita um ou mais valores únicos entre `REFORMA`, `COMPRA`, `CASA`, `CARRO`, `PESSOAL` e `PLANTAS`. O servidor cria tenant e usuário na mesma transação, normaliza o username e força o papel `USER`; o autocadastro nunca concede `ADMIN`.

## Gatilhos de Jornadas

O front emite dois gatilhos do motor genérico de Jornadas
(`packages/domain/src/config/journey-catalog.ts`, `JOURNEY_TRIGGER_TYPES`):

- `SIGNUP_COMPLETED`: `RegisterForm` chama `emitSignupCompleted()` logo após
  `register()` responder, antes de criar os projetos por objetivo.
- `PROJECT_CREATED`: tanto o cadastro quanto a criação manual em `projects/page.tsx`
  chamam `emitProjectsCreated(...)` após `refresh()`. O cadastro envia todos os projetos
  criados por objetivo numa só chamada; o runtime enfileira uma jornada por projeto.
  A jornada navega para a rota real do primeiro passo Completo (não há rota dedicada
  como no shell antigo).

Os dois consomem `useJourneyRuntime()` (`journey-runtime-context.tsx`).

O cadastro cria um projeto por objetivo selecionado, atualiza a sessão, emite os
gatilhos `PROJECT_CREATED` e redireciona para `/projects`; o runtime ativa e
enfileira as jornadas elegíveis.

## Objetivos

- `GET /auth/objectives`: retorna os tipos e módulos atuais do usuário autenticado.
- `PATCH /auth/objectives`: recebe `{ "projectTypes": ["CASA"] }` e substitui os objetivos do próprio usuário.
- `GET /auth/onboarding`: retorna o estado de onboarding/demo da sessão.

O PATCH exige ao menos um tipo válido e único. A ampliação libera os novos tipos imediatamente. A redução bloqueia projetos desses tipos sem apagar dados; reativar o tipo restaura o acesso.

### Autorização do PATCH (B0 #447)

`AuthService.updateSelfObjectives` roda inteiro dentro de UMA transação interativa do Prisma
(`$transaction`): lê o usuário, autoriza e grava — sem hiato em que outra requisição altere o
grant entre a checagem e o commit, e sem nenhuma checagem de autorização depois do write. Ordem
das checagens, dentro da transação:

1. Sessão inválida (usuário ausente, soft-deletado, ou tenant ausente/soft-deletado) → `401`.
2. `allowedProjects` corrompido — JSON ausente/vazio/malformado, não-array, ou array sem nenhum
   valor string → `401`. Mesmo parser fail-closed de `buildPublicUser`/`JwtStrategy.validate`
   (`parseGrantJson` em `apps/api/src/auth/grant-json.ts`); nunca degrada para `[]` (que seria lido
   como "sem restrição"). Esta checagem vence mesmo quando convidado/gerenciado também se
   aplicariam.
3. Conta convidada (`isGuest`) → `403`, mesmo com `role=ADMIN` — convidado nunca gerencia os
   próprios objetivos.
4. Conta gerenciada — `role` sem acesso pleno (isto é, diferente de `ADMIN`/legado `OWNER`) **e**
   `allowedProjects` válido e não-vazio (de fato restrita a projetos específicos por um admin) →
   `403`; só quem restringiu pode alterar.

Contas self-service (`role` sem acesso pleno com `allowedProjects=[]`, o wildcard) e contas de
acesso pleno (`ADMIN`/legado `OWNER`) continuam liberadas para o PATCH.

## Autorização

`allowedProjectTypes` é a autoridade canônica armazenada no usuário. `allowedModules` é sempre derivado no servidor por `deriveObjectiveAccess`, usando `TYPE_MODULES` em `packages/domain/src/config/type-modules.ts`.

Os mapas têm funções distintas:

- `TYPE_MODULES`: autorização compartilhada pela API e pelo contexto de autenticação.
- `PROJECT_FEATURES`: capacidade e exposição de funcionalidades na interface.

O acesso exige o tipo explicitamente permitido e um módulo não universal compatível. O módulo `dashboard`, isoladamente, nunca concede acesso a um tipo. Módulos compartilhados por tipos diferentes também não mantêm ativo um tipo removido.

O JWT identifica usuário e tenant, mas as permissões são recarregadas do banco em cada requisição. Assim, revogações têm efeito imediato. Administradores só listam e alteram usuários do tenant presente no JWT.

`allowedProjects`, `allowedModules` e `allowedProjectTypes` são as três colunas JSON de grant do
usuário. `AuthService.buildPublicUser` (login/sessão) e `JwtStrategy.validate` (cada requisição
autenticada) leem as três pelo mesmo parser fail-closed, `parseGrantJson`
(`apps/api/src/auth/grant-json.ts`): JSON ausente/vazio/malformado, não-array, ou array sem
nenhum valor string derruba a sessão inteira com `401` — nunca degrada silenciosamente para `[]`
(que os dois caminhos leem como "sem restrição"). Ver também a autorização do PATCH acima.
