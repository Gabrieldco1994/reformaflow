import { RecurrenceController } from './recurrence.controller';

describe('RecurrenceController — requester nas mutações em lote', () => {
  const requester = {
    id: 'u1',
    role: 'USER',
    allowedProjects: ['pessoal'],
    allowedProjectTypes: ['PESSOAL'],
    allowedModules: ['expenses'],
  };

  it('repassa requester completo em update e remove', async () => {
    const service = {
      update: jest.fn().mockResolvedValue({ atualizadas: 0 }),
      remove: jest.fn().mockResolvedValue({ excluidas: 0 }),
    };
    const controller = new RecurrenceController(service as never);

    await controller.update('t1', 'pessoal', 'key', { valor: 100 } as never, requester);
    await controller.remove('t1', 'pessoal', 'key', requester);

    expect(service.update).toHaveBeenCalledWith(
      't1',
      'pessoal',
      'key',
      { valor: 100 },
      requester,
    );
    expect(service.remove).toHaveBeenCalledWith('t1', 'pessoal', 'key', requester);
  });
});
