import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SaveJourneyDto } from './save-journey.dto';

function validate(payload: unknown) {
  const dto = plainToInstance(SaveJourneyDto, payload);
  return validateSync(dto as object, { whitelist: true, forbidNonWhitelisted: true });
}

describe('SaveJourneyDto', () => {
  it('aceita um passo bem formado', () => {
    expect(
      validate({
        steps: [
          {
            stepKey: 'bank',
            order: 0,
            enabled: true,
            skippable: false,
            label: 'Conta',
            subtitle: 'Saldo inicial',
          },
        ],
      }),
    ).toHaveLength(0);
  });

  it('rejeita body vazio e steps que não é array', () => {
    expect(validate({}).length).toBeGreaterThan(0);
    expect(validate({ steps: [] }).length).toBeGreaterThan(0);
    expect(validate({ steps: 'bank' }).length).toBeGreaterThan(0);
  });

  it('rejeita order negativo ou não-inteiro', () => {
    const base = { stepKey: 'bank', enabled: true, skippable: true };
    expect(validate({ steps: [{ ...base, order: -1 }] }).length).toBeGreaterThan(0);
    expect(validate({ steps: [{ ...base, order: 1.5 }] }).length).toBeGreaterThan(0);
  });

  it('rejeita enabled/skippable ausentes ou não-booleanos', () => {
    expect(validate({ steps: [{ stepKey: 'bank', order: 0 }] }).length).toBeGreaterThan(0);
    expect(
      validate({ steps: [{ stepKey: 'bank', order: 0, enabled: 'sim', skippable: true }] })
        .length,
    ).toBeGreaterThan(0);
  });

  it('rejeita stepKey vazio', () => {
    expect(
      validate({ steps: [{ stepKey: '  ', order: 0, enabled: true, skippable: true }] })
        .length,
    ).toBeGreaterThan(0);
  });

  it('limita o tamanho de label (60) e subtitle (200)', () => {
    const base = { stepKey: 'bank', order: 0, enabled: true, skippable: true };
    expect(validate({ steps: [{ ...base, label: 'x'.repeat(61) }] }).length).toBeGreaterThan(0);
    expect(validate({ steps: [{ ...base, label: 'x'.repeat(60) }] })).toHaveLength(0);
    expect(
      validate({ steps: [{ ...base, subtitle: 'x'.repeat(201) }] }).length,
    ).toBeGreaterThan(0);
    expect(validate({ steps: [{ ...base, subtitle: 'x'.repeat(200) }] })).toHaveLength(0);
  });

  it('aceita label/subtitle nulos (voltar ao texto padrão)', () => {
    expect(
      validate({
        steps: [
          { stepKey: 'bank', order: 0, enabled: true, skippable: true, label: null, subtitle: null },
        ],
      }),
    ).toHaveLength(0);
  });
});
