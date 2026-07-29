import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  JOURNEY_DISMISS_POLICIES,
  JOURNEY_REPEAT_POLICIES,
  JOURNEY_SAFE_ACTIONS,
  JOURNEY_STEP_EXPERIENCES,
  JOURNEY_TRIGGER_DEVICES,
  JOURNEY_TRIGGER_TYPES,
  ProjectType,
  getJourneyScreenKeys,
} from '@reformaflow/domain';
import { PrismaService } from '../prisma/prisma.service';
import {
  JOURNEY_LABEL_MAX_LENGTH,
  JOURNEY_SUBTITLE_MAX_LENGTH,
} from '../onboarding-journey/dto/save-journey.dto';
import { CreateJourneyDto } from './dto/create-journey.dto';
import { JourneyStepInputDto } from './dto/journey-step-input.dto';
import { JourneyTriggerInputDto } from './dto/journey-trigger-input.dto';
import { UpdateJourneyDto } from './dto/update-journey.dto';

const JOURNEY_KEY_MAX_LENGTH = 120;
const JOURNEY_NAME_MAX_LENGTH = 120;
const JOURNEY_DESCRIPTION_MAX_LENGTH = 500;

/** Linha `JourneyStep` já normalizada, pronta para `create`/`update` do Prisma. */
interface NormalizedStep {
  stepKey: string;
  order: number;
  experience: string;
  label: string;
  subtitle: string | null;
  enabled: boolean;
  skippable: boolean;
}

/** Linha `JourneyTrigger` já normalizada e coerente, pronta para o Prisma. */
interface NormalizedTrigger {
  triggerType: string;
  targetProjectType: string | null;
  targetProjectId: string | null;
  crossProject: boolean;
  screenKey: string | null;
  actionKey: string | null;
  device: string;
  repeatPolicy: string;
  dismissPolicy: string;
  active: boolean;
}

export interface AdminJourneyStepView {
  id: string;
  stepKey: string;
  order: number;
  experience: string;
  label: string;
  subtitle: string | null;
  enabled: boolean;
  skippable: boolean;
}

export interface AdminJourneyTriggerView {
  id: string;
  triggerType: string;
  targetProjectType: string | null;
  targetProjectId: string | null;
  crossProject: boolean;
  screenKey: string | null;
  actionKey: string | null;
  device: string;
  repeatPolicy: string;
  dismissPolicy: string;
  active: boolean;
}

export interface AdminJourneyView {
  id: string;
  key: string;
  name: string;
  description: string | null;
  active: boolean;
  steps: AdminJourneyStepView[];
  triggers: AdminJourneyTriggerView[];
}

function requireNonEmptyString(value: unknown, field: string, maxLength?: number): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    throw new BadRequestException(`${field} é obrigatório.`);
  }
  if (maxLength && trimmed.length > maxLength) {
    throw new BadRequestException(`${field} excede ${maxLength} caracteres.`);
  }
  return trimmed;
}

function normalizeOptionalText(
  value: string | null | undefined,
  maxLength: number,
  field: string,
): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLength) {
    throw new BadRequestException(`${field} excede ${maxLength} caracteres.`);
  }
  return trimmed;
}

/** Chave natural de um gatilho — MESMA tupla do `@@unique` em `JourneyTrigger`. */
function triggerNaturalKey(t: {
  triggerType: string;
  targetProjectType: string | null;
  targetProjectId: string | null;
  screenKey: string | null;
  actionKey: string | null;
}): string {
  return [t.triggerType, t.targetProjectType, t.targetProjectId, t.screenKey, t.actionKey].join(
    '\u0000',
  );
}

/**
 * Serviço admin de Jornadas (#339 — Etapa B). Painel GLOBAL, igual ao
 * `OnboardingJourneyService`/`AdminOnboardingJourneyController` que substitui:
 * `Journey`/`JourneyTrigger`/`JourneyStep` não têm `tenantId` no schema da
 * Etapa A — a existência de um `targetProjectId` é checada GLOBALMENTE aqui
 * (o projeto existe?); QUEM PODE VER esse projeto (tenant + ACL do usuário)
 * é responsabilidade de `JourneysEligibilityService`/`JourneysCompletionService`,
 * que rodam com um tenant real em contexto.
 *
 * Nenhuma linha é fisicamente apagada por este serviço — retirar uma jornada
 * de circulação é `active:false` (`update`), nunca um `delete`.
 */
