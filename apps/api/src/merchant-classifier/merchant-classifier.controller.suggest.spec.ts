import { Test, TestingModule } from '@nestjs/testing';
import { MerchantClassifierController } from './merchant-classifier.controller';
import { MerchantClassifierService } from './merchant-classifier.service';
import { PrismaService } from '../prisma/prisma.service';

describe('MerchantClassifierController.suggest', () => {
  let controller: MerchantClassifierController;
  let svc: { classifyBatch: jest.Mock };

  beforeEach(async () => {
    svc = { classifyBatch: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MerchantClassifierController],
      providers: [
        { provide: MerchantClassifierService, useValue: svc },
        { provide: PrismaService, useValue: {} },
      ],
    }).compile();
    controller = module.get(MerchantClassifierController);
  });

  it('texto vazio → resposta neutra sem chamar classifyBatch', async () => {
    const res = await controller.suggest({ text: '' });
    expect(res).toEqual({
      category: null,
      subcategory: null,
      confidence: 0,
      source: 'CACHE',
      suggestedTipoDespesa: null,
    });
    expect(svc.classifyBatch).toHaveBeenCalledTimes(0);
  });

  it('texto com 2 chars (abaixo do mínimo 3) → resposta neutra sem chamar classifyBatch', async () => {
    const res = await controller.suggest({ text: 'ab' });
    expect(res).toEqual({
      category: null,
      subcategory: null,
      confidence: 0,
      source: 'CACHE',
      suggestedTipoDespesa: null,
    });
    expect(svc.classifyBatch).toHaveBeenCalledTimes(0);
  });

  it('texto válido com hit no classifyBatch → category/subcategory/confidence do resultado + suggestedTipoDespesa mapeado (ex.: "alimentação" → "ALIMENTACAO")', async () => {
    const text = 'Ifood';
    const key = MerchantClassifierService.normalizeKey(text);
    svc.classifyBatch.mockResolvedValue(
      new Map([
        [
          key,
          {
            merchant: text,
            category: 'alimentação',
            subcategory: 'delivery',
            source: 'AI' as const,
            confidence: 0.9,
          },
        ],
      ]),
    );

    const res = await controller.suggest({ text });
    expect(svc.classifyBatch).toHaveBeenCalledWith([text]);
    expect(res).toEqual({
      category: 'alimentação',
      subcategory: 'delivery',
      confidence: 0.9,
      source: 'AI',
      suggestedTipoDespesa: 'ALIMENTACAO',
    });
  });

  it('texto válido SEM hit (Map vazio) → tudo null, sem lançar', async () => {
    svc.classifyBatch.mockResolvedValue(new Map());
    const res = await controller.suggest({ text: 'xyz desconhecido' });
    expect(res).toEqual({
      category: null,
      subcategory: null,
      confidence: 0,
      source: 'CACHE',
      suggestedTipoDespesa: null,
    });
  });
});
