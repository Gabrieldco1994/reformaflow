import { ForbiddenException } from "@nestjs/common";
import { ExecutionContext } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import {
  deriveObjectiveAccess,
  ProjectType,
  reconcileUserModules,
} from "@reformaflow/domain";
import { AuthService } from "./auth.service";
import { parseGrantJson } from "./grant-json";
import { RolesGuard } from "../common/guards/roles.guard";
import { ModulesGuard } from "../common/guards/modules.guard";
import { ROLES_KEY } from "../common/decorators/roles.decorator";
import { MODULE_KEY } from "../common/decorators/require-module.decorator";

/**
 * #505 — o convidado de demonstração precisa ser CUNHADO honesto.
 *
 * Antes deste programa `registerGuest` gravava `role: 'ADMIN'` sem nenhum
 * grant. Como `isFullAccessRole(role)` recebe só uma string, ele
 * ESTRUTURALMENTE não consegue ler `isGuest`: todo consumidor a jusante
 * (RolesGuard, ModulesGuard, ProjectAccessGuard, project.service,
 * agent-tools, e o `isAdmin` do `auth-context` no web) estava certo sobre o
 * que recebeu e errado sobre a realidade.
 *
 * A correção é no ponto de cunhagem, não nos ~15 consumidores: se a
 * identidade diz a verdade, todos eles acertam sem serem editados.
 *
 * Este spec exercita a identidade REAL — o objeto é montado a partir da linha
 * que `registerGuest` grava, passando pela MESMA reconciliação que
 * `JwtStrategy.validate` aplica —, não um literal escrito à mão que poderia
 * divergir da produção sem ninguém notar.
 */

/** Espelha `JwtStrategy.validate`: linha do banco → `request.user`. */
function mintRequestUser(row: {
  role: string;
  isGuest: boolean;
  allowedModules?: string;
  allowedProjectTypes?: string;
  allowedProjects?: string;
}) {
  const modulesGrant = parseGrantJson(row.allowedModules ?? "[]");
  const typesGrant = parseGrantJson(row.allowedProjectTypes ?? "[]");
  const projectsGrant = parseGrantJson(row.allowedProjects ?? "[]");
  if (!modulesGrant.valid || !typesGrant.valid || !projectsGrant.valid) {
    throw new Error("grant inválido");
  }
  return {
    id: "u-guest",
    tenantId: "t-guest",
    role: row.role,
    isGuest: row.isGuest,
    allowedModules: reconcileUserModules(
      modulesGrant.values,
      typesGrant.values,
    ),
    allowedProjects: projectsGrant.values,
    allowedProjectTypes: typesGrant.values,
  };
}

function context(user: unknown, projectId?: string): ExecutionContext {
  return {
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: () => ({
      getRequest: () => ({ user, params: projectId ? { projectId } : {} }),
    }),
  } as unknown as ExecutionContext;
}

function reflectorFor(key: symbol | string, value: unknown) {
  return {
    getAllAndOverride: jest.fn((requested: unknown) =>
      requested === key ? value : undefined,
    ),
  } as never;
}

