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

O cadastro não cria projeto. Após autenticar, a web redireciona para `/projects?onboarding=1`, abre o modal e limita o primeiro projeto aos tipos escolhidos.

## Objetivos

- `GET /auth/objectives`: retorna os tipos e módulos atuais do usuário autenticado.
- `PATCH /auth/objectives`: recebe `{ "projectTypes": ["CASA"] }` e substitui os objetivos do próprio usuário.
- `GET /auth/onboarding`: retorna o estado de onboarding/demo da sessão.

O PATCH exige ao menos um tipo válido e único. A ampliação libera os novos tipos imediatamente. A redução bloqueia projetos desses tipos sem apagar dados; reativar o tipo restaura o acesso.

## Autorização

`allowedProjectTypes` é a autoridade canônica armazenada no usuário. `allowedModules` é sempre derivado no servidor por `deriveObjectiveAccess`, usando `TYPE_MODULES` em `packages/domain/src/config/type-modules.ts`.

Os mapas têm funções distintas:

- `TYPE_MODULES`: autorização compartilhada pela API e pelo contexto de autenticação.
- `PROJECT_FEATURES`: capacidade e exposição de funcionalidades na interface.

O acesso exige o tipo explicitamente permitido e um módulo não universal compatível. O módulo `dashboard`, isoladamente, nunca concede acesso a um tipo. Módulos compartilhados por tipos diferentes também não mantêm ativo um tipo removido.

O JWT identifica usuário e tenant, mas as permissões são recarregadas do banco em cada requisição. Assim, revogações têm efeito imediato. Administradores só listam e alteram usuários do tenant presente no JWT.

Ao adicionar `simulation` ao objetivo COMPRA, snapshots já persistidos devem ser
atualizados com `npm run backfill:compra-simulation`. O script considera apenas
usuários cujo `allowedProjectTypes` contém explicitamente `COMPRA`, preserva os
demais objetivos e é idempotente; use `npm run backfill:compra-simulation -- --dry-run`
para conferir a quantidade antes da execução.
