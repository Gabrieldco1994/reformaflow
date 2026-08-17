import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TenantService } from './tenant.service';

describe('TenantService.remove', () => {
  function makeService(overrides: { tenant?: unknown } = {}) {
    const prisma = {
      tenant: {
        findUnique: jest.fn().mockResolvedValue(
          'tenant' in overrides ? overrides.tenant : { id: 't2', name: 'Tenant Teste' },
        ),
        delete: jest.fn(),
      },
      project: { deleteMany: jest.fn() },
      user: { deleteMany: jest.fn() },
    } as any;
    return { service: new TenantService(prisma), prisma };
  }

  it('blocks excluding the requester\'s own tenant', async () => {
    const { service } = makeService();
    await expect(service.remove('t1', 't1')).rejects.toThrow(BadRequestException);
  });

  it('404s when the tenant does not exist', async () => {
    const { service } = makeService({ tenant: null });
    await expect(service.remove('t2', 't1')).rejects.toThrow(NotFoundException);
  });

  it('cascades: deletes projects, then users, then the tenant', async () => {
    const { service, prisma } = makeService();
    await service.remove('t2', 't1');
    expect(prisma.project.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 't2' } });
    expect(prisma.user.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 't2' } });
    expect(prisma.tenant.delete).toHaveBeenCalledWith({ where: { id: 't2' } });
  });
});

/**
 * B0 (#447) — `TenantService.create` hoje grava `role: 'OWNER'` para o
 * usuário-dono do tenant recém-criado. O programa #436 é explícito: "nenhum
 * OWNER na matriz" / "Fora de escopo: OWNER/accessRole" (ver #446 GREEN e a
 * invariante global do #436). Este writer é o único caminho de criação de
 * tenant que ainda produz OWNER; ele precisa gravar ADMIN, igual a
 * `registerGuest` (`AuthService`). O signup self-service (`registerOwner`)
 * já grava `USER` (`SELF_SERVICE_ROLE`) e não muda neste programa.
 */
describe('TenantService.create — nunca grava OWNER (B0 #447)', () => {
  function makeService() {
    const prisma = {
      tenant: {
        create: jest.fn(({ data }: any) =>
          Promise.resolve({
            id: 't-new',
            name: data.name,
            users: [{ id: 'u-new', ...data.users.create }],
          }),
        ),
      },
    } as any;
    return { service: new TenantService(prisma), prisma };
  }

  it('grava role=ADMIN para o dono do tenant, nunca OWNER', async () => {
    const { service, prisma } = makeService();

    await service.create({
      name: 'Tenant novo',
      ownerUsername: 'dono',
      ownerName: 'Dono Novo',
    } as any);

    expect(prisma.tenant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          users: expect.objectContaining({
            create: expect.objectContaining({ role: 'ADMIN' }),
          }),
        }),
      }),
    );
  });
});
