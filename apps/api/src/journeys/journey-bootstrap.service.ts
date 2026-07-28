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

  async bootstrap(): Promise<void> {
    for (const journey of Object.values(JOURNEY_CATALOG)) {
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
      enabled: true,
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
