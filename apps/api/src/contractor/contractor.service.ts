import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateContractorDto } from './dto/create-contractor.dto';
import { UpdateMilestoneDto } from './dto/update-milestone.dto';
import { defaultContractorMilestones, calculateReleasedAmount } from '@reformaflow/domain';

@Injectable()
export class ContractorService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cria empreiteiro com 4 milestones padrão (20/30/30/20)
   * Extraído da aba "Empreiteiro" da planilha
   */
  async create(tenantId: string, projectId: string, dto: CreateContractorDto) {
    await this.validateProject(tenantId, projectId);

    return this.prisma.contractor.create({
      data: {
        projectId,
        name: dto.name,
        document: dto.document,
        phone: dto.phone,
        contractedAmount: dto.contractedAmount,
        milestones: {
          create: defaultContractorMilestones.map((m) => ({
            stage: m.stage,
            description: m.description,
            percentage: m.percentage,
          })),
        },
      },
      include: { milestones: true },
    });
  }

  async findAllByProject(tenantId: string, projectId: string) {
    await this.validateProject(tenantId, projectId);
    return this.prisma.contractor.findMany({
      where: { projectId },
      include: { milestones: { orderBy: { percentage: 'asc' } } },
    });
  }

  /**
   * Atualiza milestone: % concluído, status de pagamento
   * Regra: valorLiberado = valorContratado × %Concluído
   */
  async updateMilestone(
    tenantId: string,
    projectId: string,
    milestoneId: string,
    dto: UpdateMilestoneDto,
  ) {
    await this.validateProject(tenantId, projectId);

    const milestone = await this.prisma.contractorMilestone.findUnique({
      where: { id: milestoneId },
      include: { contractor: true },
    });
    if (!milestone) throw new NotFoundException('Milestone não encontrada');

    const percentCompleted = dto.percentCompleted ?? milestone.percentCompleted;

    return this.prisma.contractorMilestone.update({
      where: { id: milestoneId },
      data: {
        percentCompleted,
        paymentStatus: dto.paymentStatus ?? milestone.paymentStatus,
        paymentDate: dto.paymentDate ? new Date(dto.paymentDate) : milestone.paymentDate,
        paymentMethod: dto.paymentMethod ?? milestone.paymentMethod,
        hasInvoice: dto.hasInvoice ?? milestone.hasInvoice,
        notes: dto.notes ?? milestone.notes,
      },
    });
  }

  async getSummary(tenantId: string, projectId: string) {
    const contractors = await this.findAllByProject(tenantId, projectId);

    return contractors.map((c) => ({
      id: c.id,
      name: c.name,
      contractedAmount: c.contractedAmount,
      milestones: c.milestones.map((m) => ({
        id: m.id,
        stage: m.stage,
        percentage: m.percentage,
        percentCompleted: m.percentCompleted,
        releasedAmount: calculateReleasedAmount(c.contractedAmount, m.percentCompleted),
        paymentStatus: m.paymentStatus,
        paymentDate: m.paymentDate,
      })),
      totalReleased: c.milestones.reduce(
        (sum, m) => sum + calculateReleasedAmount(c.contractedAmount, m.percentCompleted),
        0,
      ),
    }));
  }

  private async validateProject(tenantId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, tenantId },
    });
    if (!project) throw new NotFoundException('Projeto não encontrado');
  }
}
