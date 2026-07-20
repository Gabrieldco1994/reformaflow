import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { MerchantClassifierController } from './merchant-classifier.controller';
import { MerchantClassifierService } from './merchant-classifier.service';
import { PrismaService } from '../prisma/prisma.service';

describe('MerchantClassifierController rule endpoints', () => {
  let controller: MerchantClassifierController;
  let svc: { setManual: jest.Mock; removeManual: jest.Mock; classifyBatch: jest.Mock };

  beforeEach(async () => {
    svc = {
      setManual: jest.fn(),
      removeManual: jest.fn(),
      classifyBatch: jest.fn(),
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
    const res = await controller.confirmRule({
      merchant: 'Padaria do João',
      tipoDespesa: 'ALIMENTACAO',
    });
    expect(svc.setManual).toHaveBeenCalledWith('Padaria do João', 'alimentação', null);
    expect(res).toEqual({ merchantKey: 'padaria-do-joao', category: 'alimentação' });
  });

  it('confirm-rule rejeita tipoDespesa sem mapeamento', async () => {
    await expect(
      controller.confirmRule({ merchant: 'Lançamento', tipoDespesa: 'OUTROS' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(svc.setManual).not.toHaveBeenCalled();
  });

  it('remove-rule remove apenas regra manual normalizada', async () => {
    svc.removeManual.mockResolvedValue({ merchantKey: 'padaria-do-joao', deleted: true });
    const res = await controller.removeRule({ merchant: 'Padaria do João' });
    expect(svc.removeManual).toHaveBeenCalledWith('Padaria do João');
    expect(res).toEqual({ merchantKey: 'padaria-do-joao', deleted: true });
  });
});