@Injectable()
export class JourneysAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<AdminJourneyView[]> {
    const journeys = await this.prisma.journey.findMany({
      where: { deletedAt: null },
    });
    return Promise.all(journeys.map((j) => this.buildView(j.id, j)));
  }

  async get(id: string): Promise<AdminJourneyView> {
    const journey = await this.findActiveRow(id);
    return this.buildView(id, journey);
  }

  async create(dto: CreateJourneyDto): Promise<AdminJourneyView> {
    const key = requireNonEmptyString(dto?.key, 'key', JOURNEY_KEY_MAX_LENGTH);
    const name = requireNonEmptyString(dto?.name, 'name', JOURNEY_NAME_MAX_LENGTH);
    const description = normalizeOptionalText(
      dto?.description ?? null,
      JOURNEY_DESCRIPTION_MAX_LENGTH,
      'description',
    );
    const active = dto?.active ?? true;
    if (typeof active !== 'boolean') {
      throw new BadRequestException('active precisa ser booleano.');
    }

    const rawSteps = Array.isArray(dto?.steps) ? dto.steps : [];
    const steps = this.normalizeStepsForCreate(rawSteps);

    const rawTriggers = Array.isArray(dto?.triggers) ? dto.triggers : [];
    if (rawTriggers.length === 0) {
      throw new BadRequestException(
        'Informe ao menos um gatilho — uma jornada precisa de alguma forma de disparar.',
      );
    }
    const triggers = await this.normalizeTriggersForWrite(rawTriggers);

    const existing = await this.prisma.journey.findFirst({
      where: { key, deletedAt: null },
    });
    if (existing) {
      throw new ConflictException(`Já existe uma jornada com a chave "${key}".`);
    }

    let journeyId: string;
    try {
      journeyId = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const journey = await tx.journey.create({
          data: { key, name, description, active },
        });
        if (steps.length > 0) {
          await tx.journeyStep.createMany({
            data: steps.map((s) => ({ journeyId: journey.id, ...s })),
          });
        }
        await tx.journeyTrigger.createMany({
          data: triggers.map((t) => ({ journeyId: journey.id, ...t })),
        });
        return journey.id;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`Já existe uma jornada com a chave "${key}".`);
      }
      throw error;
    }

    return this.get(journeyId);
  }

  async update(id: string, dto: UpdateJourneyDto): Promise<AdminJourneyView> {
    await this.findActiveRow(id);

    const journeyData: Record<string, unknown> = {};
    if (dto?.name !== undefined) {
      journeyData.name = requireNonEmptyString(dto.name, 'name', JOURNEY_NAME_MAX_LENGTH);
    }
    if (dto?.description !== undefined) {
      journeyData.description = normalizeOptionalText(
        dto.description,
        JOURNEY_DESCRIPTION_MAX_LENGTH,
        'description',
      );
    }
    if (dto?.active !== undefined) {
      if (typeof dto.active !== 'boolean') {
        throw new BadRequestException('active precisa ser booleano.');
      }
      journeyData.active = dto.active;
    }

    let stepPatches: { stepKey: string; isNew: boolean; data: Partial<NormalizedStep> }[] = [];
    if (dto?.steps !== undefined) {
      if (!Array.isArray(dto.steps)) {
        throw new BadRequestException('steps precisa ser um array.');
      }
      const currentSteps = await this.prisma.journeyStep.findMany({ where: { journeyId: id } });
      const currentKeys = new Set(currentSteps.map((s) => s.stepKey));
      stepPatches = this.normalizeStepsForUpdate(dto.steps, currentKeys);
    }

    let triggerPatches: NormalizedTrigger[] = [];
    if (dto?.triggers !== undefined) {
      if (!Array.isArray(dto.triggers)) {
        throw new BadRequestException('triggers precisa ser um array.');
      }
      triggerPatches = await this.normalizeTriggersForWrite(dto.triggers);
    }

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      if (Object.keys(journeyData).length > 0) {
        await tx.journey.update({ where: { id }, data: journeyData });
      }
      for (const patch of stepPatches) {
        await tx.journeyStep.upsert({
          where: { journeyId_stepKey: { journeyId: id, stepKey: patch.stepKey } },
          create: { journeyId: id, ...(patch.data as NormalizedStep) },
          update: patch.data,
        });
      }
      for (const trigger of triggerPatches) {
        // A chave natural de `JourneyTrigger` tem 4 campos NULLABLE
        // (`targetProjectType`/`targetProjectId`/`screenKey`/`actionKey`). O
        // `WhereUniqueInput` composto que o Prisma Client REAL gera para essa
        // tupla exige `string` — não `string | null` — então um `upsert` com
        // essa chave e qualquer campo `null` (o caso comum: gatilho global,
        // sem projeto/tela/ação) é rejeitado em runtime. O `as any` que
        // existia aqui escondia o erro de TIPO, nunca o de EXECUÇÃO.
        // `findFirst` + `create`/`update` usa filtros simples, que aceitam
        // `null` — mesmo padrão de `journeys-completion.service.ts`. Tudo
        // dentro da MESMA transação: meia jornada salva é pior que erro.
        const existing = await tx.journeyTrigger.findFirst({
          where: {
            journeyId: id,
            triggerType: trigger.triggerType,
            targetProjectType: trigger.targetProjectType,
            targetProjectId: trigger.targetProjectId,
            screenKey: trigger.screenKey,
            actionKey: trigger.actionKey,
          },
        });
        if (existing) {
          await tx.journeyTrigger.update({
            where: { id: existing.id },
            data: {
              crossProject: trigger.crossProject,
              device: trigger.device,
              repeatPolicy: trigger.repeatPolicy,
              dismissPolicy: trigger.dismissPolicy,
              active: trigger.active,
            },
          });
        } else {
          await tx.journeyTrigger.create({
            data: { journeyId: id, ...trigger },
          });
        }
      }
    });

    return this.get(id);
  }

  // ─── internos ──────────────────────────────────────────────────────────

  private async findActiveRow(id: string) {
    const journey = await this.prisma.journey.findFirst({
      where: { id, deletedAt: null },
    });
    if (!journey) {
      throw new NotFoundException(`Jornada "${id}" não encontrada.`);
    }
    return journey;
  }

  private async buildView(
    id: string,
    journey: { key: string; name: string; description: string | null; active: boolean },
  ): Promise<AdminJourneyView> {
    const [steps, triggers] = await Promise.all([
      this.prisma.journeyStep.findMany({ where: { journeyId: id }, orderBy: { order: 'asc' } }),
      this.prisma.journeyTrigger.findMany({ where: { journeyId: id } }),
    ]);
    return {
      id,
      key: journey.key,
      name: journey.name,
      description: journey.description,
      active: journey.active,
      // A mock de teste ignora `orderBy` — ordenamos aqui também para nunca
      // depender da ordem de inserção (mesma garantia do banco real).
      steps: [...steps].sort((a, b) => a.order - b.order),
      triggers,
    };
  }

  private normalizeStepsForCreate(rawSteps: JourneyStepInputDto[]): NormalizedStep[] {
    const seen = new Set<string>();
    return rawSteps.map((raw, index) => {
      const stepKey = requireNonEmptyString(raw?.stepKey, 'stepKey (steps)');
      if (seen.has(stepKey)) {
        throw new BadRequestException(`Passo duplicado no corpo: "${stepKey}".`);
      }
      seen.add(stepKey);
      const label = requireNonEmptyString(
        raw?.label,
        `label do passo "${stepKey}"`,
        JOURNEY_LABEL_MAX_LENGTH,
      );
      const subtitle = normalizeOptionalText(
        raw?.subtitle,
        JOURNEY_SUBTITLE_MAX_LENGTH,
        `subtitle do passo "${stepKey}"`,
      );
      const experience = raw?.experience ?? 'FULL';
      if (!(JOURNEY_STEP_EXPERIENCES as readonly string[]).includes(experience)) {
        throw new BadRequestException(
          `experience inválida para "${stepKey}": "${experience}". Válidas: ${JOURNEY_STEP_EXPERIENCES.join(', ')}`,
        );
      }
      return {
        stepKey,
        order: typeof raw?.order === 'number' ? raw.order : index,
        experience,
        label,
        subtitle,
        enabled: raw?.enabled ?? true,
        skippable: raw?.skippable ?? true,
      };
    });
  }

  private normalizeStepsForUpdate(
    rawSteps: JourneyStepInputDto[],
    currentKeys: Set<string>,
  ): { stepKey: string; isNew: boolean; data: Partial<NormalizedStep> }[] {
    const seen = new Set<string>();
    return rawSteps.map((raw) => {
      const stepKey = requireNonEmptyString(raw?.stepKey, 'stepKey (steps)');
      if (seen.has(stepKey)) {
        throw new BadRequestException(`Passo duplicado no corpo: "${stepKey}".`);
      }
      seen.add(stepKey);
      const isNew = !currentKeys.has(stepKey);

      if (isNew) {
        const label = requireNonEmptyString(
          raw?.label,
          `label do passo "${stepKey}"`,
          JOURNEY_LABEL_MAX_LENGTH,
        );
        const subtitle = normalizeOptionalText(
          raw?.subtitle,
          JOURNEY_SUBTITLE_MAX_LENGTH,
          `subtitle do passo "${stepKey}"`,
        );
        const experience = raw?.experience ?? 'FULL';
        if (!(JOURNEY_STEP_EXPERIENCES as readonly string[]).includes(experience)) {
          throw new BadRequestException(`experience inválida para "${stepKey}": "${experience}".`);
        }
        return {
          stepKey,
          isNew: true,
          data: {
            stepKey,
            order: raw?.order ?? 0,
            experience,
            label,
            subtitle,
            enabled: raw?.enabled ?? true,
            skippable: raw?.skippable ?? true,
          },
        };
      }

      // Patch parcial: só os campos EXPLICITAMENTE enviados mudam. Ausência
      // != "resetar para o default" — o resto da linha salva sobrevive.
      const data: Partial<NormalizedStep> = {};
      if (raw?.order !== undefined) data.order = raw.order;
      if (raw?.label !== undefined) {
        data.label = requireNonEmptyString(
          raw.label,
          `label do passo "${stepKey}"`,
          JOURNEY_LABEL_MAX_LENGTH,
        );
      }
      if (raw?.subtitle !== undefined) {
        data.subtitle = normalizeOptionalText(
          raw.subtitle,
          JOURNEY_SUBTITLE_MAX_LENGTH,
          `subtitle do passo "${stepKey}"`,
        );
      }
      if (raw?.enabled !== undefined) data.enabled = raw.enabled;
      if (raw?.skippable !== undefined) data.skippable = raw.skippable;
      if (raw?.experience !== undefined) {
        if (!(JOURNEY_STEP_EXPERIENCES as readonly string[]).includes(raw.experience)) {
          throw new BadRequestException(`experience inválida para "${stepKey}": "${raw.experience}".`);
        }
        data.experience = raw.experience;
      }
      return { stepKey, isNew: false, data };
    });
  }

  /**
   * Normaliza + valida uma lista de gatilhos crus (create ou update), incluindo
   * a checagem de `targetProjectId` no banco (GLOBAL — sem tenant, ver
   * cabeçalho da classe) e a rejeição de tupla natural duplicada no MESMO
   * payload.
   */
  private async normalizeTriggersForWrite(
    rawTriggers: JourneyTriggerInputDto[],
  ): Promise<NormalizedTrigger[]> {
    const seen = new Set<string>();
    const normalized: NormalizedTrigger[] = [];
    for (const raw of rawTriggers) {
      const trigger = await this.normalizeAndValidateTrigger(raw);
      const key = triggerNaturalKey(trigger);
      if (seen.has(key)) {
        throw new BadRequestException(
          'Dois gatilhos com a mesma combinação de tipo/alvo/tela/ação — isso violaria a unicidade do banco.',
        );
      }
      seen.add(key);
      normalized.push(trigger);
    }
    return normalized;
  }

  private async normalizeAndValidateTrigger(
    raw: JourneyTriggerInputDto,
  ): Promise<NormalizedTrigger> {
    const triggerType = raw?.triggerType as string;
    if (!(JOURNEY_TRIGGER_TYPES as readonly string[]).includes(triggerType)) {
      throw new BadRequestException(
        `triggerType inválido: "${triggerType}". Válidos: ${JOURNEY_TRIGGER_TYPES.join(', ')}`,
      );
    }

    const targetProjectType = raw?.targetProjectType ?? null;
    if (
      targetProjectType !== null &&
      !Object.values(ProjectType).includes(targetProjectType as ProjectType)
    ) {
      throw new BadRequestException(`targetProjectType inválido: "${targetProjectType}".`);
    }

    const targetProjectId = raw?.targetProjectId ?? null;
    const crossProject = raw?.crossProject ?? false;
    if (typeof crossProject !== 'boolean') {
      throw new BadRequestException('crossProject precisa ser booleano.');
    }

    const screenKey = raw?.screenKey ?? null;
    const actionKey = raw?.actionKey ?? null;

    const device = raw?.device ?? 'any';
    if (!(JOURNEY_TRIGGER_DEVICES as readonly string[]).includes(device)) {
      throw new BadRequestException(
        `device inválido: "${device}". Válidos: ${JOURNEY_TRIGGER_DEVICES.join(', ')}`,
      );
    }

    const repeatPolicy = raw?.repeatPolicy ?? 'ONCE_PER_USER';
    if (!(JOURNEY_REPEAT_POLICIES as readonly string[]).includes(repeatPolicy)) {
      throw new BadRequestException(
        `repeatPolicy inválida: "${repeatPolicy}". Válidas: ${JOURNEY_REPEAT_POLICIES.join(', ')}`,
      );
    }

    const dismissPolicy = raw?.dismissPolicy ?? 'DISMISS_UNTIL_LOGIN';
    if (!(JOURNEY_DISMISS_POLICIES as readonly string[]).includes(dismissPolicy)) {
      throw new BadRequestException(
        `dismissPolicy inválida: "${dismissPolicy}". Válidas: ${JOURNEY_DISMISS_POLICIES.join(', ')}`,
      );
    }

    const active = raw?.active ?? true;
    if (typeof active !== 'boolean') {
      throw new BadRequestException('active (trigger) precisa ser booleano.');
    }

    if (triggerType === 'SCREEN_VISIT') {
      if (actionKey !== null) {
        throw new BadRequestException('SCREEN_VISIT não usa actionKey.');
      }
      if (!screenKey) {
        throw new BadRequestException('SCREEN_VISIT exige screenKey.');
      }
      if (targetProjectType === null) {
        throw new BadRequestException(
          'SCREEN_VISIT exige targetProjectType — telas são sempre específicas de um tipo de projeto.',
        );
      }
      const validScreens = getJourneyScreenKeys(targetProjectType as ProjectType);
      if (!validScreens.includes(screenKey)) {
        throw new BadRequestException(
          `screenKey "${screenKey}" não existe para o tipo "${targetProjectType}". Válidos: ${validScreens.join(', ')}`,
        );
      }
    } else if (triggerType === 'ACTION') {
      if (screenKey !== null) {
        throw new BadRequestException('ACTION não usa screenKey.');
      }
      if (!actionKey) {
        throw new BadRequestException('ACTION exige actionKey.');
      }
      if (!(JOURNEY_SAFE_ACTIONS as readonly string[]).includes(actionKey)) {
        throw new BadRequestException(
          `actionKey fora do catálogo seguro: "${actionKey}". Válidos: ${JOURNEY_SAFE_ACTIONS.join(', ')}`,
        );
      }
    } else {
      // SIGNUP_COMPLETED | PROJECT_CREATED — nenhum dos dois se aplica: o
      // usuário/projeto ainda não tem tela nem ação para amarrar.
      if (screenKey !== null) {
        throw new BadRequestException(`${triggerType} não usa screenKey.`);
      }
      if (actionKey !== null) {
        throw new BadRequestException(`${triggerType} não usa actionKey.`);
      }
    }

    if (crossProject && targetProjectType === null && targetProjectId === null) {
      throw new BadRequestException(
        'crossProject:true exige um alvo (targetProjectType ou targetProjectId) — não há para onde cruzar.',
      );
    }

    if (targetProjectId !== null) {
      const project = await this.prisma.project.findFirst({
        where: { id: targetProjectId, deletedAt: null },
      });
      if (!project) {
        throw new BadRequestException(`targetProjectId "${targetProjectId}" não existe.`);
      }
      if (targetProjectType !== null && project.type !== targetProjectType) {
        throw new BadRequestException(
          `targetProjectId "${targetProjectId}" é do tipo "${project.type}", incoerente com targetProjectType "${targetProjectType}".`,
        );
      }
    }

    return {
      triggerType,
      targetProjectType,
      targetProjectId,
      crossProject,
      screenKey,
      actionKey,
      device,
      repeatPolicy,
      dismissPolicy,
      active,
    };
  }
}