describe("#505 — identidade do convidado de demonstração", () => {
  let prisma: any;
  let service: AuthService;
  let guestRow: any;

  beforeEach(async () => {
    prisma = { $transaction: jest.fn() };
    service = new AuthService(prisma, {} as JwtService);
    process.env["AUTH_ENABLE_GUEST"] = "1";

    prisma.$transaction.mockImplementation(async (cb: (tx: any) => unknown) => {
      const tx = {
        tenant: {
          create: jest.fn().mockResolvedValue({ id: "t-guest" }),
        },
        user: {
          create: jest.fn().mockImplementation(({ data }: { data: any }) => {
            guestRow = data;
            return Promise.resolve({ id: "u-guest", ...data });
          }),
        },
      };
      return cb(tx);
    });

    await service.registerGuest({ tenantName: "Guest Tenant" });
  });

  afterEach(() => {
    delete process.env["AUTH_ENABLE_GUEST"];
  });

  it("nasce com papel SEM acesso total — papel não pode ser a chave do convidado", () => {
    expect(guestRow.isGuest).toBe(true);
    expect(guestRow.role).not.toBe("ADMIN");
    expect(guestRow.role).not.toBe("OWNER");
  });

  it("nasce com os grants de PESSOAL+REFORMA derivados da fonte de autorização", () => {
    // A demonstração (`demo.service.seedTenant`) semeia exatamente estes dois
    // tipos. Os módulos vêm de `deriveObjectiveAccess` (TYPE_MODULES), nunca
    // de uma lista literal escrita aqui.
    const expected = deriveObjectiveAccess([
      ProjectType.PESSOAL,
      ProjectType.REFORMA,
    ]);
    expect(JSON.parse(guestRow.allowedProjectTypes)).toEqual(
      expected.allowedProjectTypes,
    );
    expect(JSON.parse(guestRow.allowedModules)).toEqual(
      expected.allowedModules,
    );
  });

  it("recebe um menu NÃO-VAZIO — endurecer sem grants seria beco sem saída", () => {
    const user = mintRequestUser(guestRow);
    expect(user.allowedModules.length).toBeGreaterThan(0);
    expect(user.allowedModules).toContain("expenses");
  });

  it("é RECUSADO por RolesGuard numa rota @Roles(ADMIN)", () => {
    const guard = new RolesGuard(reflectorFor(ROLES_KEY, ["ADMIN"]));
    expect(() => guard.canActivate(context(mintRequestUser(guestRow)))).toThrow(
      ForbiddenException,
    );
  });

  it("é RECUSADO por ModulesGuard num módulo fora dos seus grants", async () => {
    // `financing` pertence a COMPRA/CARRO — fora de PESSOAL+REFORMA.
    const guard = new ModulesGuard(reflectorFor(MODULE_KEY, ["financing"]), {
      project: { findFirst: jest.fn() },
    } as never);
    await expect(
      guard.canActivate(context(mintRequestUser(guestRow))),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("é ACEITO por ModulesGuard num módulo que a demonstração promete", async () => {
    const guard = new ModulesGuard(reflectorFor(MODULE_KEY, ["expenses"]), {
      project: { findFirst: jest.fn().mockResolvedValue({ type: "REFORMA" }) },
    } as never);
    await expect(
      guard.canActivate(context(mintRequestUser(guestRow), "p-1")),
    ).resolves.toBe(true);
  });
});

/**
 * #505 — trava de regressão para as TRÊS contas reais de produção.
 *
 * Medido em produção (volume Fly `/data/dev.db`, 2026-08-20): 200 usuários,
 * 0 convidados, e **3 contas ADMIN/OWNER com `allowedModules` vazio**. Essas
 * três enxergam o aplicativo APENAS pelo curto-circuito de papel.
 *
 * Se alguém amanhã "consertar" o convidado chaveando por grant vazio em vez de
 * por `isGuest`, estas três contas perdem o menu inteiro. Este teste falha
 * antes disso chegar em produção.
 */
describe("#505 — ADMIN real com grants vazios NÃO pode ser confundido com convidado", () => {
  const realAdminWithoutGrants = {
    id: "u-admin",
    tenantId: "t-1",
    role: "ADMIN",
    isGuest: false,
    allowedModules: [],
    allowedProjects: [],
    allowedProjectTypes: [],
  };

  it("passa por RolesGuard numa rota @Roles(ADMIN)", () => {
    const guard = new RolesGuard(reflectorFor(ROLES_KEY, ["ADMIN"]));
    expect(guard.canActivate(context(realAdminWithoutGrants))).toBe(true);
  });

  it("passa por ModulesGuard mesmo sem nenhum módulo concedido", async () => {
    const guard = new ModulesGuard(reflectorFor(MODULE_KEY, ["financing"]), {
      project: { findFirst: jest.fn() },
    } as never);
    await expect(
      guard.canActivate(context(realAdminWithoutGrants)),
    ).resolves.toBe(true);
  });
});
