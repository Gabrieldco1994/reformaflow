import { buildPlantSchedule } from './plants-schedule';
import type { PlantDiagnosisResult } from './plants-ai.service';

describe('plants schedule', () => {
  it('builds baseline tasks and treatment tasks', () => {
    const diagnosis: PlantDiagnosisResult = {
      especieProvavel: { nomePopular: 'Jiboia', nomeCientifico: 'Epipremnum aureum', confianca: 0.9 },
      saude: { status: 'ATENCAO', confianca: 0.8, sinais: ['manchas nas folhas'] },
      pet: { risco: 'CAUTELA', observacao: 'evitar ingestão' },
      cuidados: { rega: 'regar quando solo secar', luz: 'indireta', poda: 'leve', adubacao: 'mensal', solo: 'drenado' },
      problemasPossiveis: [
        {
          nome: 'fungo foliar',
          gravidade: 'MEDIA',
          probabilidade: 0.7,
          descricao: 'possível infecção inicial',
          planoAcao: ['remover folhas afetadas'],
        },
      ],
    };
    const plan = buildPlantSchedule(diagnosis, 'plant-123', new Date('2026-07-11T00:00:00.000Z'));
    expect(plan.reminders.length).toBeGreaterThanOrEqual(4);
    expect(plan.maintenance.length).toBe(1);
    expect(plan.reminders.some((r) => r.titulo.includes('Regar Jiboia'))).toBe(true);
    expect(plan.reminders.every((r) => r.plantId === 'plant-123')).toBe(true);
    expect(plan.maintenance.every((m) => m.plantId === 'plant-123')).toBe(true);
  });
});
