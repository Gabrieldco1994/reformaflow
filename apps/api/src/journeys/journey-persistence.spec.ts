import { Test, TestingModule } from '@nestjs/testing';
import {
  JourneyDefinition,
  ProjectType,
  makeJourney,
  makeSteps,
  resolveJourneyPlan,
  resetJourneyBuilderSequence,
} from '@reformaflow/domain';
import { PrismaService } from '../prisma/prisma.service';
import { JourneyBootstrapService } from './journey-bootstrap.service';

/**
 * PERSISTÊNCIA ENTRE PUBLISHES (Etapa D do épico #338).
 *
 * `journey-bootstrap.service.spec.ts` (Etapa A) já cobre o bootstrap contra o
 * catálogo REAL: idempotência, hidratação parcial e "não sobrescreve jornada
 * customizada". Este arquivo cobre o que falta e é o coração da Etapa D — o
 * comportamento entre DOIS deploys, dirigido por um catálogo construído pelo
 * próprio teste (via `makeJourney`/`makeSteps`), de forma que nenhuma
 * expectativa dependa da quantidade ou do nome dos passos do produto:
 *
 *  - um deploy que ACRESCENTA um passo ao catálogo não injeta esse passo em
 *    jornadas já publicadas — só o editor pode fazer isso;
 *  - um deploy que REMOVE um passo do catálogo deixa a chave órfã no banco (o
 *    runtime a ignora com aviso, ver `resolveJourneyPlan`), sem apagar dados;
 *  - a configuração salva é igual campo a campo antes e depois do rebootstrap,
 *    para jornadas de 0, 1, 4, 6 e muitas etapas.
 *
 * O catálogo é passado como argumento de `bootstrap()` (seam de teste) em vez
 * de mutar o `JOURNEY_CATALOG` compartilhado, que vazaria entre suítes.
 */

type AnyFn = jest.Mock;

interface JourneyRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  active: boolean;
}

interface JourneyStepRow {
  id: string;
  journeyId: string;
  stepKey: string;
  order: number;
  experience: string;
  label: string;
  subtitle: string | null;
  enabled: boolean;
  skippable: boolean;
}

interface JourneyTriggerRow {
  id: string;
  journeyId: string;
  triggerType: string;
  targetProjectType: ProjectType | null;
  targetProjectId: string | null;
  crossProject: boolean;
  screenKey: string | null;
  actionKey: string | null;
  device: string;
  repeatPolicy: string;
  dismissPolicy: string;
  active: boolean;
}

interface PrismaMock {
  journey: { findUnique: AnyFn; findMany: AnyFn; create: AnyFn; update: AnyFn };
  journeyStep: {
    findMany: AnyFn;
    create: AnyFn;
    createMany: AnyFn;
    update: AnyFn;
    deleteMany: AnyFn;
  };
  journeyTrigger: { findMany: AnyFn; create: AnyFn; createMany: AnyFn };
  _journeys: Map<string, JourneyRow>;
  _steps: JourneyStepRow[];
  _triggers: JourneyTriggerRow[];
}

let idSeq = 0;
const nextId = (prefix: string) => `${prefix}-${++idSeq}`;

/**
 * Mesmo mock stateful do spec da Etapa A: `create`/`createMany` de fato mutam
 * os arrays, para o SEGUNDO `bootstrap()` observar os efeitos do primeiro.
 * `update`/`deleteMany` existem só para falhar alto (o bootstrap jamais pode
 * chamá-los — se chamar, a jornada publicada foi sobrescrita).
 */
function makePrismaMock(
  seed: {
    journeys?: JourneyRow[];
    steps?: JourneyStepRow[];
    triggers?: JourneyTriggerRow[];
  } = {},
): PrismaMock {
  const journeys = new Map<string, JourneyRow>((seed.journeys ?? []).map((j) => [j.key, j]));
  const steps: JourneyStepRow[] = [...(seed.steps ?? [])];
  const triggers: JourneyTriggerRow[] = [...(seed.triggers ?? [])];

  const forbidden = (name: string) =>
    jest.fn().mockImplementation(() => {
      throw new Error(`bootstrap() nunca pode chamar ${name}`);
    });

  return {
    journey: {
      findUnique: jest
        .fn()
        .mockImplementation(({ where }: any) => Promise.resolve(journeys.get(where.key) ?? null)),
      findMany: jest.fn().mockImplementation(() => Promise.resolve([...journeys.values()])),
      create: jest.fn().mockImplementation(({ data }: any) => {
        const row: JourneyRow = { id: nextId('journey'), active: true, description: null, ...data };
        journeys.set(row.key, row);
        return Promise.resolve(row);
      }),
      update: forbidden('journey.update'),
    },
    journeyStep: {
      findMany: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          Promise.resolve(steps.filter((s) => s.journeyId === where.journeyId)),
        ),
      create: jest.fn().mockImplementation(({ data }: any) => {
        const row: JourneyStepRow = { id: nextId('step'), ...data };
        steps.push(row);
        return Promise.resolve(row);
      }),
      createMany: jest.fn().mockImplementation(({ data }: any) => {
        const rows: JourneyStepRow[] = data.map((d: any) => ({ id: nextId('step'), ...d }));
        steps.push(...rows);
        return Promise.resolve({ count: rows.length });
      }),
      update: forbidden('journeyStep.update'),
      deleteMany: forbidden('journeyStep.deleteMany'),
    },
    journeyTrigger: {
      findMany: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          Promise.resolve(triggers.filter((t) => t.journeyId === where.journeyId)),
        ),
      create: jest.fn().mockImplementation(({ data }: any) => {
        const row: JourneyTriggerRow = { id: nextId('trigger'), ...data };
        triggers.push(row);
        return Promise.resolve(row);
      }),
      createMany: jest.fn().mockImplementation(({ data }: any) => {
        const rows: JourneyTriggerRow[] = data.map((d: any) => ({ id: nextId('trigger'), ...d }));
        triggers.push(...rows);
        return Promise.resolve({ count: rows.length });
      }),
    },
    _journeys: journeys,
    _steps: steps,
    _triggers: triggers,
  };
}

