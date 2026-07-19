import { Test, TestingModule } from '@nestjs/testing';
import { AgentToolsService, type ToolContext } from './agent-tools.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantFinancialService } from '../../tenant-financial/tenant-financial.service';
import { ExpenseService } from '../../expense/expense.service';
import { ReceiptService } from '../../receipt/receipt.service';
import { CreditCardService } from '../../credit-card/credit-card.service';
import { BankAccountService } from '../../bank-account/bank-account.service';
import { MerchantClassifierService } from '../../merchant-classifier/merchant-classifier.service';
import { PriceMonitorService } from '../../price-compare/price-monitor.service';

describe('create_expense — fallback do MerchantClassifier', () => {
  let service: AgentToolsService;
  let prisma: any;
  let expenses: any;
  let classifier: { classifyBatch: jest.Mock };
  const ctx: ToolContext = { tenantId: 'tenant-1', role: 'ADMIN', projectId: 'proj-1' };

  beforeEach(async () => {
    prisma = {
      project: {
        findFirst: jest.fn().mockResolvedValue({ id: 'proj-1', name: 'Casa', type: 'PESSOAL' }),
      },
      expense: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      creditCard: { findFirst: jest.fn() },
      bankAccount: { findFirst: jest.fn() },
    };
    expenses = {
      create: jest.fn().mockResolvedValue({ id: 'exp-1', titulo: null, fornecedor: null, valorTotal: 10000 }),
    };
    classifier = { classifyBatch: jest.fn().mockResolvedValue(new Map()) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentToolsService,
        { provide: PrismaService, useValue: prisma },
        { provide: TenantFinancialService, useValue: {} },
        { provide: ExpenseService, useValue: expenses },
        { provide: ReceiptService, useValue: {} },
        { provide: CreditCardService, useValue: {} },
        { provide: BankAccountService, useValue: {} },
        { provide: MerchantClassifierService, useValue: classifier },
        { provide: PriceMonitorService, useValue: {} },
      ],
    }).compile();
    service = module.get(AgentToolsService);
  });

  it('tipoDespesa resolve OUTROS + titulo/fornecedor presente → chama classifyBatch e usa a categoria mapeada se houver', async () => {
    classifier.classifyBatch.mockResolvedValue(
      new Map([
        [
          MerchantClassifierService.normalizeKey('Ifood'),
          { merchant: 'Ifood', category: 'alimentação', subcategory: null, source: 'AI' as const, confidence: 0.9 },
        ],
      ]),
    );

    const res: any = await service.execute('create_expense', ctx, {
      valor: '50,00',
      fornecedor: 'Ifood',
    });

    expect(classifier.classifyBatch).toHaveBeenCalledWith(['Ifood']);
    expect(res.error).toBeUndefined();
    expect(res.despesa.tipoDespesa).toBe('ALIMENTACAO');
    expect(expenses.create).toHaveBeenCalledWith(
      'tenant-1',
      'proj-1',
      expect.objectContaining({ tipoDespesa: 'ALIMENTACAO' }),
      null,
    );
  });

  it('agente já infere tipoDespesa != OUTROS → NUNCA chama o classifier', async () => {
    const res: any = await service.execute('create_expense', ctx, {
      valor: '50,00',
      fornecedor: 'Ifood',
      tipoDespesa: 'ALIMENTACAO',
    });

    expect(classifier.classifyBatch).not.toHaveBeenCalled();
    expect(res.error).toBeUndefined();
    expect(res.despesa.tipoDespesa).toBe('ALIMENTACAO');
  });

  it('tipoDespesa OUTROS mas sem titulo nem fornecedor → não chama o classifier', async () => {
    const res: any = await service.execute('create_expense', ctx, {
      valor: '50,00',
    });

    expect(classifier.classifyBatch).not.toHaveBeenCalled();
    expect(res.error).toBeUndefined();
    expect(res.despesa.tipoDespesa).toBe('OUTROS');
  });

  it('classifier sem hit válido → mantém OUTROS, não lança', async () => {
    classifier.classifyBatch.mockResolvedValue(new Map());

    const res: any = await service.execute('create_expense', ctx, {
      valor: '50,00',
      fornecedor: 'Loja Desconhecida XYZ',
    });

    expect(classifier.classifyBatch).toHaveBeenCalled();
    expect(res.error).toBeUndefined();
    expect(res.despesa.tipoDespesa).toBe('OUTROS');
  });

  it('repassa ctx.userId como createdByUserId (KPI "despesas criadas" via Maria/voz depende disso)', async () => {
    const ctxWithUser: ToolContext = { ...ctx, userId: 'user-maria-1' };

    await service.execute('create_expense', ctxWithUser, {
      valor: '50,00',
      fornecedor: 'Ifood',
      tipoDespesa: 'ALIMENTACAO',
    });

    expect(expenses.create).toHaveBeenCalledWith(
      'tenant-1',
      'proj-1',
      expect.any(Object),
      'user-maria-1',
    );
  });
});
