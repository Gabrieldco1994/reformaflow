import { UnauthorizedException } from '@nestjs/common';
import { ProjectType, TYPE_MODULES } from '@reformaflow/domain';
import { JwtStrategy } from './jwt.strategy';
import { accessibleProjectScope } from '../common/access-rules';

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
    'allowedProjects=%s NUNCA vira o wildcard: accessibleProjectScope tem que negar, não liberar tudo',
    async (_label, raw) => {
      prisma.user.findUnique.mockResolvedValue(row(raw));

      const result = await strategy.validate({
        sub: 'u1',
        tenantId: 't1',
        username: 'x',
        role: 'USER',
      });

      expect(accessibleProjectScope('USER', result.allowedProjects)).not.toBeNull();
    },
  );

  it('[null,7] misto não vaza valores não-string para o scope de projetos do request.user', async () => {
    prisma.user.findUnique.mockResolvedValue(row('[null,7]'));

    const result = await strategy.validate({
      sub: 'u1',
      tenantId: 't1',
      username: 'x',
      role: 'USER',
    });

    expect(result.allowedProjects.every((id) => typeof id === 'string')).toBe(true);
  });

  it('["p1",null] válido continua filtrando o null e preservando "p1" — paridade com buildPublicUser', async () => {
    prisma.user.findUnique.mockResolvedValue(row('["p1",null]'));

    const result = await strategy.validate({
      sub: 'u1',
      tenantId: 't1',
      username: 'x',
      role: 'USER',
    });

    expect(result.allowedProjects).toEqual(['p1']);
  });

  it('mantém a reconciliação de módulos por união mesmo quando allowedModules está corrompido', async () => {
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

    const result = await strategy.validate({
      sub: 'u1',
      tenantId: 't1',
      username: 'x',
      role: 'USER',
    });

    expect(result.allowedModules).toContain('recurrences');
    expect(result.allowedModules).toContain('pendencias');
  });
});
