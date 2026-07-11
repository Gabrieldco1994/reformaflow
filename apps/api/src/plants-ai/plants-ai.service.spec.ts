import { PlantsAiService } from './plants-ai.service';

describe('PlantsAiService', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-key';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
    jest.restoreAllMocks();
  });

  it('normalizes the returned common name from JBRJ after Gemini responds', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    especieProvavel: {
                      nomePopular: 'nome genérico',
                      nomeCientifico: 'Abarema cochliacarpos',
                      confianca: 0.91,
                    },
                    especiesAlternativas: [],
                    saude: { status: 'SAUDAVEL', confianca: 0.8, sinais: [] },
                    pet: { risco: 'DESCONHECIDO', observacao: '' },
                    cuidados: { rega: '', luz: '', poda: '', adubacao: '', solo: '' },
                    problemasPossiveis: [],
                  }),
                },
              ],
            },
          },
        ],
      }),
    }) as typeof fetch;

    const service = new PlantsAiService(
      {
        project: {
          findFirst: jest.fn().mockResolvedValue({ id: 'project-1', type: 'PLANTAS' }),
        },
      } as never,
      {} as never,
    );

    const diagnosis = await service.diagnose('tenant-1', 'project-1', {
      buffer: Buffer.from('fake-image'),
      mimetype: 'image/jpeg',
      originalname: 'leaf.jpg',
    } as Express.Multer.File);

    expect(diagnosis.especieProvavel.nomePopular).toBe('bordão-de-velho');
  });
});
