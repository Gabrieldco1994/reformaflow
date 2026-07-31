import { Test, TestingModule } from '@nestjs/testing';
import { MerchantClassifierController } from './merchant-classifier.controller';
import { MerchantClassifierService } from './merchant-classifier.service';
import { PrismaService } from '../prisma/prisma.service';

describe('MerchantClassifierController rule endpoints', () => {
  let controller: MerchantClassifierController;
  let svc: { setManual: jest.Mock; removeManual: jest.Mock; classifyBatch: jest.Mock; promoteGlobal: jest.Mock };

  beforeEach(async () => {
    svc = {
      setManual: jest.fn(),
      removeManual: jest.fn(),
      classifyBatch: jest.fn(),
      promoteGlobal: jest.fn(),
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

  it('confirm-rule salva regra manual a partir de tipoDespesa', async () => {
    svc.setManual.mockResolvedValue({ merchantKey: 'padaria-do-joao' });
    const res = await controller.confirmRule('tenant-1', {
      merchant: 'Padaria do João',
      tipoDespesa: 'ALIMENTACAO',
    });
    expect(svc.setManual).toHaveBeenCalledWith('Padaria do João', 'alimentação', null, 'tenant-1');
    expect(res).toEqual({
      merchantKey: 'padaria-do-joao',
      category: 'alimentação',
      ruleCreated: true,
    });
  });

  // Só ~10 dos ~30 tipos têm categoria de merchant. Recusar os outros com 4xx
  // fazia a UI dizer "não foi possível" DEPOIS de já ter mudado a categoria.
  it('confirm-rule aceita tipoDespesa sem mapeamento, sem criar regra', async () => {
    const res = await controller.confirmRule('tenant-1', { merchant: 'Lançamento', tipoDespesa: 'OUTROS' });
    expect(res).toEqual({ merchantKey: '', category: null, ruleCreated: false });
    expect(svc.setManual).not.toHaveBeenCalled();
  });

  it.each(['INVESTIMENTOS', 'SUPERMERCADO', 'PIX_ENVIADO', 'MOVIMENTACAO_INTERNA'])(
    'confirm-rule não estoura para %s (tipo comum sem categoria de merchant)',
    async (tipoDespesa) => {
      await expect(
        controller.confirmRule('tenant-1', { merchant: 'Pagamento APTO', tipoDespesa }),
      ).resolves.toMatchObject({ ruleCreated: false });
    },
  );

  it('remove-rule remove apenas regra manual normalizada, escopada ao tenant', async () => {
    svc.removeManual.mockResolvedValue({ merchantKey: 'padaria-do-joao', deleted: true });
    const res = await controller.removeRule('tenant-1', { merchant: 'Padaria do João' });
    expect(svc.removeManual).toHaveBeenCalledWith('Padaria do João', 'tenant-1');
    expect(res).toEqual({ merchantKey: 'padaria-do-joao', deleted: true });
  });

  it('promote-global usa promoteGlobal (tenantId null) a partir de tipoDespesa', async () => {
    svc.promoteGlobal.mockResolvedValue({ merchantKey: 'posto-ipiranga' });
    const res = await controller.promoteGlobal({ merchant: 'Posto Ipiranga', tipoDespesa: 'TRANSPORTE' });
    expect(svc.promoteGlobal).toHaveBeenCalledWith('Posto Ipiranga', 'transporte', null);
    expect(res).toEqual({ merchantKey: 'posto-ipiranga', category: 'transporte', ruleCreated: true });
  });
});
