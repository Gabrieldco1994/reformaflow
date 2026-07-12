import { computeEvalMetrics, findCareReference, findToxicityReference, matchSpecies, normalizeLabel, plantVillageLabelToEvalCase } from './eval-lib';
import type { PlantDiagnosisResult } from './plants-ai.service';

describe('plants-ai eval metrics', () => {
  it('normalizes labels safely', () => {
    expect(normalizeLabel('Costela-de-Adão')).toBe('costela de adao');
  });
  it('finds care reference by common or latin name', () => {
    const reference = [
      { latin: 'Epipremnum aureum', common: ['Pothos', 'Devil\'s Ivy'], watering: 'Let dry', ideallight: 'Bright', toleratedlight: 'Low', insects: ['Mealy bug'], diseases: 'N/A' },
    ];
    expect(findCareReference('Pothos', reference)?.latin).toBe('Epipremnum aureum');
    expect(findCareReference('Epipremnum aureum', reference)?.latin).toBe('Epipremnum aureum');
    expect(findCareReference('Cacto', reference)).toBeUndefined();
  });

  it('finds toxicity reference by scientific name', () => {
    const reference = [
      { name: 'barbados aloe', scientificName: 'aloe barbadensis', family: 'aloaceae', toxicDog: 'toxic', toxicCat: 'toxic', toxicHorse: 'toxic' },
    ];
    expect(findToxicityReference('Aloe barbadensis', reference)?.toxicCat).toBe('toxic');
    expect(findToxicityReference('Ficus lyrata', reference)).toBeUndefined();
  });

  it('matches species on top1/top3', () => {
    const diagnosis: PlantDiagnosisResult = {
      especieProvavel: {
        nomePopular: 'Jiboia',
        nomeCientifico: 'Epipremnum aureum',
        confianca: 0.81,
      },
      especiesAlternativas: [
        { nomePopular: 'Filodendro', nomeCientifico: 'Philodendron sp.', confianca: 0.4 },
      ],
      saude: { status: 'SAUDAVEL', confianca: 0.7, sinais: [] },
      pet: { risco: 'CAUTELA', observacao: '...', fonteReferencia: 'ASPCA' },
      cuidados: { rega: '', luz: '', poda: '', adubacao: '', solo: '' },
      problemasPossiveis: [],
    };
    expect(matchSpecies(diagnosis, 'jiboia')).toEqual({ top1: true, top3: true });
    expect(matchSpecies(diagnosis, 'filodendro')).toEqual({ top1: false, top3: true });
  });

  it('computes aggregate percentages', () => {
    const cases = [
      {
        id: 'c1',
        imagePath: 'x',
        expected: { especie: 'jiboia', saude: 'SAUDAVEL', riscoPet: 'CAUTELA', temProblema: false },
      },
      {
        id: 'c2',
        imagePath: 'y',
        expected: { especie: 'rosa do deserto', saude: 'ATENCAO', riscoPet: 'DESCONHECIDO', temProblema: true },
      },
    ] as const;
    const results = new Map<string, PlantDiagnosisResult>([
      [
        'c1',
        {
          especieProvavel: { nomePopular: 'Jiboia', nomeCientifico: 'Epipremnum aureum', confianca: 0.9 },
          saude: { status: 'SAUDAVEL', confianca: 0.9, sinais: [] },
          pet: { risco: 'CAUTELA', observacao: '' },
          cuidados: { rega: '', luz: '', poda: '', adubacao: '', solo: '' },
          problemasPossiveis: [],
        },
      ],
      [
        'c2',
        {
          especieProvavel: { nomePopular: 'Adenium', nomeCientifico: 'Adenium obesum', confianca: 0.7 },
          saude: { status: 'ATENCAO', confianca: 0.7, sinais: ['mancha'] },
          pet: { risco: 'DESCONHECIDO', observacao: '' },
          cuidados: { rega: '', luz: '', poda: '', adubacao: '', solo: '' },
          problemasPossiveis: [{ nome: 'fungo', gravidade: 'MEDIA', probabilidade: 0.6, descricao: '', planoAcao: [] }],
        },
      ],
    ]);
    const metrics = computeEvalMetrics([...cases], results);
    expect(metrics.total).toBe(2);
    expect(metrics.saudeAccuracy).toBe(100);
    expect(metrics.riscoPetAccuracy).toBe(100);
    expect(metrics.problemaPresenceAccuracy).toBe(100);
  });

  it('maps PlantVillage labels to eval cases', () => {
    const healthy = plantVillageLabelToEvalCase('Apple___healthy', 'img/apple-01.jpg', 'pv-apple-01');
    expect(healthy.expected).toEqual({
      especie: 'Apple',
      saude: 'SAUDAVEL',
      riscoPet: 'DESCONHECIDO',
      temProblema: false,
    });

    const diseased = plantVillageLabelToEvalCase('Tomato___Late_blight', 'img/tomato-01.jpg', 'pv-tomato-01');
    expect(diseased.expected).toEqual({
      especie: 'Tomato',
      saude: 'ATENCAO',
      riscoPet: 'DESCONHECIDO',
      temProblema: true,
    });
  });
});
