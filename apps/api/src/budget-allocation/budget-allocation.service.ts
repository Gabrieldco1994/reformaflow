import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBudgetAllocationDto } from './dto/create-budget-allocation.dto';
import { UpdateBudgetAllocationDto } from './dto/update-budget-allocation.dto';

@Injectable()
export class BudgetAllocationService {
  constructor(private prisma: PrismaService) {}

  async create(sourceProjectId: string, tenantId: string, dto: CreateBudgetAllocationDto) {
    // 1. Validate source project is PESSOAL
    const sourceProject = await this.prisma.project.findFirst({
      where: { id: sourceProjectId, tenantId, deletedAt: null },
    });
    
    if (!sourceProject) {
      throw new NotFoundException('Source project not found');
    }
    
    if (sourceProject.type !== 'PESSOAL') {
      throw new BadRequestException('Budget allocation can only be created from PESSOAL projects');
    }

    // 2. Validate target project exists and is not PESSOAL
    const targetProject = await this.prisma.project.findFirst({
      where: { id: dto.targetProjectId, tenantId, deletedAt: null },
    });
    
    if (!targetProject) {
      throw new NotFoundException('Target project not found');
    }
    
    if (targetProject.type === 'PESSOAL') {
      throw new BadRequestException('Cannot allocate budget to another PESSOAL project');
    }

    // 3. Check available budget (prevent over-allocation)
    const available = await this.calculateAvailableBudget(sourceProjectId, tenantId);
    
    if (dto.valor > available) {
      throw new BadRequestException(
        `Insufficient budget. Available: ${available / 100}, Requested: ${dto.valor / 100}`
      );
    }

    // 4. Create budget allocation
    const allocation = await this.prisma.budgetAllocation.create({
      data: {
        tenantId,
        sourceProjectId,
        targetProjectId: dto.targetProjectId,
        sourceReceiptId: dto.sourceReceiptId,
        valor: dto.valor,
        descricao: dto.descricao,
        mes: dto.mes,
      },
      include: {
        sourceProject: { select: { id: true, name: true, type: true } },
        targetProject: { select: { id: true, name: true, type: true } },
        sourceReceipt: { select: { id: true, valor: true, tipo: true, data: true } },
      },
    });

    // 5. Auto-create CashFlowEntry in target project
    const mesDate = new Date(`${dto.mes}-01`);
    
    await this.prisma.cashFlowEntry.create({
      data: {
        projectId: dto.targetProjectId,
        tenantId,
        budgetAllocationId: allocation.id,
        valor: dto.valor,
        tipo: 'RECEBIMENTO',
        categoria: 'ALOCACAO_ORCAMENTO',
        status: 'EM_CAIXA',
        data: mesDate,
      },
    });

    return allocation;
  }

