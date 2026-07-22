import { Controller, Get, Post, Patch, Delete, Query, Param, Body, UseInterceptors } from '@nestjs/common';
import { PriceCompareService, PriceResult } from './price-compare.service';
import { PriceMonitorService } from './price-monitor.service';
import { CreatePriceMonitorItemDto, UpdatePriceMonitorItemDto, PriceMonitorItemResponseDto } from './dto/price-monitor-item.dto';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant, CurrentUser } from '../common/decorators/tenant.decorator';
import { ComprarAgoraDto } from './dto/comprar-agora.dto';
import { RequireModule } from '../common/decorators/require-module.decorator';

@UseInterceptors(TenantInterceptor)
@Controller()
export class PriceCompareController {
  constructor(
    private readonly priceCompareService: PriceCompareService,
    private readonly priceMonitorService: PriceMonitorService,
  ) {}

  @Get('price-compare')
  async compare(@Query('q') query: string): Promise<PriceResult[]> {
    if (!query || query.trim().length < 3) {
      return [];
    }
    return this.priceCompareService.searchPrices(query);
  }

  @Post('projects/:projectId/price-monitor/items')
  @RequireModule('priceCompare')
  async createMonitorItem(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Body() dto: CreatePriceMonitorItemDto,
  ): Promise<PriceMonitorItemResponseDto> {
    const item = await this.priceMonitorService.create(tenantId, projectId, dto);

    return this.itemToResponse(item);
  }

  @Get('projects/:projectId/price-monitor/items')
  @RequireModule('priceCompare')
  async listMonitorItems(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
  ): Promise<PriceMonitorItemResponseDto[]> {
    const items = await this.priceMonitorService.listItems(tenantId, projectId);
    return items.map((item) => this.itemToResponse(item));
  }

  @Patch('projects/:projectId/price-monitor/items/:id')
  @RequireModule('priceCompare')
  async updateMonitorItem(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') itemId: string,
    @Body() dto: UpdatePriceMonitorItemDto,
  ): Promise<PriceMonitorItemResponseDto> {
    const item = await this.priceMonitorService.updateItem(
      tenantId,
      itemId,
      dto,
    );

    return this.itemToResponse(item);
  }

  @Delete('projects/:projectId/price-monitor/items/:id')
  @RequireModule('priceCompare')
  async deleteMonitorItem(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') itemId: string,
  ): Promise<void> {
    await this.priceMonitorService.deleteItem(tenantId, itemId);
  }

  @Post('projects/:projectId/price-monitor/items/:id/comprar-agora')
  @RequireModule('priceCompare', 'expenses')
  async comprarAgora(
    @CurrentTenant() tenantId: string,
    @CurrentUser() requester: { id: string },
    @Param('projectId') projectId: string,
    @Param('id') itemId: string,
    @Body() dto: ComprarAgoraDto,
  ) {
    return this.priceMonitorService.comprarAgora(
      tenantId,
      projectId,
      itemId,
      dto,
      requester.id,
    );
  }

  private itemToResponse(item: any): PriceMonitorItemResponseDto {
    return {
      id: item.id,
      title: item.title,
      url: item.url,
      query: item.query,
      notes: item.notes,
      productUrl: item.productUrl,
      referencePriceCents: item.referencePriceCents,
      targetPrice: item.targetPrice,
      targetPriceCents: item.targetPriceCents,
      isActive: item.isActive,
      monitoringEndDate: item.monitoringEndDate?.toISOString() || null,
      alertSent: item.alertSent,
      ativo: this.priceMonitorService.isMonitoringActive(item),
      lastCheckedAt: item.lastCheckedAt?.toISOString() || null,
      lastBestPrice: item.lastBestPrice,
      lastBestPriceCents: item.lastBestPriceCents,
      lastBestStore: item.lastBestStore,
      lastBestLink: item.lastBestLink,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    };
  }
}
