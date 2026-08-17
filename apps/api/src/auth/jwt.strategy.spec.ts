import { UnauthorizedException } from '@nestjs/common';
import { ProjectType, TYPE_MODULES } from '@reformaflow/domain';
import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy', () => {
  let prisma: any;
  let strategy: JwtStrategy;

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    strategy = new JwtStrategy(prisma);
  });

  it('rejeita sessão quando tenant foi removido', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      tenantId: 't1',
      deletedAt: null,
      isGuest: false,
      sessionVersion: 0,
      allowedModules: '[]',
      allowedProjects: '[]',
      allowedProjectTypes: '[]',
      tenant: { id: 't1', deletedAt: new Date(), expiresAt: null },
    });

    await expect(
      strategy.validate({
        sub: 'u1',
        tenantId: 't1',
        username: 'user',
        role: 'ADMIN',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejeita convidado expirado', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      tenantId: 't1',
      username: 'guest',
      name: 'Guest',
      role: 'ADMIN',
      deletedAt: null,
      isGuest: true,
      sessionVersion: 0,
      allowedModules: '[]',
      allowedProjects: '[]',
      allowedProjectTypes: '[]',
      tenant: { id: 't1', deletedAt: null, expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(
      strategy.validate({
        sub: 'u1',
        tenantId: 't1',
        username: 'guest',
        role: 'ADMIN',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('aceita convidado não expirado e retorna payload enriquecido', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      tenantId: 't1',
      username: 'guest',
      name: 'Guest',
      role: 'ADMIN',
      deletedAt: null,
      isGuest: true,
      sessionVersion: 0,
      allowedModules: '["dashboard"]',
      allowedProjects: '["p1"]',
      allowedProjectTypes: '["PESSOAL"]',
      tenant: { id: 't1', deletedAt: null, expiresAt: new Date(Date.now() + 1000) },
    });

    await expect(
      strategy.validate({
        sub: 'u1',
        tenantId: 't1',
        username: 'guest',
        role: 'ADMIN',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: 'u1',
        tenantId: 't1',
        isGuest: true,
        // `allowedModules` é RECONCILIADO contra `TYPE_MODULES` na leitura: o
        // snapshot do banco (`["dashboard"]`) é uma foto do signup e ficaria
        // velha a cada módulo novo. Como o usuário tem PESSOAL, recebe os
        // módulos que esse tipo concede hoje. Ver `reconcileUserModules`.
        allowedModules: expect.arrayContaining([
          'dashboard',
          ...TYPE_MODULES[ProjectType.PESSOAL],
        ]),
        allowedProjects: ['p1'],
        allowedProjectTypes: ['PESSOAL'],
      }),
    );
  });

  it('não inventa módulo para usuário legado sem tipos — só reconcilia quem tem tipo', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      tenantId: 't1',
      username: 'legado',
      name: 'Legado',
      role: 'USER',
      deletedAt: null,
      isGuest: false,
      sessionVersion: 0,
      allowedModules: '["dashboard"]',
      allowedProjects: '[]',
      // Vazio = legado "sem restrição": deriva acesso por outro caminho
      // (`accessibleProjectTypes`), então reconciliar aqui inventaria acesso.
      allowedProjectTypes: '[]',
      tenant: { id: 't1', deletedAt: null, expiresAt: null },
    });

    await expect(
      strategy.validate({ sub: 'u1', tenantId: 't1', username: 'legado', role: 'USER' }),
    ).resolves.toEqual(
      expect.objectContaining({ allowedModules: ['dashboard'] }),
    );
  });

  it('reconcilia o módulo que faltava — o request.user do ModulesGuard deixa de dar 403', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      tenantId: 't1',
      username: 'antigo',
      name: 'Antigo',
      role: 'USER',
      deletedAt: null,
      isGuest: false,
      sessionVersion: 0,
      // Snapshot gravado ANTES de `financing` entrar em TYPE_MODULES[CARRO].
      allowedModules: '["dashboard","carInfo","recurringBills"]',
      allowedProjects: '[]',
      allowedProjectTypes: '["CARRO"]',
      tenant: { id: 't1', deletedAt: null, expiresAt: null },
    });

    const result = await strategy.validate({
      sub: 'u1',
      tenantId: 't1',
      username: 'antigo',
      role: 'USER',
    });

    expect(result.allowedModules).toContain('financing');
    // E não removeu nada do que já tinha.
    expect(result.allowedModules).toContain('carInfo');
  });
});

