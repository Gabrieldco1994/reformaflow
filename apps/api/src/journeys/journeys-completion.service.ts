import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface CompleteJourneyInput {
  triggerId: string;
  projectId?: string;
}

export interface CompleteJourneyResult {
  completed: true;
  /** `false` só para `ALWAYS` — nenhuma linha é persistida nesse caso. */
  recorded: boolean;
}

/**
 * `POST /journeys/:id/complete` (#339 — Etapa B). O cliente sempre manda o
 * `triggerId` que veio de `GET /journeys/eligible` — nunca há ambiguidade
 * sobre qual `repeatPolicy` está em jogo (uma jornada pode ter vários
 * gatilhos com políticas diferentes).
 */
@Injectable()
export class JourneysCompletionService {
  constructor(private readonly prisma: PrismaService) {}

  async complete(
    journeyId: string,
    dto: CompleteJourneyInput,
    tenantId: string,
    userId: string,
  ): Promise<CompleteJourneyResult> {
    const journey = await this.prisma.journey.findFirst({
      where: { id: journeyId, active: true, deletedAt: null },
    });
    if (!journey) {
      throw new NotFoundException(`Jornada "${journeyId}" não encontrada.`);
    }

    const triggerId = dto?.triggerId;
    if (!triggerId || typeof triggerId !== 'string') {
      throw new BadRequestException('triggerId é obrigatório.');
    }
    const trigger = await this.prisma.journeyTrigger.findFirst({
      where: { id: triggerId, journeyId },
    });
    if (!trigger) {
      throw new BadRequestException(
        `Gatilho "${triggerId}" não pertence à jornada "${journeyId}".`,
      );
    }

    if (dto?.projectId) {
      const project = await this.prisma.project.findFirst({
        where: { id: dto.projectId, tenantId, deletedAt: null },
      });
      if (!project) {
        throw new NotFoundException(`Projeto "${dto.projectId}" não encontrado.`);
      }
    }

    if (trigger.repeatPolicy === 'ALWAYS') {
      // ALWAYS nunca grava conclusão — nunca chama create/upsert de propósito.
      return { completed: true, recorded: false };
    }

    if (trigger.repeatPolicy === 'ONCE_PER_PROJECT' && !dto?.projectId) {
      throw new BadRequestException(
        'ONCE_PER_PROJECT exige projectId — não há como registrar conclusão por projeto sem um.',
      );
    }

    const completionKey =
      trigger.repeatPolicy === 'ONCE_PER_PROJECT'
        ? `${tenantId}:${userId}:${dto.projectId}`
        : `${tenantId}:${userId}:none`;

    // Upsert é o gate atômico: dois `complete()` concorrentes não criam duas
    // linhas — o segundo cai no ramo `update` (aqui um no-op) em vez de uma
    // corrida "ler → checar → escrever".
    await this.prisma.journeyCompletion.upsert({
      where: { journeyId_completionKey: { journeyId, completionKey } },
      create: {
        journeyId,
        tenantId,
        userId,
        projectId: dto?.projectId ?? null,
        completionKey,
        completedAt: new Date(),
      },
      update: {},
    });

    return { completed: true, recorded: true };
  }
}
