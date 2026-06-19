import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { BankAccountController } from './bank-account.controller';
import { BankAccountService } from './bank-account.service';

describe('BankAccountController.importStatement — decisions parsing', () => {
  let controller: BankAccountController;
  let service: { previewImport: jest.Mock; commitImport: jest.Mock };

  beforeEach(async () => {
    service = {
      previewImport: jest.fn().mockResolvedValue({ ok: 'preview' }),
      commitImport: jest.fn().mockResolvedValue({ ok: 'commit' }),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BankAccountController],
      providers: [{ provide: BankAccountService, useValue: service }],
    }).compile();
    controller = module.get(BankAccountController);
  });

  const fakeFile = {
    buffer: Buffer.from('OFXHEADER:100\n<OFX></OFX>'),
    originalname: 'extrato.ofx',
  } as any;

  it('decisões JSON válido com linkToReceiptId → repassa', async () => {
    const decisions = [
      { externalId: 'B1', action: 'link', linkToReceiptId: 'rec1' },
      { externalId: 'B2', action: 'skip' },
    ];
    await controller.importStatement(
      't1', 'p1', 'acc1',
      [fakeFile],
      { mode: 'commit', source: 'OFX' } as any,
      { decisions: JSON.stringify(decisions) },
    );
    expect(service.commitImport).toHaveBeenCalled();
    const args = service.commitImport.mock.calls[0];
    expect(args[args.length - 1]).toEqual(decisions);
  });

  it('decisões JSON inválido → BadRequestException', async () => {
    await expect(
      controller.importStatement(
        't1', 'p1', 'acc1',
      [fakeFile],
        { mode: 'commit', source: 'OFX' } as any,
        { decisions: '{broken' },
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('modo preview ignora decisions', async () => {
    await controller.importStatement(
      't1', 'p1', 'acc1',
      [fakeFile],
      { mode: 'preview', source: 'OFX' } as any,
      { decisions: JSON.stringify([{ externalId: 'A', action: 'skip' }]) },
    );
    expect(service.previewImport).toHaveBeenCalled();
    expect(service.commitImport).not.toHaveBeenCalled();
  });

  it('arquivo ausente retorna erro', async () => {
    const res = await controller.importStatement(
      't1', 'p1', 'acc1',
      undefined,
      { mode: 'commit', source: 'OFX' } as any,
      undefined,
    );
    expect((res as any).error).toBeDefined();
    expect(service.commitImport).not.toHaveBeenCalled();
  });
});
