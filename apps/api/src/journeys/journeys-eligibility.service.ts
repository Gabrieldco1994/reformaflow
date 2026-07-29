import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  JOURNEY_STEP_SLUGS,
  JOURNEY_TRIGGER_DEVICES,
  JOURNEY_TRIGGER_TYPES,
  ProjectType,
} from '@reformaflow/domain';
import { PrismaService } from '../prisma/prisma.service';

/** Dispositivo de quem está perguntando "o que é elegível agora?" — sempre concreto, nunca `'any'` (isso é um valor de configuração de gatilho, não de contexto de chamada). */
const CALLER_DEVICES = JOURNEY_TRIGGER_DEVICES.filter((d) => d !== 'any');
type CallerDevice = (typeof CALLER_DEVICES)[number];

export interface EligibleJourneyQuery {
  triggerType: string;
  device: string;
  projectId?: string;
  projectType?: ProjectType;
  screenKey?: string;
  actionKey?: string;
}

export interface EligibleStepView {
  stepKey: string;
  order: number;
  experience: string;
  label: string;
  subtitle: string | null;
  skippable: boolean;
  /**
   * Slug de `PROJECT_NAV` (não a rota completa — `/projects/:id/` fica por
   * conta do runtime, que compõe com o projeto ATIVO na hora de navegar,
   * nunca com o projeto do momento da elegibilidade). Ausente para passos
   * SUMMARY ou sem tela própria (`JOURNEY_STEP_SLUGS`); nunca vem do banco.
   */
  slug?: string;
}

export interface EligibleJourneyView {
  journeyId: string;
  key: string;
  name: string;
  triggerId: string;
  repeatPolicy: string;
  dismissPolicy: string;
  crossProject: boolean;
  steps: EligibleStepView[];
}

/**
 * `GET /journeys/eligible` (#339 — Etapa B). Roda com um tenant/usuário REAL
 * em contexto (ao contrário de `JourneysAdminService`, que é o painel
 * global) — é aqui que "nenhum dado de outro tenant vaza para o executor" é
 * de fato garantido.
 */
@Injectable()
export class JourneysEligibilityService {
  constructor(private readonly prisma: PrismaService) {}

  async getEligible(
    query: EligibleJourneyQuery,
    tenantId: string,
    userId: string,
  ): Promise<EligibleJourneyView[]> {
    const triggerType = query?.triggerType as string;
    if (!(JOURNEY_TRIGGER_TYPES as readonly string[]).includes(triggerType)) {
      throw new BadRequestException(
        `triggerType inválido: "${triggerType}". Válidos: ${JOURNEY_TRIGGER_TYPES.join(', ')}`,
      );
    }

    const device = query?.device as string;
    if (!(CALLER_DEVICES as readonly string[]).includes(device)) {
      throw new BadRequestException(
        `device inválido: "${device}". Válidos: ${CALLER_DEVICES.join(', ')}`,
      );
    }

    if (triggerType === 'SCREEN_VISIT' && !query.screenKey) {
      throw new BadRequestException('SCREEN_VISIT exige screenKey na consulta.');
    }
    if (triggerType === 'ACTION' && !query.actionKey) {
      throw new BadRequestException('ACTION exige actionKey na consulta.');
    }

    let resolvedProjectType: ProjectType | null = null;
    if (query.projectId) {
      const project = await this.prisma.project.findFirst({
        where: { id: query.projectId, tenantId, deletedAt: null },
      });
      // Nunca confirma se o projeto existe em OUTRO tenant — mesmo erro para
      // "não existe" e "existe, mas não é seu".
      if (!project) {
        throw new NotFoundException(`Projeto "${query.projectId}" não encontrado.`);
      }
      resolvedProjectType = project.type as ProjectType;
      if (query.projectType && query.projectType !== resolvedProjectType) {
        throw new BadRequestException(
          `projectType "${query.projectType}" incoerente com o tipo real do projeto ("${resolvedProjectType}").`,
        );
      }
    } else if (query.projectType) {
      resolvedProjectType = query.projectType;
    }

    const journeys = await this.prisma.journey.findMany({ where: { active: true, deletedAt: null } });
    const activeJourneyIds = new Set(journeys.map((j) => j.id));
    const journeyById = new Map(journeys.map((j) => [j.id, j]));

    const triggers = await this.prisma.journeyTrigger.findMany({ where: { active: true } });

    const matched = triggers.filter((t) => {
      if (!activeJourneyIds.has(t.journeyId)) return false;
      if (t.triggerType !== triggerType) return false;
      if (t.device !== 'any' && t.device !== device) return false;
      if (t.targetProjectType !== null && t.targetProjectType !== resolvedProjectType) return false;
      if (t.targetProjectId !== null && t.targetProjectId !== (query.projectId ?? null)) return false;
      if (triggerType === 'SCREEN_VISIT' && t.screenKey !== query.screenKey) return false;
      if (triggerType === 'ACTION' && t.actionKey !== query.actionKey) return false;
      return true;
    });

    const eligible: EligibleJourneyView[] = [];
    for (const trigger of matched) {
      const completionKey = this.buildCompletionKey(trigger.repeatPolicy, tenantId, userId, query.projectId);
      if (trigger.repeatPolicy === 'ALWAYS') {
        // ALWAYS nunca grava conclusão — nem sequer consultamos a tabela.
      } else if (trigger.repeatPolicy === 'ONCE_PER_PROJECT' && !query.projectId) {
        // Sem projeto não há como resolver o escopo "por projeto" com
        // segurança — mais seguro excluir do que arriscar repetir/perder.
        continue;
      } else {
        const existing = await this.prisma.journeyCompletion.findUnique({
          where: { journeyId_completionKey: { journeyId: trigger.journeyId, completionKey } },
        });
        if (existing) continue;
      }

      const journey = journeyById.get(trigger.journeyId)!;
      const steps = await this.prisma.journeyStep.findMany({ where: { journeyId: journey.id } });
      const enabledSteps = steps
        .filter((s) => s.enabled)
        .sort((a, b) => a.order - b.order)
        .map((s) => ({
          stepKey: s.stepKey,
          order: s.order,
          experience: s.experience,
          label: s.label,
          subtitle: s.subtitle,
          skippable: s.skippable,
          slug: JOURNEY_STEP_SLUGS[s.stepKey],
        }));

      eligible.push({
        journeyId: journey.id,
        key: journey.key,
        name: journey.name,
        triggerId: trigger.id,
        repeatPolicy: trigger.repeatPolicy,
        dismissPolicy: trigger.dismissPolicy,
        crossProject: trigger.crossProject,
        steps: enabledSteps,
      });
    }

    return eligible;
  }

  /**
   * MESMA convenção documentada no schema (`JourneyCompletion.completionKey`):
   * `ONCE_PER_USER` ignora o projeto (`:none` fixo — completar em qualquer
   * projeto conta para sempre); `ONCE_PER_PROJECT` é escopada por projeto.
   */
  private buildCompletionKey(
    repeatPolicy: string,
    tenantId: string,
    userId: string,
    projectId: string | undefined,
  ): string {
    if (repeatPolicy === 'ONCE_PER_PROJECT') {
      return `${tenantId}:${userId}:${projectId}`;
    }
    return `${tenantId}:${userId}:none`;
  }
}
