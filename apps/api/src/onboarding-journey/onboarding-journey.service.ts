import { BadRequestException, Injectable } from '@nestjs/common';
import {
  ONBOARDING_JOURNEY_DEFAULTS,
  ProjectType,
  resolveJourney,
  type JourneyStepOverride,
  type ResolvedJourneyStep,
} from '@reformaflow/domain';
import { PrismaService } from '../prisma/prisma.service';
import { SaveJourneyDto } from './dto/save-journey.dto';

const PROJECT_TYPES = Object.values(ProjectType);

/** Linha crua do banco, no shape que o `resolveJourney` consome. */
interface JourneyRow {
  stepKey: string;
  order: number;
  enabled: boolean;
  skippable: boolean;
  labelOverride: string | null;
  subtitleOverride: string | null;
}

function toOverride(row: JourneyRow): JourneyStepOverride {
  return {
    stepKey: row.stepKey,
    order: row.order,
    enabled: row.enabled,
    skippable: row.skippable,
    label: row.labelOverride,
    subtitle: row.subtitleOverride,
  };
}

/** Texto em branco = "sem override": o catálogo volta a mandar. */
function normalizeText(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Config GLOBAL da jornada de onboarding (uma por tipo de projeto, sem tenant).
 *
 * Invariante: banco vazio ⇒ jornada padrão completa. Nunca devolvemos `[]` por
 * falta de linhas — quem manda em "quais telas existem" é o catálogo do domain;
 * o banco só guarda os ajustes do admin.
 */
@Injectable()
export class OnboardingJourneyService {
  constructor(private prisma: PrismaService) {}

  /** Valida o `:projectType` da URL antes de qualquer I/O. */
  parseProjectType(raw: string): ProjectType {
    const match = PROJECT_TYPES.find((type) => type === raw);
    if (!match) {
      throw new BadRequestException(
        `Tipo de projeto inválido: "${raw}". Válidos: ${PROJECT_TYPES.join(', ')}`,
      );
    }
    return match;
  }

  /** Jornada de um tipo, com os overrides do admin já aplicados. */
  async getJourney(projectType: ProjectType): Promise<ResolvedJourneyStep[]> {
    const type = this.parseProjectType(projectType);
    const rows = (await this.prisma.onboardingJourneyStep.findMany({
      where: { projectType: type },
      orderBy: { order: 'asc' },
    })) as JourneyRow[];

    return resolveJourney(type, rows.map(toOverride));
  }

  /** Todas as jornadas de uma vez (painel do admin mostra os 6 tipos). */
  async getAllJourneys(): Promise<Record<ProjectType, ResolvedJourneyStep[]>> {
    const rows = (await this.prisma.onboardingJourneyStep.findMany({
      orderBy: { order: 'asc' },
    })) as (JourneyRow & { projectType: string })[];

    const byType = new Map<string, JourneyStepOverride[]>();
    for (const row of rows) {
      const list = byType.get(row.projectType) ?? [];
      list.push(toOverride(row));
      byType.set(row.projectType, list);
    }

    return PROJECT_TYPES.reduce(
      (acc, type) => {
        acc[type] = resolveJourney(type, byType.get(type) ?? []);
        return acc;
      },
      {} as Record<ProjectType, ResolvedJourneyStep[]>,
    );
  }

  /**
   * Persiste os overrides do admin (upsert por `[projectType, stepKey]`) e
   * devolve a jornada já resolvida.
   *
   * Valida TODAS as chaves antes de escrever qualquer coisa: um body com uma
   * chave desconhecida não pode gravar metade e falhar na outra metade.
   */
  async saveJourney(
    projectType: ProjectType,
    dto: SaveJourneyDto,
  ): Promise<ResolvedJourneyStep[]> {
    const type = this.parseProjectType(projectType);
    const steps = dto?.steps;
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new BadRequestException('Informe ao menos um passo em "steps".');
    }

    const knownKeys = new Set(ONBOARDING_JOURNEY_DEFAULTS[type].map((def) => def.key));
    const seen = new Set<string>();
    for (const step of steps) {
      if (!knownKeys.has(step.stepKey)) {
        throw new BadRequestException(
          `Passo desconhecido para ${type}: "${step.stepKey}". Válidos: ${[...knownKeys].join(', ')}`,
        );
      }
      if (seen.has(step.stepKey)) {
        throw new BadRequestException(`Passo duplicado no corpo: "${step.stepKey}".`);
      }
      seen.add(step.stepKey);
    }

    // Uma única transação: ou todos os passos entram, ou nenhum — meia jornada
    // salva deixaria o onboarding numa ordem que o admin nunca pediu.
    await this.prisma.$transaction(
      steps.map((step) => {
        const data = {
          order: step.order,
          enabled: step.enabled,
          skippable: step.skippable,
          labelOverride: normalizeText(step.label),
          subtitleOverride: normalizeText(step.subtitle),
        };
        return this.prisma.onboardingJourneyStep.upsert({
          where: { projectType_stepKey: { projectType: type, stepKey: step.stepKey } },
          create: { projectType: type, stepKey: step.stepKey, ...data },
          update: data,
        });
      }),
    );

    return this.getJourney(type);
  }
}
