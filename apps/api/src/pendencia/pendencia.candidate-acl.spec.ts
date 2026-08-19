import { ForbiddenException } from '@nestjs/common';
import { PendenciaService } from './pendencia.service';
import type { RateioRequester } from '../expense/rateio.types';

const USER: RateioRequester = {
  role: 'USER',
  allowedProjects: ['pessoal', 'visible'],
  allowedProjectTypes: ['PESSOAL', 'REFORMA'],
  allowedModules: ['expenses'],
};

const EMPTY_VIEW = {
  mesSelecionado: '2026-08',
  saidas: [],
  entradas: [],
  cartoes: [],
};

function serviceWith(prisma: any, overview: any, bank: any): PendenciaService {
  return new PendenciaService(
    prisma,
    overview,
    { fromCache: jest.fn().mockResolvedValue(null) } as any,
    bank,
  );
}

describe('PendenciaService card candidate ACL (#480)', () => {
  it('rejects a missing requester before account or candidate reads', async () => {
    const overview = { getAccountView: jest.fn() };
    const bank = { loadCardsWithEntries: jest.fn() };
    const prisma = { expense: { findMany: jest.fn() } };
    const service = serviceWith(prisma, overview, bank);

    await expect(
      service.findFinancialQueue('tenant', 'pessoal', '2026-08', undefined as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(overview.getAccountView).not.toHaveBeenCalled();
    expect(prisma.expense.findMany).not.toHaveBeenCalled();
    expect(bank.loadCardsWithEntries).not.toHaveBeenCalled();
  });

  it('forwards the requester to the shared scoped card loader', async () => {
    const overview = {
      getAccountView: jest.fn().mockResolvedValue(EMPTY_VIEW),
    };
    const prisma = {
      expense: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'orphan',
            titulo: 'Pagamento',
            fornecedor: null,
            valor: 10_000,
            dataPagamento: new Date('2026-08-10T00:00:00.000Z'),
          },
        ]),
      },
    };
    const bank = { loadCardsWithEntries: jest.fn().mockResolvedValue([]) };
    const service = serviceWith(prisma, overview, bank);

    await service.findFinancialQueue('tenant', 'pessoal', '2026-08', USER);

    expect(overview.getAccountView).toHaveBeenCalledWith(
      'tenant',
      'pessoal',
      '2026-08',
      USER,
    );
    expect(bank.loadCardsWithEntries).toHaveBeenCalledWith(
      'tenant',
      expect.any(Date),
      expect.any(Date),
      USER,
    );
  });
});
