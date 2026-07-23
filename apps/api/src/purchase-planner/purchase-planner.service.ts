import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateScenarioDto,
  UpdateScenarioDto,
  CreateScenarioItemDto,
  UpdateScenarioItemDto,
} from './dto/purchase-planner.dto';

/**
 * Planejador de Compras (épico #271): CRUD de cenários hipotéticos + itens.
 * Cálculo (applyPurchasePlan) mora em packages/domain e roda no client —
 * este service só persiste a entrada do usuário, sem projetar nada.
 */
@Injectable()
export class PurchasePlannerService {
  constructor(private readonly prisma: PrismaService) {}

  async findAllScenarios(tenantId: string, projectId: string) {
    const scenarios = await this.prisma.purchaseScenario.findMany({
      where: { tenantId, projectId },
      orderBy: { createdAt: 'desc' },
    });
    return Promise.all(scenarios.map((s) => this.attachItems(s)));
  }

  async findScenarioById(tenantId: string, projectId: string, id: string) {
    const scenario = await this.findScenarioOrThrow(tenantId, projectId, id);
    return this.attachItems(scenario);
  }

  async createScenario(tenantId: string, projectId: string, dto: CreateScenarioDto) {
    const scenario = await this.prisma.purchaseScenario.create({
      data: {
        tenantId,
        projectId,
        nome: dto.nome,
        horizonteMeses: dto.horizonteMeses ?? 6,
      },
    });
    return this.attachItems(scenario);
  }

  async updateScenario(
    tenantId: string,
    projectId: string,
    id: string,
    dto: UpdateScenarioDto,
  ) {
    await this.findScenarioOrThrow(tenantId, projectId, id);
    const data: Record<string, unknown> = {};
    if (dto.nome !== undefined) data.nome = dto.nome;
    if (dto.horizonteMeses !== undefined) data.horizonteMeses = dto.horizonteMeses;
    const scenario = await this.prisma.purchaseScenario.update({ where: { id }, data });
    return this.attachItems(scenario);
  }

  /** Soft-delete do cenário + de todos os seus itens (cascade manual — o
   * middleware de soft-delete converte delete em update e não dispara
   * ON DELETE CASCADE do banco). */
  async removeScenario(tenantId: string, projectId: string, id: string) {
    await this.findScenarioOrThrow(tenantId, projectId, id);
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.purchaseScenarioItem.updateMany({
        where: { scenarioId: id, deletedAt: null },
        data: { deletedAt: now },
      }),
      this.prisma.purchaseScenario.update({ where: { id }, data: { deletedAt: now } }),
    ]);
    return { deleted: true };
  }

  async createItem(
    tenantId: string,
    projectId: string,
    scenarioId: string,
    dto: CreateScenarioItemDto,
  ) {
    await this.findScenarioOrThrow(tenantId, projectId, scenarioId);
    this.validateItemFields(dto);

    return this.prisma.purchaseScenarioItem.create({
      data: {
        tenantId,
        projectId,
        scenarioId,
        nome: dto.nome,
        tipo: dto.tipo,
        valorCents: dto.valorCents,
        mesInicio: dto.mesInicio,
        incluido: dto.incluido ?? true,
        entradaCents: dto.entradaCents,
        parcelas: dto.parcelas,
        taxaJurosMensalBps: dto.taxaJurosMensalBps,
        sistema: dto.sistema,
        sourcePriceItemId: dto.sourcePriceItemId,
      },
    });
  }

  async updateItem(
    tenantId: string,
    projectId: string,
    scenarioId: string,
    itemId: string,
    dto: UpdateScenarioItemDto,
  ) {
    await this.findScenarioOrThrow(tenantId, projectId, scenarioId);
    const existing = await this.findItemOrThrow(tenantId, projectId, scenarioId, itemId);

    // Valida o resultado FINAL (existente + patch), não só os campos enviados —
    // um PATCH que só troca `tipo` para FINANCIAMENTO sem mandar `parcelas` de
    // novo tem que ser rejeitado se `parcelas` também não existir já.
    this.validateItemFields({ ...existing, ...dto });

    const data: Record<string, unknown> = {};
    if (dto.nome !== undefined) data.nome = dto.nome;
    if (dto.tipo !== undefined) data.tipo = dto.tipo;
    if (dto.valorCents !== undefined) data.valorCents = dto.valorCents;
    if (dto.mesInicio !== undefined) data.mesInicio = dto.mesInicio;
    if (dto.incluido !== undefined) data.incluido = dto.incluido;
    if (dto.entradaCents !== undefined) data.entradaCents = dto.entradaCents;
    if (dto.parcelas !== undefined) data.parcelas = dto.parcelas;
    if (dto.taxaJurosMensalBps !== undefined) data.taxaJurosMensalBps = dto.taxaJurosMensalBps;
    if (dto.sistema !== undefined) data.sistema = dto.sistema;
    if (dto.sourcePriceItemId !== undefined) data.sourcePriceItemId = dto.sourcePriceItemId;

    return this.prisma.purchaseScenarioItem.update({ where: { id: itemId }, data });
  }

  async removeItem(tenantId: string, projectId: string, scenarioId: string, itemId: string) {
    await this.findItemOrThrow(tenantId, projectId, scenarioId, itemId);
    await this.prisma.purchaseScenarioItem.delete({ where: { id: itemId } });
    return { deleted: true };
  }

  private async attachItems(scenario: { id: string }) {
    const itens = await this.prisma.purchaseScenarioItem.findMany({
      where: { scenarioId: scenario.id, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return { ...scenario, itens };
  }

  private async findScenarioOrThrow(tenantId: string, projectId: string, id: string) {
    const scenario = await this.prisma.purchaseScenario.findFirst({
      where: { id, tenantId, projectId, deletedAt: null },
    });
    if (!scenario) throw new NotFoundException('Cenário não encontrado');
    return scenario;
  }

  private async findItemOrThrow(
    tenantId: string,
    projectId: string,
    scenarioId: string,
    itemId: string,
  ) {
    const item = await this.prisma.purchaseScenarioItem.findFirst({
      where: { id: itemId, tenantId, projectId, scenarioId, deletedAt: null },
    });
    if (!item) throw new NotFoundException('Item não encontrado');
    return item;
  }

  /** PARCELADO/FINANCIAMENTO exigem `parcelas`; FINANCIAMENTO exige `sistema`. */
  private validateItemFields(item: {
    tipo?: string;
    parcelas?: number | null;
    sistema?: string | null;
  }) {
    if (item.tipo === 'PARCELADO' || item.tipo === 'FINANCIAMENTO') {
      if (!item.parcelas || item.parcelas < 1) {
        throw new BadRequestException(`"parcelas" é obrigatório para ${item.tipo}`);
      }
    }
    if (item.tipo === 'FINANCIAMENTO' && !item.sistema) {
      throw new BadRequestException('"sistema" (PRICE|SAC) é obrigatório para FINANCIAMENTO');
    }
  }
}
