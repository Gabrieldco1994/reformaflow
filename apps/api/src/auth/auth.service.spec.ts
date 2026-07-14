import { BadRequestException, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';

describe('AuthService signup/guest/claim', () => {
  const jwt = {} as JwtService;
  let prisma: any;
  let service: AuthService;

  beforeEach(() => {
    prisma = {
      user: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
      },
      tenant: {
        create: jest.fn(),
        update: jest.fn(),
      },
      project: {
        findMany: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    service = new AuthService(prisma, jwt);
    delete process.env['AUTH_ENABLE_REGISTER'];
    delete process.env['AUTH_ENABLE_GUEST'];
  });

  it('retorna config de auth com flags desligadas por padrão', () => {
    expect(service.getPublicConfig()).toEqual({
      registerEnabled: false,
      guestEnabled: false,
    });
  });

  it('registerOwner cria tenant+admin em transação quando habilitado', async () => {
    process.env['AUTH_ENABLE_REGISTER'] = '1';
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.$transaction.mockImplementation(async (cb: (tx: any) => unknown) => {
      const tx = {
        tenant: {
          create: jest.fn().mockResolvedValue({ id: 't-1', name: 'Tenant' }),
        },
        user: {
          create: jest.fn().mockImplementation(({ data }: { data: any }) =>
            Promise.resolve({
              id: 'u-1',
              tenantId: 't-1',
              username: 'owner',
              name: 'Owner',
              role: 'ADMIN',
              isGuest: false,
              passwordHash: data.passwordHash,
              allowedModules: '[]',
              allowedProjects: '[]',
              allowedProjectTypes: '[]',
            }),
          ),
        },
      };
      return cb(tx);
    });

    const out = await service.registerOwner({
      tenantName: 'Tenant',
      ownerName: 'Owner',
      username: 'Owner',
      password: '123456',
    });

    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { username: 'owner', deletedAt: null },
      select: { id: true },
    });
    expect(out.user.role).toBe('ADMIN');
    expect(out.user.isGuest).toBe(false);
    expect(out.user.passwordHash).toBeTruthy();
    expect(await bcrypt.compare('123456', out.user.passwordHash as string)).toBe(
      true,
    );
  });

  it('registerOwner falha quando flag está desligada', async () => {
    await expect(
      service.registerOwner({
        tenantName: 'Tenant',
        ownerName: 'Owner',
        username: 'owner',
        password: '123456',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('claimGuest atualiza apenas a própria conta convidada e limpa expiração', async () => {
    const nowPlusDay = new Date(Date.now() + 24 * 60 * 60 * 1000);
    prisma.user.findUnique.mockResolvedValue({
      id: 'guest-1',
      tenantId: 'tenant-1',
      deletedAt: null,
      isGuest: true,
      tenant: { id: 'tenant-1', deletedAt: null, expiresAt: nowPlusDay },
    });
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.tenant.update.mockResolvedValue({ id: 'tenant-1', expiresAt: null });
    prisma.user.update.mockResolvedValue({
      id: 'guest-1',
      tenantId: 'tenant-1',
      username: 'realuser',
      name: 'Real User',
      role: 'ADMIN',
      isGuest: false,
      allowedModules: '[]',
      allowedProjects: '[]',
      allowedProjectTypes: '[]',
    });
    prisma.$transaction.mockResolvedValue([
      { id: 'tenant-1', expiresAt: null },
      {
        id: 'guest-1',
        tenantId: 'tenant-1',
        username: 'realuser',
        name: 'Real User',
        role: 'ADMIN',
        isGuest: false,
        allowedModules: '[]',
        allowedProjects: '[]',
        allowedProjectTypes: '[]',
      },
    ]);

    const out = await service.claimGuest('guest-1', {
      username: 'RealUser',
      name: 'Real User',
      password: 'abcdef',
    });

    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { username: 'realuser', deletedAt: null, NOT: { id: 'guest-1' } },
      select: { id: true },
    });
    expect(out.user.isGuest).toBe(false);
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('claimGuest recusa username duplicado global', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'guest-1',
      tenantId: 'tenant-1',
      deletedAt: null,
      isGuest: true,
      tenant: { id: 'tenant-1', deletedAt: null, expiresAt: new Date(Date.now() + 1000) },
    });
    prisma.user.findFirst.mockResolvedValue({ id: 'u-dup' });

    await expect(
      service.claimGuest('guest-1', {
        username: 'duplicate',
        name: 'Name',
        password: '123456',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('onboarding deriva presença de projetos pessoais/reforma para guest', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      tenantId: 't1',
      deletedAt: null,
      isGuest: true,
      tenant: { id: 't1', deletedAt: null },
    });
    prisma.project = {
      findMany: jest.fn().mockResolvedValue([{ type: 'PESSOAL' }]),
    };
    process.env['APP_MODE'] = 'demo';

    await expect(service.getOnboarding('u1')).resolves.toEqual(
      expect.objectContaining({
        isGuest: true,
        demoMode: true,
        hasPersonalProject: true,
        hasReformaProject: false,
        shouldSeed: true,
      }),
    );
  });
});
