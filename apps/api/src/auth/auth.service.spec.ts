import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { deriveObjectiveAccess, ProjectType } from '@reformaflow/domain';
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

  it('registerOwner cria tenant+user em transação quando habilitado', async () => {
    process.env['AUTH_ENABLE_REGISTER'] = '1';
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.$transaction.mockImplementation(async (cb: (tx: any) => unknown) => {
      const tx = {
        tenant: {
          create: jest.fn().mockResolvedValue({ id: 't-1', name: 'Tenant' }),
        },
        user: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockImplementation(({ data }: { data: any }) =>
            Promise.resolve({
              id: 'u-1',
              tenantId: 't-1',
              username: 'owner',
              name: 'Owner',
              role: data.role,
              isGuest: false,
              passwordHash: data.passwordHash,
              allowedModules: data.allowedModules,
              allowedProjects: '[]',
              allowedProjectTypes: data.allowedProjectTypes,
            }),
          ),
        },
      };
      return cb(tx);
    });

    const out = await service.registerOwner({
      tenantName: 'Tenant',
      ownerName: 'Owner',
      email: 'owner@example.com',
      username: 'Owner',
      password: '12345678',
      projectTypes: [ProjectType.CASA],
    });

    expect(out.user.role).toBe('USER');
    expect(out.user.isGuest).toBe(false);
    expect(out.user.passwordHash).toBeTruthy();
    expect(await bcrypt.compare('12345678', out.user.passwordHash as string)).toBe(
      true,
    );
  });

  it('registerOwner grava lastLoginAt na criação (senão o KPI "logaram hoje" nunca conta quem só se cadastrou)', async () => {
    process.env['AUTH_ENABLE_REGISTER'] = '1';
    prisma.user.findFirst.mockResolvedValue(null);
    let capturedUserCreateData: any;
    prisma.$transaction.mockImplementation(async (cb: (tx: any) => unknown) => {
      const tx = {
        tenant: {
          create: jest.fn().mockResolvedValue({ id: 't-1', name: 'Tenant' }),
        },
        user: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockImplementation(({ data }: { data: any }) => {
            capturedUserCreateData = data;
            return Promise.resolve({ id: 'u-1', tenantId: 't-1', ...data });
          }),
        },
      };
      return cb(tx);
    });

    await service.registerOwner({
      tenantName: 'Tenant',
      ownerName: 'Owner',
      email: 'owner@example.com',
      username: 'Owner',
      password: '12345678',
      projectTypes: [ProjectType.CASA],
    });

    expect(capturedUserCreateData.lastLoginAt).toBeInstanceOf(Date);
  });

  it('registerOwner falha quando flag está desligada', async () => {
    await expect(
      service.registerOwner({
        tenantName: 'Tenant',
        ownerName: 'Owner',
        email: 'owner@example.com',
        username: 'owner',
        password: '123456',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('registerGuest grava lastLoginAt na criação (mesmo motivo do registerOwner)', async () => {
    process.env['AUTH_ENABLE_GUEST'] = '1';
    let capturedUserCreateData: any;
    prisma.$transaction.mockImplementation(async (cb: (tx: any) => unknown) => {
      const tx = {
        tenant: {
          create: jest.fn().mockResolvedValue({ id: 't-guest', name: 'Guest Tenant' }),
        },
        user: {
          create: jest.fn().mockImplementation(({ data }: { data: any }) => {
            capturedUserCreateData = data;
            return Promise.resolve({ id: 'u-guest', tenantId: 't-guest', ...data });
          }),
        },
      };
      return cb(tx);
    });

    await service.registerGuest({ tenantName: 'Guest Tenant' });

    expect(capturedUserCreateData.lastLoginAt).toBeInstanceOf(Date);
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
    // claimGuest é a "primeira entrada real" com credenciais próprias — deve
    // contar como login para o KPI "logaram hoje" (mesma lógica de registerOwner).
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastLoginAt: expect.any(Date) }),
      }),
    );
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

  it('validateUser registra último login', async () => {
    const passwordHash = await bcrypt.hash('12345678', 10);
    prisma.user.findFirst.mockResolvedValue({
      id: 'u-1',
      username: 'owner',
      tenant: { deletedAt: null },
      isGuest: false,
      passwordHash,
    });
    prisma.user.update.mockResolvedValue({});

    const out = await service.validateUser('Owner', '12345678');

    expect(out.id).toBe('u-1');
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u-1' },
      data: { lastLoginAt: expect.any(Date) },
    });
  });

  it('registerOwner deriva username de email quando username não informado', async () => {
    process.env['AUTH_ENABLE_REGISTER'] = '1';
    let capturedUserData: any;
    prisma.$transaction.mockImplementation(async (cb: (tx: any) => unknown) => {
      const tx = {
        tenant: {
          create: jest.fn().mockResolvedValue({ id: 't-1', name: 'Vida de João' }),
        },
        user: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockImplementation(({ data }: { data: any }) => {
            capturedUserData = data;
            return Promise.resolve({
              id: 'u-1',
              tenantId: 't-1',
              ...data,
            });
          }),
        },
      };
      return cb(tx);
    });

    const result = await service.registerOwner({
      ownerName: 'João Silva',
      email: 'joao@example.com',
      password: '12345678',
    });

    expect(capturedUserData.username).toBe('joao');
    expect(capturedUserData.email).toBe('joao@example.com');
    expect(result.user.username).toBe('joao');
  });

  it('registerOwner resolve colisão de username com sufixo -2, -3, etc', async () => {
    process.env['AUTH_ENABLE_REGISTER'] = '1';
    let capturedUserData: any;
    prisma.$transaction.mockImplementation(async (cb: (tx: any) => unknown) => {
      const tx = {
        tenant: {
          create: jest.fn().mockResolvedValue({ id: 't-1', name: 'Vida de João' }),
        },
        user: {
          findFirst: jest.fn()
            .mockResolvedValueOnce(null) // email not exists
            .mockResolvedValueOnce({ id: 'u-existing' }) // joao exists
            .mockResolvedValueOnce({ id: 'u-existing-2' }) // joao-2 exists
            .mockResolvedValueOnce(null), // joao-3 not exists
          create: jest.fn().mockImplementation(({ data }: { data: any }) => {
            capturedUserData = data;
            return Promise.resolve({
              id: 'u-new',
              tenantId: 't-1',
              ...data,
            });
          }),
        },
      };
      return cb(tx);
    });

    const result = await service.registerOwner({
      ownerName: 'João Silva',
      email: 'joao@example.com',
      password: '12345678',
    });

    expect(capturedUserData.username).toBe('joao-3');
  });

  it('registerOwner deriva tenantName de ownerName quando tenantName não informado', async () => {
    process.env['AUTH_ENABLE_REGISTER'] = '1';
    let capturedTenantData: any;
    prisma.$transaction.mockImplementation(async (cb: (tx: any) => unknown) => {
      const tx = {
        tenant: {
          create: jest.fn().mockImplementation(({ data }: { data: any }) => {
            capturedTenantData = data;
            return Promise.resolve({ id: 't-1', ...data });
          }),
        },
        user: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({
            id: 'u-1',
            tenantId: 't-1',
            username: 'joao',
          }),
        },
      };
      return cb(tx);
    });

    await service.registerOwner({
      ownerName: 'João Silva',
      email: 'joao@example.com',
      password: '12345678',
    });

    expect(capturedTenantData.name).toBe('Vida de João');
  });

  it('registerOwner rejeita email duplicado com mensagem em português', async () => {
    process.env['AUTH_ENABLE_REGISTER'] = '1';
    prisma.$transaction.mockImplementation(async (cb: (tx: any) => unknown) => {
      const tx = {
        tenant: {
          create: jest.fn().mockResolvedValue({ id: 't-1', name: 'Tenant' }),
        },
        user: {
          findFirst: jest.fn().mockResolvedValue({ id: 'u-dup' }), // email exists
          create: jest.fn(),
        },
      };
      return cb(tx);
    });

    await expect(
      service.registerOwner({
        ownerName: 'João Silva',
        email: 'joao@example.com',
        password: '12345678',
      }),
    ).rejects.toThrow('Este e-mail já está cadastrado');
  });

  it('validateUser aceita login por email e normaliza para lowercase', async () => {
    const passwordHash = await bcrypt.hash('12345678', 10);
    prisma.user.findFirst.mockResolvedValue({
      id: 'u-1',
      email: 'joao@example.com',
      tenant: { deletedAt: null },
      isGuest: false,
      passwordHash,
    });
    prisma.user.update.mockResolvedValue({});

    const out = await service.validateUser('JOAO@EXAMPLE.COM', '12345678');

    expect(out.id).toBe('u-1');
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({ email: 'joao@example.com' }),
          ]),
        }),
      }),
    );
  });

  it('validateUser aceita login por username também', async () => {
    const passwordHash = await bcrypt.hash('12345678', 10);
    prisma.user.findFirst.mockResolvedValue({
      id: 'u-1',
      username: 'joao',
      tenant: { deletedAt: null },
      isGuest: false,
      passwordHash,
    });
    prisma.user.update.mockResolvedValue({});

    const out = await service.validateUser('joao', '12345678');

    expect(out.id).toBe('u-1');
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({ username: 'joao' }),
          ]),
        }),
      }),
    );
  });

  it('updateSelfObjectives com 1 tipo grava allowedProjectTypes e allowedModules só daquele tipo', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      tenantId: 't1',
      deletedAt: null,
      isGuest: false,
      role: 'USER',
      allowedProjects: '[]',
      tenant: { deletedAt: null },
    });
    prisma.user.update.mockImplementation(({ data }: any) =>
      Promise.resolve({ id: 'u1', tenantId: 't1', ...data }),
    );
    prisma.$transaction.mockImplementation((cb: (tx: any) => unknown) =>
      cb(prisma),
    );

    const out = await service.updateSelfObjectives('u1', [ProjectType.CARRO]);

    const expected = deriveObjectiveAccess([ProjectType.CARRO]);
    expect(out.allowedProjectTypes).toEqual(expected.allowedProjectTypes);
    expect(out.allowedModules.sort()).toEqual(expected.allowedModules.sort());
  });

  it('updateSelfObjectives com 3 tipos grava a união dos módulos dos três', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      tenantId: 't1',
      deletedAt: null,
      isGuest: false,
      role: 'USER',
      allowedProjects: '[]',
      tenant: { deletedAt: null },
    });
    prisma.user.update.mockImplementation(({ data }: any) =>
      Promise.resolve({ id: 'u1', tenantId: 't1', ...data }),
    );
    prisma.$transaction.mockImplementation((cb: (tx: any) => unknown) =>
      cb(prisma),
    );

    const tipos = [ProjectType.CASA, ProjectType.CARRO, ProjectType.REFORMA];
    const out = await service.updateSelfObjectives('u1', tipos);

    const expected = deriveObjectiveAccess(tipos);
    expect(out.allowedProjectTypes.sort()).toEqual(
      [...expected.allowedProjectTypes].sort(),
    );
    expect(out.allowedModules.sort()).toEqual([...expected.allowedModules].sort());
    // a união tem que ser estritamente maior que qualquer tipo isolado —
    // senão não é união, é só o último tipo sobrescrevendo os outros.
    expect(out.allowedModules.length).toBeGreaterThan(
      deriveObjectiveAccess([ProjectType.CARRO]).allowedModules.length,
    );
  });

  it('updateSelfObjectives com [] rejeita — não pode zerar o acesso e deixar a conta sem módulo nenhum', async () => {
    await expect(service.updateSelfObjectives('u1', [])).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

/**
 * B0 (#447): `updateSelfObjectives` runs read+authorize+write inside ONE
 * Prisma interactive transaction. "managed" is a VALID NON-EMPTY
 * `allowedProjects` — NOT `createdByUserId` (every test below sets it
 * inconsistently with that old, wrong reading to prove it's irrelevant).
 * Guest is always 403 (independent of grant content); ADMIN is always
 * allowed (independent of grant content); a corrupt own grant is 401 (not
 * 403) and is checked BEFORE guest/admin. Every denied path writes zero rows.
 */
describe('AuthService.updateSelfObjectives — managed/guest/invalid-grant fecham em transação interativa (B0 #447)', () => {
  const jwt = {} as JwtService;
  let prisma: any;
  let service: AuthService;
  let callOrder: string[];

  beforeEach(() => {
    callOrder = [];
    prisma = {
      // Direct client REJECTS: an accidental non-transactional call surfaces
      // as this error (not the expected exception type), so the tx-based
      // path can't be faked by an unconfigured mock.
      user: {
        findUnique: jest
          .fn()
          .mockRejectedValue(
            new Error(
              'updateSelfObjectives não pode chamar prisma.user.findUnique direto — use a transação interativa',
            ),
          ),
        update: jest
          .fn()
          .mockRejectedValue(
            new Error(
              'updateSelfObjectives não pode chamar prisma.user.update direto — use a transação interativa',
            ),
          ),
      },
      $transaction: jest.fn(),
    };
    service = new AuthService(prisma, jwt);
  });

  /** Programs `$transaction` to invoke its callback with a `tx` that resolves
   * `userRow` on read and records read/write order. */
  function mockTransaction(userRow: Record<string, unknown>) {
    const tx = {
      user: {
        findUnique: jest.fn().mockImplementation(() => {
          callOrder.push('read');
          return Promise.resolve(userRow);
        }),
        update: jest.fn().mockImplementation(({ data }: any) => {
          callOrder.push('write');
          return Promise.resolve({ id: 'u1', tenantId: 't1', ...data });
        }),
      },
    };
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) =>
      cb(tx),
    );
    return tx;
  }

  it('roda em UMA transação interativa: $transaction recebe uma função, e o client direto nunca é chamado', async () => {
    const tx = mockTransaction({
      id: 'u1',
      tenantId: 't1',
      deletedAt: null,
      isGuest: false,
      role: 'USER',
      createdByUserId: null,
      allowedProjects: '[]',
      tenant: { deletedAt: null },
    });

    await service.updateSelfObjectives('u1', [ProjectType.PESSOAL]);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(typeof prisma.$transaction.mock.calls[0]?.[0]).toBe('function');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(tx.user.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.user.update).toHaveBeenCalledTimes(1);
  });

  it('lê então escreve — nunca reautoriza depois do write (uma leitura, uma escrita, nessa ordem)', async () => {
    const tx = mockTransaction({
      id: 'u1',
      tenantId: 't1',
      deletedAt: null,
      isGuest: false,
      role: 'USER',
      createdByUserId: null,
      allowedProjects: '[]',
      tenant: { deletedAt: null },
    });

    await service.updateSelfObjectives('u1', [ProjectType.PESSOAL]);

    expect(callOrder).toEqual(['read', 'write']);
    expect(tx.user.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.user.update).toHaveBeenCalledTimes(1);
  });

  it('managed USER (allowedProjects válido e NÃO-vazio) recebe 403 e não grava nada dentro da transação — createdByUserId é irrelevante (null aqui)', async () => {
    const tx = mockTransaction({
      id: 'u1',
      tenantId: 't1',
      deletedAt: null,
      isGuest: false,
      role: 'USER',
      createdByUserId: null, // prova que o discriminador NÃO é este campo
      allowedProjects: '["p1","p2"]',
      tenant: { deletedAt: null },
    });

    await expect(
      service.updateSelfObjectives('u1', [ProjectType.PESSOAL]),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('mixed managed CONTINUA 403 — allowedProjects filtra o null e permanece válido/não-vazio', async () => {
    const tx = mockTransaction({
      id: 'u1',
      tenantId: 't1',
      deletedAt: null,
      isGuest: false,
      role: 'USER',
      createdByUserId: null,
      allowedProjects: '["p1", null, "p2"]',
      tenant: { deletedAt: null },
    });

    await expect(
      service.updateSelfObjectives('u1', [ProjectType.PESSOAL]),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('guest recebe 403 mesmo com role ADMIN e allowedProjects=[] — 403 é explícito do isGuest, não decorre de allowedProjects', async () => {
    const tx = mockTransaction({
      id: 'u1',
      tenantId: 't1',
      deletedAt: null,
      isGuest: true,
      role: 'ADMIN',
      createdByUserId: 'admin-1',
      allowedProjects: '[]',
      tenant: { deletedAt: null },
    });

    await expect(
      service.updateSelfObjectives('u1', [ProjectType.PESSOAL]),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('ADMIN não-convidado continua liberado mesmo com allowedProjects válido e não-vazio (o que faria um USER ser "managed")', async () => {
    const tx = mockTransaction({
      id: 'u1',
      tenantId: 't1',
      deletedAt: null,
      isGuest: false,
      role: 'ADMIN',
      createdByUserId: 'admin-0',
      allowedProjects: '["p1","p2"]',
      tenant: { deletedAt: null },
    });

    await expect(
      service.updateSelfObjectives('u1', [ProjectType.PESSOAL]),
    ).resolves.toBeDefined();
    expect(tx.user.update).toHaveBeenCalledTimes(1);
  });

  it('USER self-service com allowedProjects=[] (válido, wildcard) continua liberado — createdByUserId setado não muda nada', async () => {
    const tx = mockTransaction({
      id: 'u1',
      tenantId: 't1',
      deletedAt: null,
      isGuest: false,
      role: 'USER',
      createdByUserId: 'admin-1', // prova (de novo) que este campo é irrelevante
      allowedProjects: '[]',
      tenant: { deletedAt: null },
    });

    await expect(
      service.updateSelfObjectives('u1', [ProjectType.PESSOAL]),
    ).resolves.toBeDefined();
    expect(tx.user.update).toHaveBeenCalledTimes(1);
  });

  it('grant PRÓPRIO corrompido (allowedProjects malformado) falha fechado com 401 — não 403, sem gravar', async () => {
    const tx = mockTransaction({
      id: 'u1',
      tenantId: 't1',
      deletedAt: null,
      isGuest: false,
      role: 'USER',
      createdByUserId: null,
      allowedProjects: '{corrompido',
      tenant: { deletedAt: null },
    });

    await expect(
      service.updateSelfObjectives('u1', [ProjectType.PESSOAL]),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('grant PRÓPRIO com [null,7] (inválido como um todo) também falha fechado com 401, não 403', async () => {
    const tx = mockTransaction({
      id: 'u1',
      tenantId: 't1',
      deletedAt: null,
      isGuest: false,
      role: 'USER',
      createdByUserId: null,
      allowedProjects: '[null,7]',
      tenant: { deletedAt: null },
    });

    await expect(
      service.updateSelfObjectives('u1', [ProjectType.PESSOAL]),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('grant inválido é checado ANTES do guest/admin — 401 vence quando ambos se aplicariam ao mesmo tempo', async () => {
    const tx = mockTransaction({
      id: 'u1',
      tenantId: 't1',
      deletedAt: null,
      isGuest: true, // guest sozinho daria 403
      role: 'ADMIN', // ADMIN sozinho seria permitido
      createdByUserId: null,
      allowedProjects: '{corrompido', // grant inválido: precisa vencer os dois acima
      tenant: { deletedAt: null },
    });

    await expect(
      service.updateSelfObjectives('u1', [ProjectType.PESSOAL]),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tx.user.update).not.toHaveBeenCalled();
  });
});

/**
 * O `allowedModules` gravado no signup é uma FOTO. Quando um módulo novo entra
 * em `TYPE_MODULES`, quem já tinha conta ficava para trás: menu sumia e a API
 * respondia 403 num módulo que o tipo dele concede. `buildPublicUser` passa a
 * reconciliar em tempo de leitura, então o problema não volta no próximo módulo.
 */
describe('AuthService.buildPublicUser — reconciliação do snapshot de autorização', () => {
  const service = new AuthService({} as any, {} as JwtService);

  /** Usuário como está no banco: os dois campos são JSON em coluna TEXT. */
  function row(overrides: Record<string, unknown> = {}) {
    return {
      id: 'u1',
      username: 'maria',
      name: 'Maria',
      role: 'USER',
      tenantId: 't1',
      allowedModules: JSON.stringify(['dashboard', 'recurringBills']),
      allowedProjects: '[]',
      allowedProjectTypes: JSON.stringify([ProjectType.CASA]),
      ...overrides,
    };
  }

  it('concede módulo que o tipo passou a ter depois do cadastro (CASA → financing)', () => {
    // Snapshot antigo: gravado antes de `financing` existir em TYPE_MODULES.
    const out = service.buildPublicUser(row());
    expect(out.allowedModules).toContain('financing');
  });

  it('vale para CARRO também — o backfill antigo cobria só este tipo', () => {
    const out = service.buildPublicUser(
      row({ allowedProjectTypes: JSON.stringify([ProjectType.CARRO]) }),
    );
    expect(out.allowedModules).toContain('financing');
    expect(out.allowedModules).toContain('vehicleDocuments');
  });

  it('vale para qualquer módulo, não só financing (PESSOAL → recurrences/pendencias)', () => {
    const out = service.buildPublicUser(
      row({
        allowedProjectTypes: JSON.stringify([ProjectType.PESSOAL]),
        allowedModules: JSON.stringify(['dashboard', 'expenses']),
      }),
    );
    expect(out.allowedModules).toContain('recurrences');
    expect(out.allowedModules).toContain('pendencias');
  });

  it('NUNCA remove: módulo concedido fora do mapa do tipo é preservado', () => {
    const out = service.buildPublicUser(
      row({
        allowedModules: JSON.stringify(['dashboard', 'concedido-pelo-suporte']),
      }),
    );
    expect(out.allowedModules).toContain('concedido-pelo-suporte');
  });

  it('não duplica módulo que o usuário já tinha', () => {
    const out = service.buildPublicUser(row());
    expect(out.allowedModules.filter((m) => m === 'dashboard')).toHaveLength(1);
  });

  it('usuário legado sem tipos não é tocado — deriva acesso por outro caminho', () => {
    const out = service.buildPublicUser(
      row({ allowedProjectTypes: '[]', allowedModules: JSON.stringify(['dashboard']) }),
    );
    expect(out.allowedModules).toEqual(['dashboard']);
  });

  it('a união bate exatamente com o que o signup gravaria hoje', () => {
    const tipos = [ProjectType.CASA, ProjectType.CARRO];
    const out = service.buildPublicUser(
      row({ allowedProjectTypes: JSON.stringify(tipos), allowedModules: '[]' }),
    );
    const esperado = deriveObjectiveAccess(tipos).allowedModules;
    expect(out.allowedModules.sort()).toEqual([...esperado].sort());
  });
});

/**
 * B0 Phase-1 delta: `allowedModules`/`allowedProjectTypes` now share the SAME
 * fail-closed parser as `allowedProjects` (below) in both readers
 * (`buildPublicUser` here, `JwtStrategy.validate` in jwt.strategy.spec.ts) —
 * superseding the old "corrupted allowedModules degrades to []" tolerance.
 */
describe('AuthService.buildPublicUser — allowedModules/allowedProjectTypes corrompidos falham fechado (B0 Phase-1 delta)', () => {
  const service = new AuthService({} as any, {} as JwtService);

  function row(overrides: Record<string, unknown> = {}) {
    return {
      id: 'u1',
      username: 'x',
      name: 'X',
      role: 'USER',
      tenantId: 't1',
      allowedModules: '[]',
      allowedProjects: '[]',
      allowedProjectTypes: '[]',
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
    (_label, raw) => {
      expect(() => service.buildPublicUser(row({ allowedModules: raw }))).toThrow(
        UnauthorizedException,
      );
    },
  );

  it.each(INVALID_CASES)(
    'allowedProjectTypes=%s falha fechado com 401 (allowedModules/allowedProjects válidos)',
    (_label, raw) => {
      expect(() =>
        service.buildPublicUser(row({ allowedProjectTypes: raw })),
      ).toThrow(UnauthorizedException);
    },
  );

  it('allowedModules misto filtra o null e preserva só os módulos explícitos (sem tipos, sem reconciliação extra)', () => {
    const out = service.buildPublicUser(
      row({ allowedModules: '["dashboard", null, "expenses"]' }),
    );
    expect(out.allowedModules).not.toContain(null);
    expect([...out.allowedModules].sort()).toEqual(['dashboard', 'expenses']);
  });

  it('allowedProjectTypes misto filtra o null e preserva os tipos explícitos', () => {
    const out = service.buildPublicUser(
      row({ allowedProjectTypes: '["PESSOAL", null, "REFORMA"]' }),
    );
    expect(out.allowedProjectTypes).toEqual(['PESSOAL', 'REFORMA']);
  });

  it('reconcileUserModules union continua aplicando por cima de allowedModules/allowedProjectTypes mistos e válidos', () => {
    const out = service.buildPublicUser(
      row({
        allowedModules: '["dashboard", null]',
        allowedProjectTypes: '["PESSOAL", null]',
      }),
    );
    // Explícito preservado, null filtrado — em nenhum dos dois campos...
    expect(out.allowedModules).toContain('dashboard');
    expect(out.allowedModules).not.toContain(null);
    expect(out.allowedProjectTypes).not.toContain(null);
    // ...E a união com o que PESSOAL concede continua sendo aplicada.
    expect(out.allowedModules).toContain('recurrences');
    expect(out.allowedModules).toContain('pendencias');
  });
});

/**
 * B0 (#447) — `allowedProjects` inválido degradava para `[]`, que
 * `accessibleProjectScope` lê como wildcard (fail-OPEN). `buildPublicUser` é
 * um dos dois leitores (o outro é `JwtStrategy.validate`, ver
 * jwt.strategy.spec.ts); os dois falham fechado do mesmo jeito.
 */
describe('AuthService.buildPublicUser — allowedProjects corrompido falha fechado (B0 #447)', () => {
  const service = new AuthService({} as any, {} as JwtService);

  function row(allowedProjects: unknown) {
    return {
      id: 'u1',
      username: 'x',
      name: 'X',
      role: 'USER',
      tenantId: 't1',
      allowedModules: '[]',
      allowedProjects: allowedProjects as string,
      allowedProjectTypes: '[]',
    };
  }

  it.each([
    ['JSON malformado', '{corrompido'],
    ['string em branco', ''],
    ['null', null],
    ['objeto não-array', '{"p1":true}'],
  ])(
    'allowedProjects=%s falha fechado com 401 — nunca vira o wildcard silenciosamente',
    (_label, raw) => {
      expect(() => service.buildPublicUser(row(raw))).toThrow(
        UnauthorizedException,
      );
    },
  );

  it('[null,7] misto (inválido como um todo) também falha fechado com 401', () => {
    expect(() => service.buildPublicUser(row('[null,7]'))).toThrow(
      UnauthorizedException,
    );
  });

  it('["p1",null] válido continua filtrando o null e preservando "p1" — não lança', () => {
    const out = service.buildPublicUser(row('["p1",null]'));
    expect(out.allowedProjects).toEqual(['p1']);
  });
});
