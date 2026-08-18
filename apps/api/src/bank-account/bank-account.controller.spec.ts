import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { BankAccountController } from './bank-account.controller';
import { BankAccountService } from './bank-account.service';

describe('BankAccountController.importStatement — decisions parsing', () => {
  let controller: BankAccountController;
  let service: {
    previewImport: jest.Mock;
    commitImport: jest.Mock;
    undoImport: jest.Mock;
    unlinkExpense: jest.Mock;
    linkToReceipt: jest.Mock;
    unlinkReceipt: jest.Mock;
  };

  beforeEach(async () => {
    service = {
      previewImport: jest.fn().mockResolvedValue({ ok: 'preview' }),
      commitImport: jest.fn().mockResolvedValue({ ok: 'commit' }),
      undoImport: jest.fn().mockResolvedValue({ ok: true }),
      unlinkExpense: jest.fn().mockResolvedValue({ ok: true }),
      linkToReceipt: jest.fn().mockResolvedValue({ ok: true }),
      unlinkReceipt: jest.fn().mockResolvedValue({ ok: true }),
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
      't1', { id: 'u1' }, 'p1', 'acc1',
      [fakeFile],
      { mode: 'commit', source: 'OFX' } as any,
      { decisions: JSON.stringify(decisions) },
    );
    expect(service.commitImport).toHaveBeenCalled();
    const args = service.commitImport.mock.calls[0];
    expect(args[args.length - 3]).toEqual(decisions);
    expect(args[args.length - 2]).toBe('u1');
    expect(args[args.length - 1]).toEqual({ id: 'u1' });
  });

  it('decisões JSON inválido → BadRequestException', async () => {
    await expect(
      controller.importStatement(
        't1', { id: 'u1' }, 'p1', 'acc1',
      [fakeFile],
        { mode: 'commit', source: 'OFX' } as any,
        { decisions: '{broken' },
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('modo preview ignora decisions', async () => {
    await controller.importStatement(
      't1', { id: 'u1' }, 'p1', 'acc1',
      [fakeFile],
      { mode: 'preview', source: 'OFX' } as any,
      { decisions: JSON.stringify([{ externalId: 'A', action: 'skip' }]) },
    );
    expect(service.previewImport).toHaveBeenCalled();
    expect(service.commitImport).not.toHaveBeenCalled();
  });

  it('arquivo ausente retorna erro', async () => {
    const res = await controller.importStatement(
      't1', { id: 'u1' }, 'p1', 'acc1',
      undefined,
      { mode: 'commit', source: 'OFX' } as any,
      undefined,
    );
    expect((res as any).error).toBeDefined();
    expect(service.commitImport).not.toHaveBeenCalled();
  });

  it('undo-import e unlink repassam o requester completo', async () => {
    const requester = { id: 'u1', role: 'USER', allowedProjects: ['p1'] };
    await controller.undoImport('t1', 'p1', 'acc1', 'imp1', requester);
    await controller.unlink('t1', 'p1', 'expense1', requester);
    expect(service.undoImport).toHaveBeenCalledWith('t1', 'p1', 'acc1', 'imp1', requester);
    expect(service.unlinkExpense).toHaveBeenCalledWith('t1', 'p1', 'expense1', requester);
  });

  it('link e unlink de recebimento repassam o requester completo', async () => {
    const requester = { id: 'u1', role: 'USER', allowedProjects: ['p1'] };
    await controller.linkToReceipt(
      't1',
      'p1',
      'receipt1',
      { targetReceiptId: 'target1' },
      requester,
    );
    await controller.unlinkReceiptEndpoint('t1', 'p1', 'receipt1', requester);
    expect(service.linkToReceipt).toHaveBeenCalledWith(
      't1',
      'p1',
      'receipt1',
      'target1',
      requester,
    );
    expect(service.unlinkReceipt).toHaveBeenCalledWith('t1', 'p1', 'receipt1', requester);
  });
});
