import { Injectable, OnModuleInit } from '@nestjs/common';
import { JOURNEY_CATALOG, JourneyDefinition } from '@reformaflow/domain';
import { PrismaService } from '../prisma/prisma.service';

type JourneyStepSeed = JourneyDefinition['steps'][number];
type JourneyTriggerSeed = JourneyDefinition['triggers'][number];

@Injectable()
export class JourneyBootstrapService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.bootstrap();
  }

  /**
   * `catalog` existe como seam de teste: a suíte de persistência entre
   * publishes precisa simular DOIS deploys com catálogos diferentes sem mutar
   * o `JOURNEY_CATALOG` compartilhado (que vazaria entre suítes). Em produção
   * é sempre o catálogo real.
   */
  async bootstrap(catalog: Record<string, JourneyDefinition> = JOURNEY_CATALOG): Promise<void> {
    for (const journey of Object.values(catalog)) {
      const existing = await this.prisma.journey.findUnique({
        where: { key: journey.key },
        select: { id: true },
      });

      if (existing) continue;

      const created = await this.prisma.journey.create({
        data: {
          key: journey.key,
          name: journey.name,
          description: journey.description,
          active: true,
        },
        select: { id: true },
      });

      await this.prisma.journeyStep.createMany({
        data: journey.steps.map((step, order) => this.toStepRow(created.id, step, order)),
      });

      await this.prisma.journeyTrigger.createMany({
        data: journey.triggers.map((trigger) => this.toTriggerRow(created.id, trigger)),
      });
    }
  }

  private toStepRow(journeyId: string, step: JourneyStepSeed, order: number) {
    return {
      journeyId,
      stepKey: step.key,
      order,
      experience: 'FULL',
      label: step.label,
      subtitle: step.defaultSubtitle,
      // `enabledByDefault` é DADO do catálogo (journey-catalog.ts), nunca uma
      // regra reimplementada aqui — ex.: PESSOAL `expense`/`import` nascem
      // desligados porque `expense-import` já é a versão unificada das duas.
      enabled: step.enabledByDefault ?? true,
      skippable: step.skippableByDefault,
    };
  }

  private toTriggerRow(journeyId: string, trigger: JourneyTriggerSeed) {
    return {
      journeyId,
      triggerType: 'PROJECT_CREATED',
      targetProjectType: trigger.targetProjectType,
      targetProjectId: trigger.targetProjectId,
      crossProject: trigger.crossProject,
      screenKey: null,
      actionKey: null,
      device: trigger.device,
      repeatPolicy: trigger.repeatPolicy,
      dismissPolicy: trigger.dismissPolicy,
      active: true,
    };
  }
}
