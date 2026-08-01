import { Test, TestingModule } from '@nestjs/testing';
import { ReceiptController } from './receipt.controller';
import { ReceiptService } from './receipt.service';
import { PrismaService } from '../prisma/prisma.service';
import { MerchantClassifierService } from '../merchant-classifier/merchant-classifier.service';

describe('ReceiptController - link-account (RED test)', () => {
  let controller: ReceiptController;
  let service: ReceiptService;
  let prisma: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ReceiptController],
      providers: [
        ReceiptService,
        {
          provide: PrismaService,
          useValue: {
            receipt: {
              findFirst: jest.fn(),
              update: jest.fn(),
            },
            project: {
              findFirst: jest.fn(),
            },
            bankAccount: {
              findFirst: jest.fn(),
            },
            $transaction: jest.fn((fn) => fn({})),
          },
        },
        {
          provide: MerchantClassifierService,
          useValue: { manualExpenseType: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile();

    controller = module.get<ReceiptController>(ReceiptController);
    service = module.get<ReceiptService>(ReceiptService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  describe('POST /projects/:projectId/receipts/:receiptId/link-account', () => {
    it('should link a receipt to a bank account', async () => {
      const tenantId = 'tenant-1';
      const projectId = 'project-1';
      const receiptId = 'receipt-1';
      const accountId = 'account-1';
      const projectData = {
        id: projectId,
        type: 'PESSOAL',
        tenantId,
      };
      const receiptData = {
        id: receiptId,
        projectId,
        tenantId,
        accountId: null,
        origin: 'none',
        valor: 100000,
        data: new Date(),
        tipo: 'PAGAMENTO',
        status: 'EM_CAIXA',
      };

      const accountData = {
        id: accountId,
        projectId,
        tenantId,
        last4: '1234',
      };

      (prisma.project.findFirst as jest.Mock).mockResolvedValueOnce(
        projectData,
      );
      (prisma.receipt.findFirst as jest.Mock).mockResolvedValueOnce(
        receiptData,
      );
      (prisma.bankAccount.findFirst as jest.Mock).mockResolvedValueOnce(
        accountData,
      );
      (prisma.receipt.update as jest.Mock).mockResolvedValueOnce({
        ...receiptData,
        accountId,
        origin: 'account',
      });

      // This endpoint should exist and be called
      expect(controller.linkAccount).toBeDefined();
    });
  });
});
