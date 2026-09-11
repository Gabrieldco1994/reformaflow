import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { hasFeature, PaymentForm, ProjectType } from '@reformaflow/domain';
import { ConciliacaoService, RateioItem } from '../conciliacao/conciliacao.service';
import { EXPENSE_MODULE, userCanAccessProject, userCanAccessProjectModule } from '../common/access-rules';
import { RatearMixedDto } from './dto/ratear-mixed.dto';
import { RateioRequester } from './rateio.types';

/** Shared final phase of mixed rateio; the caller owns the transaction and source preflight. */
export async function createRateioTargets(
  tx: Prisma.TransactionClient,
  conciliacao: ConciliacaoService,
  tenantId: string,
  source: { id: string; status: string },
  dto: RatearMixedDto,
  createdByUserId: string | null,
  requester: RateioRequester,
) {
  const newTargets = dto.newTargets ?? [];
  const projects = await tx.project.findMany({
    where: { id: { in: [...new Set(newTargets.map(t => t.targetProjectId))] }, tenantId, deletedAt: null },
  });
  for (const target of newTargets) {
    const project = projects.find(p => p.id === target.targetProjectId);
    if (!project ||
        !userCanAccessProject(requester.role, requester.allowedProjects, project.id) ||
        !userCanAccessProjectModule(requester.role, requester.allowedProjectTypes, requester.allowedModules ?? [], project.type, EXPENSE_MODULE)) {
      throw new BadRequestException(`Projeto destino ${target.targetProjectId} não encontrado`);
    }
    if (!hasFeature(project.type as ProjectType, 'expenses')) {
      throw new BadRequestException(`Projeto destino ${project.id} não possui o módulo de despesas — não pode receber rateio.`);
    }
    if (target.roomId && !await tx.room.findFirst({
      where: { id: target.roomId, projectId: target.targetProjectId, deletedAt: null },
    })) throw new NotFoundException('Sala não encontrada neste projeto');
  }

  const createdTargetIds: string[] = [];
  const allocations: RateioItem[] = (dto.existing ?? []).map(e => ({
    targetExpenseId: e.targetExpenseId, allocation: e.allocation,
  }));
  for (const target of newTargets) {
    const valor = Math.round(target.valor * 100);
    const quantidade = target.quantidade ?? 1;
    const created = await tx.expense.create({ data: {
      tenantId, projectId: target.targetProjectId, createdByUserId,
      tipoDespesa: target.tipoDespesa, categoriaMaoDeObra: target.categoriaMaoDeObra,
      roomId: target.roomId, valor, quantidade, valorTotal: valor * quantidade,
      titulo: target.titulo, fornecedor: target.fornecedor,
      formaPagamento: target.formaPagamento ?? PaymentForm.A_VISTA,
      status: target.status ?? source.status,
    } });
    createdTargetIds.push(created.id);
    allocations.push({ targetExpenseId: created.id, allocation: target.allocation });
  }
  const rateio = await conciliacao.ratearSource(tx, {
    tenantId, sourceExpenseId: source.id, allocations,
  }, requester);
  return { createdTargetIds, targets: rateio.targets };
}
