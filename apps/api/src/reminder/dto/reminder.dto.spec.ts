import { validate } from 'class-validator';
import { CreateReminderDto, UpdateReminderDto } from './reminder.dto';

const createDto = (input: Partial<CreateReminderDto> = {}) =>
  Object.assign(new CreateReminderDto(), { titulo: 'Trocar óleo', data: '2026-08-01' }, input);

const updateDto = (input: Partial<UpdateReminderDto> = {}) =>
  Object.assign(new UpdateReminderDto(), input);

describe('CreateReminderDto — enums', () => {
  it('accepts a valid enum combination', async () => {
    expect(
      await validate(createDto({ recorrencia: 'MENSAL', status: 'PENDENTE', prioridade: 'ALTA' })),
    ).toEqual([]);
  });

  it('rejects an invalid status', async () => {
    const errors = await validate(createDto({ status: 'foo' } as any));
    expect(errors.map((e) => e.property)).toContain('status');
  });

  it('rejects an invalid recorrencia', async () => {
    const errors = await validate(createDto({ recorrencia: 'BIMESTRAL' } as any));
    expect(errors.map((e) => e.property)).toContain('recorrencia');
  });

  it('rejects an invalid prioridade', async () => {
    const errors = await validate(createDto({ prioridade: 'MAXIMA' } as any));
    expect(errors.map((e) => e.property)).toContain('prioridade');
  });
});

describe('UpdateReminderDto — enums (R1: PATCH tinha os mesmos campos sem @IsIn)', () => {
  it('accepts a valid partial update', async () => {
    expect(await validate(updateDto({ status: 'CONCLUIDO' }))).toEqual([]);
  });

  it('rejects an invalid status — sem isso, um PATCH com status inválido persistia e sumia dos 3 filtros da UI', async () => {
    const errors = await validate(updateDto({ status: 'foo' } as any));
    expect(errors.map((e) => e.property)).toContain('status');
  });

  it('rejects an invalid recorrencia', async () => {
    const errors = await validate(updateDto({ recorrencia: 'BIMESTRAL' } as any));
    expect(errors.map((e) => e.property)).toContain('recorrencia');
  });

  it('rejects an invalid prioridade', async () => {
    const errors = await validate(updateDto({ prioridade: 'MAXIMA' } as any));
    expect(errors.map((e) => e.property)).toContain('prioridade');
  });

  it('allows an empty update (no fields)', async () => {
    expect(await validate(updateDto({}))).toEqual([]);
  });
});
