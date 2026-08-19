import { ForbiddenException } from '@nestjs/common';
import { CreditCardController } from './credit-card.controller';

const REQUESTER = {
  id: 'user-480',
  role: 'USER',
  allowedProjects: ['pessoal', 'reforma-visible'],
  allowedProjectTypes: ['PESSOAL', 'REFORMA'],
  allowedModules: ['creditCards', 'expenses'],
};

const FILE = {
  buffer: Buffer.from('statement'),
  originalname: 'statement.ofx',
} as Express.Multer.File;

describe('CreditCardController import candidate ACL (#480)', () => {
  it('forwards the authenticated requester to previewImport', async () => {
    const previewImport = jest.fn().mockResolvedValue({ preview: [] });
    const controller = new CreditCardController({ previewImport } as any);

    await controller.importStatement(
      'tenant',
      REQUESTER,
      'pessoal',
      'card',
      [FILE],
      { mode: 'preview', source: 'OFX' },
      undefined,
    );

    expect(previewImport).toHaveBeenCalledWith(
      'tenant',
      'pessoal',
      'card',
      [FILE.buffer],
      FILE.originalname,
      'OFX',
      undefined,
      REQUESTER,
    );
  });

  it('fails closed before calling the service when requester is missing', async () => {
    const previewImport = jest.fn();
    const controller = new CreditCardController({ previewImport } as any);

    await expect(
      controller.importStatement(
        'tenant',
        undefined as any,
        'pessoal',
        'card',
        [FILE],
        { mode: 'preview', source: 'OFX' },
        undefined,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(previewImport).not.toHaveBeenCalled();
  });
});
