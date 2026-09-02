import { Test, TestingModule } from '@nestjs/testing';
import { MerchantClassifierController } from './merchant-classifier.controller';
import { MerchantClassifierService } from './merchant-classifier.service';
import { PrismaService } from '../prisma/prisma.service';

describe('MerchantClassifierController.suggest', () => {
  let controller: MerchantClassifierController;
  let svc: { classifyBatch: jest.Mock; resolveLearnedExpenseType: jest.Mock };

  beforeEach(async () => {
    svc = {
      classifyBatch: jest.fn(),
      resolveLearnedExpenseType: jest.fn().mockResolvedValue({
        expenseType: null, source: null, confidence: null, category: null, reason: 'sem-regra',
      }),
    };
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
    const res = await controller.suggest('tenant-1', { text: '' });
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
    const res = await controller.suggest('tenant-1', { text: 'ab' });
    expect(res).toEqual({
      category: null,
      subcategory: null,
      confidence: 0,
      source: 'CACHE',
      suggestedTipoDespesa: null,
    });
    expect(svc.classifyBatch).toHaveBeenCalledTimes(0);
  });

  it('texto válido com hit no classifyBatch → category/subcategory/confidence do resultado + suggestedTipoDespesa da regra aprendida', async () => {
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
    svc.resolveLearnedExpenseType.mockResolvedValue({
      expenseType: 'ALIMENTACAO', source: 'AI_TENANT', confidence: 0.9, category: 'alimentação', reason: 'resolvido',
    });

    const res = await controller.suggest('tenant-1', { text });
    expect(svc.classifyBatch).toHaveBeenCalledWith([text], 'tenant-1');
    expect(res).toEqual({
      category: 'alimentação',
      subcategory: 'delivery',
      confidence: 0.9,
      source: 'AI',
      suggestedTipoDespesa: 'ALIMENTACAO',
    });
  });

  it('#582 PR-2: regra AI < limiar → payload cru mantém category/confidence mas suggestedTipoDespesa é null', async () => {
    const text = 'Ifood';
    const key = MerchantClassifierService.normalizeKey(text);
    svc.classifyBatch.mockResolvedValue(
      new Map([
        [key, { merchant: text, category: 'alimentação', subcategory: null, source: 'AI' as const, confidence: 0.7 }],
      ]),
    );
    svc.resolveLearnedExpenseType.mockResolvedValue({
      expenseType: null, source: null, confidence: null, category: null, reason: 'sub-limiar',
    });

    const res = await controller.suggest('tenant-1', { text });
    expect(res.category).toBe('alimentação');
    expect(res.confidence).toBe(0.7);
    expect(res.suggestedTipoDespesa).toBeNull();
  });

  it('#582 PR-2: regra MANUAL/AI >= limiar → suggestedTipoDespesa preenchido', async () => {
    const text = 'Posto BR';
    const key = MerchantClassifierService.normalizeKey(text);
    svc.classifyBatch.mockResolvedValue(
      new Map([
        [key, { merchant: text, category: 'transporte', subcategory: null, source: 'AI' as const, confidence: 0.95 }],
      ]),
    );
    svc.resolveLearnedExpenseType.mockResolvedValue({
      expenseType: 'TRANSPORTE', source: 'AI_TENANT', confidence: 0.95, category: 'transporte', reason: 'resolvido',
    });

    const res = await controller.suggest('tenant-1', { text });
    expect(res.suggestedTipoDespesa).toBe('TRANSPORTE');
  });

  it('texto válido SEM hit (Map vazio) → tudo null, sem lançar', async () => {
    svc.classifyBatch.mockResolvedValue(new Map());
    const res = await controller.suggest('tenant-1', { text: 'xyz desconhecido' });
    expect(res).toEqual({
      category: null,
      subcategory: null,
      confidence: 0,
      source: 'CACHE',
      suggestedTipoDespesa: null,
    });
  });
});
