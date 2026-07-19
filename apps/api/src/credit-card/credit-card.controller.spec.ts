import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { CreditCardController } from './credit-card.controller';
import { CreditCardService } from './credit-card.service';

describe('CreditCardController.importStatement — decisions parsing', () => {
  let controller: CreditCardController;
  let service: { previewImport: jest.Mock; commitImport: jest.Mock };

  beforeEach(async () => {
    service = {
      previewImport: jest.fn().mockResolvedValue({ ok: 'preview' }),
      commitImport: jest.fn().mockResolvedValue({ ok: 'commit' }),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CreditCardController],
      providers: [{ provide: CreditCardService, useValue: service }],
    })
      // Permite ignorar guards/decorators de tenant em teste unitário
      .overrideGuard({} as any).useValue({ canActivate: () => true })
      .compile()
      .catch(async () => {
        // Fallback: cria controller direto sem módulo (alguns decorators podem brigar)
        return Test.createTestingModule({
          controllers: [CreditCardController],
          providers: [{ provide: CreditCardService, useValue: service }],
        }).compile();
      });
    controller = module.get(CreditCardController);
  });

  const fakeFile = {
    buffer: Buffer.from('OFXHEADER:100\n<OFX></OFX>'),
    originalname: 'fatura.ofx',
  } as any;

  it('decisões JSON válido → repassa array para commitImport', async () => {
    const decisions = [
      { externalId: 'A1', action: 'skip' },
      { externalId: 'A2', overrides: { titulo: 'X' } },
    ];
    await controller.importStatement(
      't1', { id: 'u1' }, 'p1', 'card1',
      [fakeFile],
      { mode: 'commit', source: 'OFX' } as any,
      { decisions: JSON.stringify(decisions) },
    );
    expect(service.commitImport).toHaveBeenCalled();
    const args = service.commitImport.mock.calls[0];
    expect(args[args.length - 2]).toEqual(decisions);
    expect(args[args.length - 1]).toBe('u1');
  });

  it('decisões ausente → repassa undefined', async () => {
    await controller.importStatement(
      't1', { id: 'u1' }, 'p1', 'card1',
      [fakeFile],
      { mode: 'commit', source: 'OFX' } as any,
      undefined,
    );
    expect(service.commitImport).toHaveBeenCalled();
    const args = service.commitImport.mock.calls[0];
    expect(args[args.length - 2]).toBeUndefined();
  });

  it('decisões JSON inválido → BadRequestException', async () => {
    await expect(
      controller.importStatement(
        't1', { id: 'u1' }, 'p1', 'card1',
      [fakeFile],
        { mode: 'commit', source: 'OFX' } as any,
        { decisions: '{not-json' },
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('decisões JSON não-array → trata como undefined (não lança)', async () => {
    await controller.importStatement(
      't1', { id: 'u1' }, 'p1', 'card1',
      [fakeFile],
      { mode: 'commit', source: 'OFX' } as any,
      { decisions: JSON.stringify({ externalId: 'X', action: 'skip' }) },
    );
    expect(service.commitImport).toHaveBeenCalled();
    const args = service.commitImport.mock.calls[0];
    expect(args[args.length - 2]).toBeUndefined();
  });

  it('modo preview ignora decisions', async () => {
    await controller.importStatement(
      't1', { id: 'u1' }, 'p1', 'card1',
      [fakeFile],
      { mode: 'preview', source: 'OFX' } as any,
      { decisions: JSON.stringify([{ externalId: 'A1', action: 'skip' }]) },
    );
    expect(service.previewImport).toHaveBeenCalled();
    expect(service.commitImport).not.toHaveBeenCalled();
  });

  it('arquivo ausente retorna erro', async () => {
    const res = await controller.importStatement(
      't1', { id: 'u1' }, 'p1', 'card1',
      undefined,
      { mode: 'commit', source: 'OFX' } as any,
      undefined,
    );
    expect((res as any).error).toBeDefined();
    expect(service.commitImport).not.toHaveBeenCalled();
  });
});
