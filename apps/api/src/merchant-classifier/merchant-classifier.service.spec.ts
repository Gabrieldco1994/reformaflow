import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ExpenseType } from '@reformaflow/domain';
import { MERCHANT_CATEGORIES, MERCHANT_TO_EXPENSE_TYPE, MerchantClassifierService } from './merchant-classifier.service';
import { PrismaService } from '../prisma/prisma.service';

describe('MERCHANT_TO_EXPENSE_TYPE export', () => {
  it('mapeia toda MERCHANT_CATEGORIES para um ExpenseType válido', () => {
    for (const cat of MERCHANT_CATEGORIES) {
      expect(MERCHANT_TO_EXPENSE_TYPE[cat]).toBeDefined();
      expect(Object.values(ExpenseType)).toContain(MERCHANT_TO_EXPENSE_TYPE[cat]);
    }
  });
});

describe('MerchantClassifierService.removeManual — tenantId validation (#605)', () => {
  let service: MerchantClassifierService;
  let prismaService: {
    merchantCategory: {
      deleteMany: jest.Mock;
    };
  };

  beforeEach(async () => {
    prismaService = {
      merchantCategory: {
        deleteMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MerchantClassifierService,
        {
          provide: PrismaService,
          useValue: prismaService,
        },
      ],
    }).compile();

    service = module.get<MerchantClassifierService>(MerchantClassifierService);
  });

  describe('removeManual rejeita tenantId ausente/vazio', () => {
    it('rejeita quando tenantId é undefined', async () => {
      await expect(
        service.removeManual('Padaria do João', undefined as any),
      ).rejects.toThrow(BadRequestException);
      expect(prismaService.merchantCategory.deleteMany).not.toHaveBeenCalled();
    });

    it('rejeita quando tenantId é string vazia', async () => {
      await expect(
        service.removeManual('Padaria do João', ''),
      ).rejects.toThrow(BadRequestException);
      expect(prismaService.merchantCategory.deleteMany).not.toHaveBeenCalled();
    });

    it('rejeita quando tenantId é null', async () => {
      await expect(
        service.removeManual('Padaria do João', null as any),
      ).rejects.toThrow(BadRequestException);
      expect(prismaService.merchantCategory.deleteMany).not.toHaveBeenCalled();
    });

    it('mensagem de erro identifica o problema', async () => {
      try {
        await service.removeManual('Teste', undefined as any);
        fail('deveria ter lançado');
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const response = (err as BadRequestException).getResponse();
        expect(typeof response === 'object' && response !== null).toBe(true);
        expect((response as any).message).toContain('tenantId');
      }
    });
  });

  describe('removeManual processa corretamente com tenantId válido', () => {
    it('chama deleteMany com tenantId quando fornecido', async () => {
      prismaService.merchantCategory.deleteMany.mockResolvedValue({ count: 1 });

      await service.removeManual('Padaria do João', 'tenant-123');

      expect(prismaService.merchantCategory.deleteMany).toHaveBeenCalledWith({
        where: {
          merchantKey: 'padaria do joao',
          tenantId: 'tenant-123',
          source: 'MANUAL',
        },
      });
    });

    it('retorna deleted: true quando deleteMany remove registros', async () => {
      prismaService.merchantCategory.deleteMany.mockResolvedValue({ count: 1 });

      const result = await service.removeManual('Padaria do João', 'tenant-123');

      expect(result).toEqual({
        merchantKey: 'padaria do joao',
        deleted: true,
      });
    });

    it('retorna deleted: false quando deleteMany não encontra registros', async () => {
      prismaService.merchantCategory.deleteMany.mockResolvedValue({ count: 0 });

      const result = await service.removeManual('Padaria do João', 'tenant-123');

      expect(result).toEqual({
        merchantKey: 'padaria do joao',
        deleted: false,
      });
    });
  });
});