  async findAll(tenantId: string, filters?: { sourceProjectId?: string; targetProjectId?: string; mes?: string }) {
    return this.prisma.budgetAllocation.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(filters?.sourceProjectId && { sourceProjectId: filters.sourceProjectId }),
        ...(filters?.targetProjectId && { targetProjectId: filters.targetProjectId }),
        ...(filters?.mes && { mes: filters.mes }),
      },
      include: {
        sourceProject: { select: { id: true, name: true, type: true } },
        targetProject: { select: { id: true, name: true, type: true } },
        sourceReceipt: { select: { id: true, valor: true, tipo: true, data: true } },
      },
      orderBy: { dataAlocacao: 'desc' },
    });
  }

  async findOne(id: string, tenantId: string) {
    const allocation = await this.prisma.budgetAllocation.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: {
        sourceProject: { select: { id: true, name: true, type: true } },
        targetProject: { select: { id: true, name: true, type: true } },
        sourceReceipt: { select: { id: true, valor: true, tipo: true, data: true } },
        cashFlowEntries: true,
      },
    });

    if (!allocation) {
      throw new NotFoundException('Budget allocation not found');
    }

    return allocation;
  }

  async update(id: string, tenantId: string, dto: UpdateBudgetAllocationDto) {
    const existing = await this.findOne(id, tenantId);

    // If changing valor, check available budget
    if (dto.valor && dto.valor !== existing.valor) {
      const currentAvailable = await this.calculateAvailableBudget(existing.sourceProjectId, tenantId);
      const budgetDiff = dto.valor - existing.valor;
      
      if (budgetDiff > currentAvailable) {
        throw new BadRequestException('Insufficient budget for this update');
      }
    }

    const updated = await this.prisma.budgetAllocation.update({
      where: { id },
      data: {
        ...(dto.targetProjectId && { targetProjectId: dto.targetProjectId }),
        ...(dto.sourceReceiptId !== undefined && { sourceReceiptId: dto.sourceReceiptId }),
        ...(dto.valor && { valor: dto.valor }),
        ...(dto.descricao !== undefined && { descricao: dto.descricao }),
        ...(dto.mes && { mes: dto.mes }),
      },
      include: {
        sourceProject: { select: { id: true, name: true, type: true } },
        targetProject: { select: { id: true, name: true, type: true } },
        sourceReceipt: { select: { id: true, valor: true, tipo: true, data: true } },
      },
    });

    // Update linked CashFlowEntry if valor or mes changed
    if (dto.valor || dto.mes) {
      await this.prisma.cashFlowEntry.updateMany({
        where: { budgetAllocationId: id, deletedAt: null },
        data: {
          ...(dto.valor && { valor: dto.valor }),
          ...(dto.mes && { data: new Date(`${dto.mes}-01`) }),
        },
      });
    }

    return updated;
  }

  async remove(id: string, tenantId: string) {
    const allocation = await this.findOne(id, tenantId);

    // Soft delete allocation
    await this.prisma.budgetAllocation.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    // Soft delete linked CashFlowEntries
    await this.prisma.cashFlowEntry.updateMany({
      where: { budgetAllocationId: id, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    return { message: 'Budget allocation deleted successfully' };
  }

  async getSummary(projectId: string, tenantId: string) {
    // Get project to check if it's PESSOAL (source) or other (target)
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, tenantId, deletedAt: null },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    if (project.type === 'PESSOAL') {
      // Summary of allocations FROM this project
      const allocations = await this.prisma.budgetAllocation.findMany({
        where: { sourceProjectId: projectId, tenantId, deletedAt: null },
        include: {
          targetProject: { select: { id: true, name: true, type: true } },
        },
      });

      const totalAllocated = allocations.reduce((sum, a) => sum + a.valor, 0);
      const byTargetProject = allocations.reduce((acc, a) => {
        const key = a.targetProject.id;
        if (!acc[key]) {
          acc[key] = {
            projectId: a.targetProject.id,
            projectName: a.targetProject.name,
            projectType: a.targetProject.type,
            total: 0,
          };
        }
        acc[key].total += a.valor;
        return acc;
      }, {} as Record<string, any>);

      const available = await this.calculateAvailableBudget(projectId, tenantId);

      return {
        totalAllocated,
        available,
        allocations: Object.values(byTargetProject),
      };
    } else {
      // Summary of allocations TO this project
      const allocations = await this.prisma.budgetAllocation.findMany({
        where: { targetProjectId: projectId, tenantId, deletedAt: null },
        include: {
          sourceProject: { select: { id: true, name: true, type: true } },
        },
      });

      const totalReceived = allocations.reduce((sum, a) => sum + a.valor, 0);

      // Get expenses to calculate spent
      const expenses = await this.prisma.cashFlowEntry.findMany({
        where: {
          projectId,
          tenantId,
          deletedAt: null,
          tipo: 'DESPESA',
          status: 'PAGO',
        },
      });

      const totalSpent = expenses.reduce((sum, e) => sum + e.valor, 0);

      return {
        totalReceived,
        totalSpent,
        remaining: totalReceived - totalSpent,
        allocations: allocations.map(a => ({
          id: a.id,
          valor: a.valor,
          mes: a.mes,
          descricao: a.descricao,
          sourceProject: a.sourceProject,
        })),
      };
    }
  }

  async calculateAvailableBudget(sourceProjectId: string, tenantId: string): Promise<number> {
    // Total receipts EM_CAIXA in source project
    // IMPORTANT: exclude linked receipts to avoid double-counting
    const receipts = await this.prisma.receipt.findMany({
      where: {
        projectId: sourceProjectId,
        tenantId,
        deletedAt: null,
        status: 'EM_CAIXA',
        linkedReceiptId: null, // Only count non-linked receipts
      },
    });

    const totalReceipts = receipts.reduce((sum, r) => sum + r.valor, 0);

    // Total allocated FROM this project
    const allocations = await this.prisma.budgetAllocation.findMany({
      where: {
        sourceProjectId,
        tenantId,
        deletedAt: null,
      },
    });

    const totalAllocated = allocations.reduce((sum, a) => sum + a.valor, 0);

    const available = totalReceipts - totalAllocated;

    // Debug log
    console.log('[BudgetAllocation] calculateAvailableBudget:', {
      projectId: sourceProjectId,
      receiptsCount: receipts.length,
      totalReceipts,
      totalReceiptsReais: totalReceipts / 100,
      allocationsCount: allocations.length,
      totalAllocated,
      totalAllocatedReais: totalAllocated / 100,
      available,
      availableReais: available / 100,
    });

    // Ensure we never return negative values
    return Math.max(0, available);
  }
}
