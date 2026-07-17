import { NotFoundException } from '@nestjs/common';
import { PriceMonitorService } from './price-monitor.service';
import { PriceCompareService } from './price-compare.service';

describe('PriceMonitorService', () => {
  function makeService() {
    const prisma = {
      priceMonitorItem: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
    };
    const priceCompare = {
      searchPrices: jest.fn(),
    } as unknown as PriceCompareService;
    return {
      prisma,
      priceCompare,
      service: new PriceMonitorService(
        prisma as never,
        priceCompare as never,
      ),
    };
  }

  it('refreshItem salva o menor preço encontrado em centavos', async () => {
    const { service, prisma, priceCompare } = makeService();
    prisma.priceMonitorItem.findFirst.mockResolvedValue({
      id: 'pm1',
      tenantId: 't1',
      projectId: 'p1',
      title: 'Geladeira',
      query: 'geladeira frost free',
      referencePriceCents: 350000,
    });
    (priceCompare.searchPrices as jest.Mock).mockResolvedValue([
      { title: 'Loja A', price: 3599.9, currency: 'BRL', store: 'Loja A', link: 'https://a.com' },
      { title: 'Loja B', price: 3299.5, currency: 'BRL', store: 'Loja B', link: 'https://b.com' },
      { title: 'Sem preço', price: null, currency: 'BRL', store: 'Loja C', link: 'https://c.com' },
    ]);
    prisma.priceMonitorItem.update.mockResolvedValue({
      id: 'pm1',
      projectId: 'p1',
      title: 'Geladeira',
      query: 'geladeira frost free',
      referencePriceCents: 350000,
      targetPriceCents: null,
      lastBestPriceCents: 329950,
      lastBestStore: 'Loja B',
      lastBestLink: 'https://b.com',
      lastCheckedAt: new Date('2026-01-01T00:00:00Z'),
    });

    const res = await service.refreshItem('t1', 'p1', 'pm1');

    expect(prisma.priceMonitorItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pm1' },
        data: expect.objectContaining({
          lastBestPriceCents: 329950,
          lastBestStore: 'Loja B',
          lastBestLink: 'https://b.com',
        }),
      }),
    );
    expect(res.comparison.bestPriceCents).toBe(329950);
    expect(res.comparison.bestDeltaCents).toBe(-20050);
    expect(res.comparison.bestDeltaPercent).toBe(-6);
  });

  it('refreshItem lança NotFound quando item não existe', async () => {
    const { service, prisma } = makeService();
    prisma.priceMonitorItem.findFirst.mockResolvedValue(null);
    await expect(service.refreshItem('t1', 'p1', 'x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
