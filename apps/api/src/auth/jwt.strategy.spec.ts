import { UnauthorizedException } from '@nestjs/common';
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
        allowedModules: ['dashboard'],
        allowedProjects: ['p1'],
        allowedProjectTypes: ['PESSOAL'],
      }),
    );
  });

  it('atualiza lastLoginAt (last-seen) quando nulo', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      tenantId: 't1',
      username: 'guest',
      name: 'Guest',
      role: 'ADMIN',
      deletedAt: null,
      isGuest: true,
      lastLoginAt: null,
      allowedModules: '[]',
      allowedProjects: '[]',
      allowedProjectTypes: '[]',
      tenant: { id: 't1', deletedAt: null, expiresAt: null },
    });

    await strategy.validate({
      sub: 'u1',
      tenantId: 't1',
      username: 'guest',
      role: 'ADMIN',
    });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { lastLoginAt: expect.any(Date) },
    });
  });

  it('atualiza lastLoginAt quando desatualizado (fora do throttle de 15min)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      tenantId: 't1',
      username: 'guest',
      name: 'Guest',
      role: 'ADMIN',
      deletedAt: null,
      isGuest: true,
      lastLoginAt: new Date(Date.now() - 20 * 60 * 1000),
      allowedModules: '[]',
      allowedProjects: '[]',
      allowedProjectTypes: '[]',
      tenant: { id: 't1', deletedAt: null, expiresAt: null },
    });

    await strategy.validate({
      sub: 'u1',
      tenantId: 't1',
      username: 'guest',
      role: 'ADMIN',
    });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { lastLoginAt: expect.any(Date) },
    });
  });

  it('não escreve no banco quando lastLoginAt está dentro do throttle', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      tenantId: 't1',
      username: 'guest',
      name: 'Guest',
      role: 'ADMIN',
      deletedAt: null,
      isGuest: true,
      lastLoginAt: new Date(Date.now() - 5 * 60 * 1000),
      allowedModules: '[]',
      allowedProjects: '[]',
      allowedProjectTypes: '[]',
      tenant: { id: 't1', deletedAt: null, expiresAt: null },
    });

    await strategy.validate({
      sub: 'u1',
      tenantId: 't1',
      username: 'guest',
      role: 'ADMIN',
    });

    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
