import { describe, it, expect } from 'vitest';
import { metaProgressTone } from './metaTone';

describe('metaProgressTone — limiares idênticos aos hoje encapsulados em MetaCategoriaCard', () => {
  it.each([
    [0, 'No limite'],
    [79, 'No limite'],
    [80, 'Atenção'],
    [99, 'Atenção'],
    [100, 'Estourou'],
    [101, 'Estourou'],
    [250, 'Estourou'], // muito acima de 100 continua "Estourou", não uma 4ª categoria
  ] as const)('pct=%d → label %s', (pct, label) => {
    expect(metaProgressTone(pct).label).toBe(label);
  });
});
