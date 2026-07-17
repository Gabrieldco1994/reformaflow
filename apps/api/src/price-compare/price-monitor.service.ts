import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PriceCompareService, PriceResult } from './price-compare.service';
import {
  CreatePriceMonitorItemDto,
  UpdatePriceMonitorItemDto,
} from './dto/price-monitor-item.dto';

interface PriceSnapshot {
  bestPriceCents: number | null;
  bestStore: string | null;
  bestLink: string | null;
}

@Injectable()
export class PriceMonitorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly priceCompare: PriceCompareService,
  ) {}

  list(tenantId: string, projectId: string) {
    return this.prisma.priceMonitorItem.findMany({
      where: { tenantId, projectId, deletedAt: null },
      orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }],
    });
  }

  listByProjects(tenantId: string, projectIds: string[], limit = 50) {
    if (projectIds.length === 0) return Promise.resolve([]);
    return this.prisma.priceMonitorItem.findMany({
      where: {
        tenantId,
        projectId: { in: projectIds },
        deletedAt: null,
      },
      orderBy: [{ updatedAt: 'desc' }],
      take: limit,
      select: {
        id: true,
        projectId: true,
        title: true,
        query: true,
        productUrl: true,
        isActive: true,
        referencePriceCents: true,
        targetPriceCents: true,
        lastBestPriceCents: true,
        lastBestStore: true,
        lastBestLink: true,
        lastCheckedAt: true,
        project: { select: { id: true, name: true, type: true } },
      },
    });
  }

  create(tenantId: string, projectId: string, dto: CreatePriceMonitorItemDto) {
    const query = this.normalizeQuery(dto.query, dto.title);
    return this.prisma.priceMonitorItem.create({
      data: {
        tenantId,
        projectId,
        title: dto.title.trim(),
        query,
        productUrl: dto.productUrl?.trim() || null,
        notes: dto.notes?.trim() || null,
        referencePriceCents: dto.referencePriceCents ?? null,
        targetPriceCents: dto.targetPriceCents ?? null,
        isActive: dto.isActive ?? true,
      },
    });
  }

  async update(
    tenantId: string,
    projectId: string,
    itemId: string,
    dto: UpdatePriceMonitorItemDto,
  ) {
    const existing = await this.findItem(tenantId, projectId, itemId);
    const nextTitle = this.trimToUndefined(dto.title) ?? existing.title;
    const query =
      dto.query == null
        ? this.normalizeQuery(existing.query ?? undefined, nextTitle)
        : this.normalizeQuery(dto.query, nextTitle);

    return this.prisma.priceMonitorItem.update({
      where: { id: itemId },
      data: {
        title: this.trimToUndefined(dto.title),
        query,
        productUrl: this.trimToNullable(dto.productUrl),
        notes: this.trimToNullable(dto.notes),
        referencePriceCents:
          dto.referencePriceCents === undefined ? undefined : dto.referencePriceCents,
        targetPriceCents:
          dto.targetPriceCents === undefined ? undefined : dto.targetPriceCents,
        isActive: dto.isActive == null ? undefined : dto.isActive,
      },
    });
  }

  async remove(tenantId: string, projectId: string, itemId: string) {
    await this.findItem(tenantId, projectId, itemId);
    await this.prisma.priceMonitorItem.delete({ where: { id: itemId } });
    return { ok: true };
  }

  async refreshItem(tenantId: string, projectId: string, itemId: string) {
    const item = await this.findItem(tenantId, projectId, itemId);
    const query = this.normalizeQuery(item.query ?? undefined, item.title);
    const results = await this.priceCompare.searchPrices(query);
    const snapshot = this.pickBest(results);

    const updated = await this.prisma.priceMonitorItem.update({
      where: { id: item.id },
      data: {
        lastBestPriceCents: snapshot.bestPriceCents,
        lastBestStore: snapshot.bestStore,
        lastBestLink: snapshot.bestLink,
        lastCheckedAt: new Date(),
      },
    });

    return {
      item: updated,
      comparison: this.buildComparison(updated.referencePriceCents, results, snapshot),
    };
  }

  async refreshAll(tenantId: string, projectId: string, limit = 25) {
    const items = await this.prisma.priceMonitorItem.findMany({
      where: { tenantId, projectId, deletedAt: null, isActive: true },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });

    const refreshed = [];
    for (const item of items) {
      const one = await this.refreshItem(tenantId, projectId, item.id);
      refreshed.push(one);
    }
    return { refreshedCount: refreshed.length, items: refreshed };
  }

  async searchPrices(query: string, referencePriceCents?: number | null) {
    const normalized = this.normalizeQuery(query, query);
    const results = await this.priceCompare.searchPrices(normalized);
    const snapshot = this.pickBest(results);
    return this.buildComparison(referencePriceCents ?? null, results, snapshot);
  }

  async findFirstByQuery(
    tenantId: string,
    projectIds: string[],
    query: string,
  ) {
    if (!query.trim()) return null;
    return this.prisma.priceMonitorItem.findFirst({
      where: {
        tenantId,
        projectId: { in: projectIds },
        deletedAt: null,
        OR: [
          { title: { contains: query.trim() } },
          { query: { contains: query.trim() } },
        ],
      },
      orderBy: [{ updatedAt: 'desc' }],
    });
  }

  async findByIdInProjects(
    tenantId: string,
    projectIds: string[],
    itemId: string,
  ) {
    return this.prisma.priceMonitorItem.findFirst({
      where: {
        id: itemId,
        tenantId,
        projectId: { in: projectIds },
        deletedAt: null,
      },
    });
  }

  private async findItem(tenantId: string, projectId: string, itemId: string) {
    const item = await this.prisma.priceMonitorItem.findFirst({
      where: { id: itemId, tenantId, projectId, deletedAt: null },
    });
    if (!item) throw new NotFoundException('Item de monitoramento não encontrado');
    return item;
  }

  private normalizeQuery(raw: string | undefined, fallbackTitle: string): string {
    const source = raw?.trim() || fallbackTitle.trim();
    return source.length < 3 ? fallbackTitle.trim() : source;
  }

  private trimToUndefined(value: string | null | undefined): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed || undefined;
  }

  private trimToNullable(value: string | null | undefined): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const trimmed = value.trim();
    return trimmed || null;
  }

  private pickBest(results: PriceResult[]): PriceSnapshot {
    const valid = results.filter(
      (r) => typeof r.price === 'number' && Number.isFinite(r.price) && r.price > 0,
    );
    if (valid.length === 0) {
      return { bestPriceCents: null, bestStore: null, bestLink: null };
    }
    const best = valid.reduce((acc, cur) => (cur.price! < acc.price! ? cur : acc));
    return {
      bestPriceCents: Math.round((best.price ?? 0) * 100),
      bestStore: best.store || null,
      bestLink: best.link || null,
    };
  }

  private buildComparison(
    referencePriceCents: number | null,
    results: PriceResult[],
    snapshot: PriceSnapshot,
  ) {
    const bestDeltaCents =
      referencePriceCents != null && snapshot.bestPriceCents != null
        ? snapshot.bestPriceCents - referencePriceCents
        : null;
    const bestDeltaPercent =
      referencePriceCents != null &&
      snapshot.bestPriceCents != null &&
      referencePriceCents > 0
        ? Math.round((bestDeltaCents! / referencePriceCents) * 100)
        : null;

    return {
      queryResultCount: results.length,
      bestPriceCents: snapshot.bestPriceCents,
      bestStore: snapshot.bestStore,
      bestLink: snapshot.bestLink,
      bestDeltaCents,
      bestDeltaPercent,
    };
  }
}
