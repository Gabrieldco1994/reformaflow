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
