import * as bcrypt from 'bcrypt';
import { ensureBootstrapAdmin } from './main';

jest.mock('bcrypt', () => ({
  hash: jest.fn(),
}));

describe('ensureBootstrapAdmin', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.ADMIN_USERNAME = 'gabrieldco';
    process.env.ADMIN_PASSWORD = 'G@123123';
    delete process.env.ADMIN_EMAIL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('preserves an existing admin password hash', async () => {
    const prisma = {
      tenant: {
        findFirst: jest.fn().mockResolvedValue({ id: 'tenant-1' }),
        create: jest.fn(),
      },
      user: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'user-1',
          role: 'ADMIN',
          passwordHash: 'old-hash',
        }),
        update: jest.fn(),
        create: jest.fn(),
      },
    } as any;

    await ensureBootstrapAdmin(prisma);

    expect(bcrypt.hash).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('only fills a missing password hash', async () => {
    const prisma = {
      tenant: {
        findFirst: jest.fn().mockResolvedValue({ id: 'tenant-1' }),
        create: jest.fn(),
      },
      user: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'user-1',
          role: 'ADMIN',
          passwordHash: null,
        }),
        update: jest.fn(),
        create: jest.fn(),
      },
    } as any;

    (bcrypt.hash as jest.Mock).mockResolvedValue('new-hash');

    await ensureBootstrapAdmin(prisma);

    expect(bcrypt.hash).toHaveBeenCalledWith('G@123123', 10);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { passwordHash: 'new-hash' },
    });
  });
});