describe('classifyBatch — SEC-2 guard + SEC-3 preserva MANUAL (#582 PR-1)', () => {
  let service: MerchantClassifierService;
  let prisma: {
    merchantCategory: {
      findMany: jest.Mock;
      create: jest.Mock;
      createMany: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      upsert: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  const RAW = 'Padaria Sigilosa 582';
  const KEY = MerchantClassifierService.normalizeKey(RAW);
  const TENANT = 'tenant-582';

  beforeEach(async () => {
    prisma = {
      merchantCategory: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({}),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        upsert: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn().mockImplementation(async (arg: any) =>
        typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
      ),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MerchantClassifierService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(MerchantClassifierService);
    (service as any).apiKey = 'test-key-582';
  });

  describe('SEC-2 — tenantId ausente rejeita antes de qualquer I/O', () => {
    it.each([
      ['string vazia', ''],
      ['undefined', undefined],
      ['null', null],
    ])('classifyBatch(_, %s) → BadRequestException e nenhum read/write', async (_label, tid) => {
      await expect(
        service.classifyBatch(['Loja X'], tid as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.merchantCategory.findMany).not.toHaveBeenCalled();
      expect(prisma.merchantCategory.createMany).not.toHaveBeenCalled();
      expect(prisma.merchantCategory.create).not.toHaveBeenCalled();
      expect(prisma.merchantCategory.update).not.toHaveBeenCalled();
      expect(prisma.merchantCategory.upsert).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('SEC-3 — persistência não usa upsert/update incondicional', () => {
    beforeEach(() => {
      jest.spyOn(service as any, 'callGemini').mockResolvedValue([
        { merchant: RAW, category: 'transporte', subcategory: null, confidence: 0.9 },
      ]);
    });

    it('chave nova → createMany com source AI e a confidence do Gemini; nunca upsert/update', async () => {
      prisma.merchantCategory.findMany.mockResolvedValue([]);

      const result = await service.classifyBatch([RAW], TENANT);

      expect(prisma.merchantCategory.upsert).not.toHaveBeenCalled();
      expect(prisma.merchantCategory.update).not.toHaveBeenCalled();
      expect(prisma.merchantCategory.createMany).toHaveBeenCalledTimes(1);
      const data = prisma.merchantCategory.createMany.mock.calls[0][0].data;
      const rows = Array.isArray(data) ? data : [data];
      expect(rows).toEqual([
        expect.objectContaining({
          tenantId: TENANT,
          merchantKey: KEY,
          category: 'transporte',
          source: 'AI',
          confidence: 0.9,
        }),
      ]);
      expect(result.get(KEY)).toMatchObject({ category: 'transporte', source: 'AI', confidence: 0.9 });
    });

    it('qualquer updateMany de merchantCategory é filtrado por source:"AI"', async () => {
      prisma.merchantCategory.findMany.mockResolvedValue([
        { tenantId: TENANT, merchantKey: KEY, category: 'alimentação', subcategory: null, source: 'AI', confidence: 0.6 },
      ]);

      await service.classifyBatch([RAW], TENANT);

      for (const call of prisma.merchantCategory.updateMany.mock.calls) {
        expect(call[0].where).toEqual(expect.objectContaining({ source: 'AI', tenantId: TENANT }));
      }
      for (const call of prisma.merchantCategory.update.mock.calls) {
        expect(call[0].where).toEqual(expect.objectContaining({ tenantId_merchantKey: expect.anything() }));
      }
    });

    it('re-leitura DENTRO da tx: chave que virou MANUAL durante o Gemini NÃO é sobrescrita e o Map reflete MANUAL', async () => {
      prisma.merchantCategory.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { tenantId: TENANT, merchantKey: KEY, category: 'alimentação', subcategory: null, source: 'MANUAL', confidence: 1 },
        ]);

      const result = await service.classifyBatch([RAW], TENANT);

      for (const call of prisma.merchantCategory.createMany.mock.calls) {
        const data = call[0].data;
        const rows = Array.isArray(data) ? data : [data];
        expect(rows.map((r: any) => r.merchantKey)).not.toContain(KEY);
      }
      expect(prisma.merchantCategory.upsert).not.toHaveBeenCalled();
      expect(result.get(KEY)).toMatchObject({ category: 'alimentação', source: 'MANUAL', confidence: 1 });
      expect(result.get(KEY)!.category).not.toBe('transporte');
    });
  });
});