/**
 * Traduz uma jornada de fixture (`makeJourney`) para uma entrada de catálogo,
 * que é o formato que o bootstrap consome. Assim o teste descreve o cenário
 * uma vez, em builders, e usa a MESMA fonte para montar catálogo e expectativa.
 */
function toCatalogEntry(journey: ReturnType<typeof makeJourney>): JourneyDefinition {
  return {
    key: journey.key,
    name: journey.name,
    description: `fixture ${journey.key}`,
    steps: journey.steps.map((step) => ({
      key: step.stepKey,
      label: step.label ?? step.stepKey,
      defaultSubtitle: step.subtitle ?? '',
      alwaysAvailable: true,
      skippableByDefault: step.skippable,
    })),
    triggers: [
      {
        targetProjectType: journey.targetProjectType,
        targetProjectId: journey.targetProjectId,
        crossProject: journey.allowCrossProjectNavigation,
        device: 'any',
        repeatPolicy: 'ONCE_PER_USER',
        dismissPolicy: 'DISMISS_UNTIL_LOGIN',
      },
    ],
  };
}

function catalogOf(...journeys: Array<ReturnType<typeof makeJourney>>): Record<string, JourneyDefinition> {
  return journeys.reduce<Record<string, JourneyDefinition>>((acc, journey) => {
    acc[journey.key] = toCatalogEntry(journey);
    return acc;
  }, {});
}

/** Snapshot comparável campo a campo, ignorando ids autogerados. */
function configSnapshot(prisma: PrismaMock) {
  return {
    journeys: [...prisma._journeys.values()]
      .map(({ id: _id, ...rest }) => rest)
      .sort((a, b) => a.key.localeCompare(b.key)),
    steps: prisma._steps
      .map(({ id: _id, journeyId: _j, ...rest }) => rest)
      .sort((a, b) => a.stepKey.localeCompare(b.stepKey)),
    triggers: prisma._triggers
      .map(({ id: _id, journeyId: _j, ...rest }) => rest)
      .sort((a, b) => a.triggerType.localeCompare(b.triggerType)),
  };
}

