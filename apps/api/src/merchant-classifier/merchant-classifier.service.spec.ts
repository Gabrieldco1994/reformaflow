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
