import { ConflictException } from '@nestjs/common';
import { ReminderService } from './reminder.service';

describe('ReminderService.update recurrence advance', () => {
  const existing = {
    id: 'r1',
    tenantId: 't1',
    projectId: 'p1',
    titulo: 'Regar planta',
    recorrencia: 'SEMANAL',
    data: new Date('2026-07-14T00:00:00Z'),
    status: 'PENDENTE',
  };

  function makeService(update = jest.fn()) {
    const prisma = {
      reminder: {
        findFirst: jest.fn().mockResolvedValue(existing),
        update,
      },
    } as any;
    return { service: new ReminderService(prisma), update };
  }

  it('advances SEMANAL reminder by 7 days and resets to PENDENTE on CONCLUIDO', async () => {
    const { service, update } = makeService();
    await service.update('t1', 'p1', 'r1', { status: 'CONCLUIDO' } as any);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { status: 'PENDENTE', data: new Date('2026-07-21T00:00:00Z') },
    });
  });

  it('leaves UNICA reminders CONCLUIDO without advancing', async () => {
    const { service, update } = makeService();
    const unica = { ...existing, recorrencia: 'UNICA' };
    (service as any).findById = jest.fn().mockResolvedValue(unica);
    await service.update('t1', 'p1', 'r1', { status: 'CONCLUIDO' } as any);
    expect(update).toHaveBeenCalledWith({ where: { id: 'r1' }, data: { status: 'CONCLUIDO' } });
  });

  it('rejects updates to reminders managed by vehicle documents', async () => {
    const { service, update } = makeService();
    const managed = {
      ...existing,
      generatedBy: 'VEHICLE_DOCUMENT',
    };
    (service as any).findById = jest.fn().mockResolvedValue(managed);

    await expect(
      service.update('t1', 'p1', 'r1', { status: 'CONCLUIDO' } as any),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(update).not.toHaveBeenCalled();
  });
});