describe('Jornadas — persistência entre publishes', () => {
  let prisma: PrismaMock;
  let service: JourneyBootstrapService;

  async function build(seed?: Parameters<typeof makePrismaMock>[0]) {
    prisma = makePrismaMock(seed);
    const module: TestingModule = await Test.createTestingModule({
      providers: [JourneyBootstrapService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(JourneyBootstrapService);
  }

  beforeEach(() => {
    idSeq = 0;
    resetJourneyBuilderSequence();
  });

  describe.each([0, 1, 4, 6, 25])('jornada com %i etapas', (stepCount) => {
    it('materializa exatamente os passos do catálogo, na ordem do catálogo', async () => {
      const journey = makeJourney({ key: `fixture:${stepCount}`, stepCount });
      await build();

      await service.bootstrap(catalogOf(journey));

      expect(prisma._steps.map((s) => s.stepKey)).toEqual(journey.steps.map((s) => s.stepKey));
      expect(prisma._steps.map((s) => s.order)).toEqual(journey.steps.map((_, index) => index));
    });

    it('rebootstrap deixa a configuração salva idêntica campo a campo', async () => {
      const journey = makeJourney({ key: `fixture:${stepCount}`, stepCount });
      const catalog = catalogOf(journey);
      await build();

      await service.bootstrap(catalog);
      const before = configSnapshot(prisma);

      await service.bootstrap(catalog);

      expect(configSnapshot(prisma)).toEqual(before);
    });
  });

  it('um deploy que ACRESCENTA um passo ao catálogo não o injeta em jornada já publicada', async () => {
    const published = makeJourney({ key: 'fixture:growth', stepCount: 4 });
    await build();
    await service.bootstrap(catalogOf(published));

    const savedBefore = configSnapshot(prisma);

    // Deploy seguinte: o catálogo ganhou uma etapa nova no fim.
    const grown = makeJourney({
      key: published.key,
      steps: [...published.steps, ...makeSteps(1, () => ({ stepKey: 'novidade', order: 4 }))],
    });
    await service.bootstrap(catalogOf(grown));

    expect(configSnapshot(prisma)).toEqual(savedBefore);
    expect(prisma._steps.some((s) => s.stepKey === 'novidade')).toBe(false);
  });

  it('um deploy que REMOVE um passo do catálogo não apaga a linha já publicada', async () => {
    const published = makeJourney({ key: 'fixture:shrink', stepCount: 6 });
    await build();
    await service.bootstrap(catalogOf(published));

    const shrunk = makeJourney({ key: published.key, steps: published.steps.slice(0, 3) });
    await service.bootstrap(catalogOf(shrunk));

    // Nada foi apagado — `journeyStep.deleteMany` no mock lança se for chamado.
    expect(prisma._steps).toHaveLength(published.steps.length);
  });

  it('a chave órfã que sobra de uma remoção é ignorada pelo runtime, com aviso, sem derrubar a jornada', async () => {
    const published = makeJourney({ key: 'fixture:orphan', stepCount: 4 });
    await build();
    await service.bootstrap(catalogOf(published));

    // O deploy seguinte não conhece mais a última etapa.
    const stillKnown = published.steps.slice(0, -1).map((s) => s.stepKey);
    const orphan = published.steps[published.steps.length - 1].stepKey;

    const plan = resolveJourneyPlan(published, { knownStepKeys: stillKnown });

    expect(plan.total).toBe(stillKnown.length);
    expect(plan.warnings).toEqual([{ code: 'UNKNOWN_STEP_KEY', stepKey: orphan }]);
  });

  it('a customização do admin sobrevive a um rebootstrap de qualquer tamanho de jornada', async () => {
    const published = makeJourney({ key: 'fixture:custom', stepCount: 6 });
    const catalog = catalogOf(published);
    await build();
    await service.bootstrap(catalog);

    // O admin edita: desliga uma etapa, reordena e troca uma para SUMMARY.
    prisma._steps[1].enabled = false;
    prisma._steps[0].order = 99;
    prisma._steps[2].experience = 'SUMMARY';
    const customized = configSnapshot(prisma);

    await service.bootstrap(catalog);

    expect(configSnapshot(prisma)).toEqual(customized);
  });

  it('acrescentar uma jornada NOVA ao catálogo cria só ela, sem tocar nas publicadas', async () => {
    const first = makeJourney({ key: 'fixture:a', stepCount: 4 });
    await build();
    await service.bootstrap(catalogOf(first));
    const before = configSnapshot(prisma);

    const second = makeJourney({
      key: 'fixture:b',
      steps: makeSteps(2, (index) => ({ stepKey: `b-${index}` })),
    });
    await service.bootstrap(catalogOf(first, second));

    expect([...prisma._journeys.keys()].sort()).toEqual(['fixture:a', 'fixture:b']);
    // Tudo que pertencia à primeira jornada continua idêntico.
    const firstKeys = new Set(first.steps.map((s) => s.stepKey));
    expect(
      configSnapshot(prisma).steps.filter((s) => firstKeys.has(s.stepKey)),
    ).toEqual(before.steps);
  });

  it('a configuração persistida é o que o runtime consome — mudar o banco muda o plano, sem rebuild', async () => {
    const published = makeJourney({ key: 'fixture:live', stepCount: 4 });
    await build();
    await service.bootstrap(catalogOf(published));

    const readBack = (): ReturnType<typeof makeJourney> => ({
      ...published,
      steps: prisma._steps
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((row) => ({
          stepKey: row.stepKey,
          order: row.order,
          enabled: row.enabled,
          skippable: row.skippable,
          experience: row.experience as 'SUMMARY' | 'FULL',
          label: row.label,
          subtitle: row.subtitle,
          conditionKey: null,
          conditionUnmetBehavior: 'SKIP' as const,
          targetProjectType: null,
        })),
    });

    const planBefore = resolveJourneyPlan(readBack());

    // O admin publica duas etapas a mais direto no banco (o que o editor faz).
    prisma._steps.push(
      ...makeSteps(2, (index) => ({ stepKey: `extra-${index}`, order: 100 + index })).map(
        (step, index) => ({
          id: nextId('step'),
          journeyId: prisma._steps[0].journeyId,
          stepKey: step.stepKey,
          order: step.order,
          experience: index === 0 ? 'SUMMARY' : 'FULL',
          label: step.stepKey,
          subtitle: null,
          enabled: true,
          skippable: true,
        }),
      ),
    );

    const planAfter = resolveJourneyPlan(readBack());

    expect(planAfter.total).toBe(planBefore.total + 2);
    expect(planAfter.steps.map((s) => s.experience)).toContain('SUMMARY');
  });
});
