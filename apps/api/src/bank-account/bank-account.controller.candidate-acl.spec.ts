import { ForbiddenException } from '@nestjs/common';
import { BankAccountController } from './bank-account.controller';

const REQUESTER = {
  id: 'user-480',
  role: 'USER',
  allowedProjects: ['pessoal', 'reforma-visible'],
  allowedProjectTypes: ['PESSOAL', 'REFORMA'],
  allowedModules: ['bankAccounts', 'expenses'],
};

const FILE = {
  buffer: Buffer.from('statement'),
  originalname: 'statement.ofx',
} as Express.Multer.File;

describe('BankAccountController import candidate ACL (#480)', () => {
  it('forwards the authenticated requester to previewImport', async () => {
    const previewImport = jest.fn().mockResolvedValue({ preview: [] });
    const controller = new BankAccountController({ previewImport } as any);

    await controller.importStatement(
      'tenant',
      REQUESTER,
      'pessoal',
      'account',
      [FILE],
      { mode: 'preview', source: 'OFX' },
      undefined,
    );

    expect(previewImport).toHaveBeenCalledWith(
      'tenant',
      'pessoal',
      'account',
      [FILE.buffer],
      FILE.originalname,
      'OFX',
      undefined,
      REQUESTER,
    );
  });

  it('fails closed before calling the service when requester is missing', async () => {
    const previewImport = jest.fn();
    const controller = new BankAccountController({ previewImport } as any);

    await expect(
      controller.importStatement(
        'tenant',
        undefined as any,
        'pessoal',
        'account',
        [FILE],
        { mode: 'preview', source: 'OFX' },
        undefined,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(previewImport).not.toHaveBeenCalled();
  });
});