/**
 * B0 (#447) — `JwtStrategy.validate` é o SEGUNDO leitor de grants (o primeiro é
 * `AuthService.buildPublicUser`, ver auth.service.spec.ts). Hoje os dois
 * degradam `allowedProjects` corrompido/branco/nulo/não-array para `[]` — que
 * `accessibleProjectScope` lê como "sem restrição" (o wildcard LEGÍTIMO de um
 * grant vazio de verdade). Isso é fail-OPEN: o `request.user` que o
 * `ModulesGuard`/`resolveAccessibleProjectScope` consultam sairia com acesso
 * IRRESTRITO justamente quando o dado está corrompido.
 *
 * Lens consolidation (B0 Phase-1): pin the harder contract directly —
 * `validate()` REJECTS with `UnauthorizedException` (401) on invalid/corrupt
 * `allowedProjects`, matching `AuthService.buildPublicUser` exactly (see
 * auth.service.spec.ts). `[null,7]` is invalid as a whole; `["p1",null]`
 * stays valid (filtered to `["p1"]`) and must NOT throw.
 */
describe('JwtStrategy.validate — allowedProjects corrompido falha fechado (B0 #447)', () => {
  let prisma: any;
  let strategy: JwtStrategy;

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    strategy = new JwtStrategy(prisma);
  });

  function row(allowedProjects: unknown) {
    return {
      id: 'u1',
      tenantId: 't1',
      username: 'x',
      name: 'X',
      role: 'USER',
      deletedAt: null,
      isGuest: false,
      sessionVersion: 0,
      allowedModules: '[]',
      allowedProjects: allowedProjects as string,
      allowedProjectTypes: '[]',
      tenant: { id: 't1', deletedAt: null, expiresAt: null },
    };
  }

  it.each([
    ['JSON malformado', '{corrompido'],
    ['string em branco', ''],
    ['null', null],
    ['objeto não-array', '{"p1":true}'],
  ])(
    'allowedProjects=%s falha fechado com 401 — nunca vira o wildcard silenciosamente',
    async (_label, raw) => {
      prisma.user.findUnique.mockResolvedValue(row(raw));

      await expect(
        strategy.validate({
          sub: 'u1',
          tenantId: 't1',
          username: 'x',
          role: 'USER',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    },
  );

  it('[null,7] misto (inválido como um todo) também falha fechado com 401', async () => {
    prisma.user.findUnique.mockResolvedValue(row('[null,7]'));

    await expect(
      strategy.validate({
        sub: 'u1',
        tenantId: 't1',
        username: 'x',
        role: 'USER',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('["p1",null] válido continua filtrando o null e preservando "p1" — paridade com buildPublicUser, não lança', async () => {
    prisma.user.findUnique.mockResolvedValue(row('["p1",null]'));

    const result = await strategy.validate({
      sub: 'u1',
      tenantId: 't1',
      username: 'x',
      role: 'USER',
    });

    expect(result.allowedProjects).toEqual(['p1']);
  });

  it('B0 Phase-1 delta: allowedModules corrompido agora falha fechado com 401 — supersede a antiga reconciliação tolerante', async () => {
    // Superseded (B0 Phase-1 verification delta): a versão antiga deste teste
    // tolerava `allowedModules` corrompido e ainda reconciliava com sucesso.
    // O parser compartilhado agora fecha (401) para QUALQUER um dos três
    // campos de grant, não só `allowedProjects`.
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      tenantId: 't1',
      username: 'x',
      name: 'X',
      role: 'USER',
      deletedAt: null,
      isGuest: false,
      sessionVersion: 0,
      allowedModules: '{corrompido',
      allowedProjects: '[]',
      allowedProjectTypes: JSON.stringify([ProjectType.PESSOAL]),
      tenant: { id: 't1', deletedAt: null, expiresAt: null },
    });

    await expect(
      strategy.validate({
        sub: 'u1',
        tenantId: 't1',
        username: 'x',
        role: 'USER',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('reconcileUserModules union continua aplicando quando allowedModules/allowedProjectTypes são mistos porém VÁLIDOS (não corrompidos)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      tenantId: 't1',
      username: 'x',
      name: 'X',
      role: 'USER',
      deletedAt: null,
      isGuest: false,
      sessionVersion: 0,
      allowedModules: '["dashboard", null]',
      allowedProjects: '[]',
      allowedProjectTypes: '["PESSOAL", null]',
      tenant: { id: 't1', deletedAt: null, expiresAt: null },
    });

    const result = await strategy.validate({
      sub: 'u1',
      tenantId: 't1',
      username: 'x',
      role: 'USER',
    });

    expect(result.allowedModules).toContain('dashboard');
    expect(result.allowedModules).not.toContain(null);
    expect(result.allowedProjectTypes).not.toContain(null);
    expect(result.allowedModules).toContain('recurrences');
    expect(result.allowedModules).toContain('pendencias');
  });
});

/**
 * B0 Phase-1 verification delta — settled contract, binding for RED:
 * `allowedModules` e `allowedProjectTypes` usam o MESMO parser compartilhado
 * fail-closed que `allowedProjects` (ver describe acima). Corrupto/não-array/
 * lixo total em QUALQUER um deles fecha com 401 também no `JwtStrategy`, o
 * SEGUNDO dos dois leitores — paridade exata com `AuthService.buildPublicUser`
 * (ver auth.service.spec.ts).
 */
describe('JwtStrategy.validate — allowedModules/allowedProjectTypes corrompidos falham fechado (B0 Phase-1 delta)', () => {
  let prisma: any;
  let strategy: JwtStrategy;

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    strategy = new JwtStrategy(prisma);
  });

  function row(overrides: Record<string, unknown> = {}) {
    return {
      id: 'u1',
      tenantId: 't1',
      username: 'x',
      name: 'X',
      role: 'USER',
      deletedAt: null,
      isGuest: false,
      sessionVersion: 0,
      allowedModules: '[]',
      allowedProjects: '[]',
      allowedProjectTypes: '[]',
      tenant: { id: 't1', deletedAt: null, expiresAt: null },
      ...overrides,
    };
  }

  const INVALID_CASES: Array<[string, unknown]> = [
    ['JSON malformado', '{corrompido'],
    ['string em branco', ''],
    ['null', null],
    ['objeto não-array', '{"p1":true}'],
    ['lixo puro (não é JSON de forma alguma)', 'nao-e-json-de-jeito-nenhum'],
    ['[null,7] inválido como um todo', '[null,7]'],
  ];

  it.each(INVALID_CASES)(
    'allowedModules=%s falha fechado com 401 (allowedProjects/allowedProjectTypes válidos)',
    async (_label, raw) => {
      prisma.user.findUnique.mockResolvedValue(row({ allowedModules: raw }));

      await expect(
        strategy.validate({ sub: 'u1', tenantId: 't1', username: 'x', role: 'USER' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    },
  );

  it.each(INVALID_CASES)(
    'allowedProjectTypes=%s falha fechado com 401 (allowedModules/allowedProjects válidos)',
    async (_label, raw) => {
      prisma.user.findUnique.mockResolvedValue(
        row({ allowedProjectTypes: raw }),
      );

      await expect(
        strategy.validate({ sub: 'u1', tenantId: 't1', username: 'x', role: 'USER' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    },
  );
});
