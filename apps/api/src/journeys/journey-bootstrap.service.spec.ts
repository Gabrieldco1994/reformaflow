import { Test, TestingModule } from "@nestjs/testing";
import {
  JOURNEY_CATALOG,
  ProjectType,
  listJourneyKeys,
  onboardingJourneyKey,
  type JourneyDefinition,
} from "@reformaflow/domain";
import { PrismaService } from "../prisma/prisma.service";
import { JourneyBootstrapService } from "./journey-bootstrap.service";

/**
 * RED spec for #338 (Jornadas Etapa A — schema Prisma + domínio genérico +
 * bootstrap idempotente).
 *
 * `apps/api/src/journeys/journey-bootstrap.service.ts` does not exist yet —
 * this whole file fails to resolve the import until `backend-expert` lands
 * it. Field names below are taken from the ACTUAL `prisma/schema.prisma`
 * models already landed for this PR (`Journey`, `JourneyTrigger`,
 * `JourneyStep`, `JourneyCompletion`), not guessed:
 *
 *   - `Journey`: id, key (unique), name, description, active, deletedAt
 *     (soft-deletable — NOT in `PrismaService`'s `modelsWithoutSoftDelete`).
 *   - `JourneyTrigger`: journeyId, triggerType (one of
 *     `JOURNEY_TRIGGER_TYPES`), targetProjectType, targetProjectId,
 *     crossProject, screenKey (SCREEN_VISIT only), actionKey (ACTION only),
 *     device, repeatPolicy, dismissPolicy, active. NOT soft-deletable.
 *   - `JourneyStep`: journeyId, stepKey, order, experience (one of
 *     `JOURNEY_STEP_EXPERIENCES`), label, subtitle, enabled, skippable. NOT
 *     soft-deletable. Note this DIFFERS from `OnboardingJourneyStep`: there
 *     `labelOverride`/`subtitleOverride` are nullable (resolved against a
 *     separate code catalog at read time); here `label` is NOT NULL — the
 *     catalog default text is bootstrapped straight into the row, because a
 *     generic `Journey` has no other place to keep its "current" text once
 *     persisted.
 *
 * Assumed (not yet pinned by schema or by a separate architect spec — the
 * GitHub issue is the only contract source for #338; `backend-expert` should
 * confirm or the orchestrator should reconcile with QA before merge):
 *   - `JourneyBootstrapService(prisma: PrismaService)` with one public
 *     method `bootstrap(): Promise<void>`.
 *   - The legacy onboarding journeys in `JOURNEY_CATALOG` are bootstrapped
 *     with `triggerType: 'PROJECT_CREATED'` (they fire once a project of the
 *     matching type exists) and `screenKey: null` / `actionKey: null` (only
 *     SCREEN_VISIT/ACTION triggers use those columns).
 *   - Each step's `experience` defaults to `'FULL'` (matches the Prisma
 *     column default; legacy onboarding steps are full-page flows, never a
 *     SUMMARY widget).
 *   - Missing rows are created; an existing `Journey.key` is bootstrap's
 *     ENTIRE skip signal — its steps/triggers are never read, updated or
 *     re-created, so admin customization survives untouched.
 *
 * Every assertion is data-driven off `JOURNEY_CATALOG`/`listJourneyKeys()`
 * (never a hard-coded "6" or a fixed step count) so it keeps passing
 * unchanged when the epic's own catalog grows.
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
  journey: { findUnique: AnyFn; findMany: AnyFn; create: AnyFn };
  journeyStep: { findMany: AnyFn; create: AnyFn; createMany: AnyFn };
  journeyTrigger: { findMany: AnyFn; create: AnyFn; createMany: AnyFn };
  _journeys: Map<string, JourneyRow>;
  _steps: JourneyStepRow[];
  _triggers: JourneyTriggerRow[];
}

let idSeq = 0;
const nextId = (prefix: string) => `${prefix}-${++idSeq}`;

/**
 * Stateful in-memory Prisma mock (same shape as `buildRateioPrisma` in
 * `conciliacao.service.spec.ts` / `PrismaMock` in `expense.service.spec.ts`):
 * `create`/`createMany` actually mutate the in-memory arrays so a SECOND
 * `bootstrap()` run observes the first run's side effects — this is what
 * makes the idempotency assertions meaningful instead of vacuous.
 */
function makePrismaMock(
  seed: {
    journeys?: JourneyRow[];
    steps?: JourneyStepRow[];
    triggers?: JourneyTriggerRow[];
  } = {},
): PrismaMock {
  const journeys = new Map<string, JourneyRow>(
    (seed.journeys ?? []).map((j) => [j.key, j]),
  );
  const steps: JourneyStepRow[] = [...(seed.steps ?? [])];
  const triggers: JourneyTriggerRow[] = [...(seed.triggers ?? [])];

  const mock: PrismaMock = {
    journey: {
      findUnique: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          Promise.resolve(journeys.get(where.key) ?? null),
        ),
      findMany: jest
        .fn()
        .mockImplementation(() => Promise.resolve([...journeys.values()])),
      create: jest.fn().mockImplementation(({ data }: any) => {
        const row: JourneyRow = {
          id: nextId("journey"),
          active: true,
          description: null,
          ...data,
        };
        journeys.set(row.key, row);
        return Promise.resolve(row);
      }),
    },
    journeyStep: {
      findMany: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          Promise.resolve(steps.filter((s) => s.journeyId === where.journeyId)),
        ),
      create: jest.fn().mockImplementation(({ data }: any) => {
        const row: JourneyStepRow = { id: nextId("step"), ...data };
        steps.push(row);
        return Promise.resolve(row);
      }),
      createMany: jest.fn().mockImplementation(({ data }: any) => {
        const rows: JourneyStepRow[] = data.map((d: any) => ({
          id: nextId("step"),
          ...d,
        }));
        steps.push(...rows);
        return Promise.resolve({ count: rows.length });
      }),
    },
    journeyTrigger: {
      findMany: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          Promise.resolve(
            triggers.filter((t) => t.journeyId === where.journeyId),
          ),
        ),
      create: jest.fn().mockImplementation(({ data }: any) => {
        const row: JourneyTriggerRow = { id: nextId("trigger"), ...data };
        triggers.push(row);
        return Promise.resolve(row);
      }),
      createMany: jest.fn().mockImplementation(({ data }: any) => {
        const rows: JourneyTriggerRow[] = data.map((d: any) => ({
          id: nextId("trigger"),
          ...d,
        }));
        triggers.push(...rows);
        return Promise.resolve({ count: rows.length });
      }),
    },
    _journeys: journeys,
    _steps: steps,
    _triggers: triggers,
  };
  return mock;
}

describe("JourneyBootstrapService", () => {
  let service: JourneyBootstrapService;
  let prisma: PrismaMock;

  async function build(seed?: Parameters<typeof makePrismaMock>[0]) {
    prisma = makePrismaMock(seed);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JourneyBootstrapService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(JourneyBootstrapService);
  }

  beforeEach(() => {
    idSeq = 0;
  });

  describe("empty database", () => {
    beforeEach(async () => {
      await build();
      await service.bootstrap();
    });

    it("creates exactly one Journey row per catalog key (data-driven, not a hard-coded count)", () => {
      expect(prisma._journeys.size).toBe(listJourneyKeys().length);
      expect(new Set(prisma._journeys.keys())).toEqual(
        new Set(listJourneyKeys()),
      );
    });

    it("every created Journey row carries the catalog name/description and is active", () => {
      for (const [key, def] of Object.entries(JOURNEY_CATALOG) as [
        string,
        JourneyDefinition,
      ][]) {
        const journey = prisma._journeys.get(key)!;
        expect(journey.name).toBe(def.name);
        expect(journey.description).toBe(def.description);
        expect(journey.active).toBe(true);
      }
    });

    it("materializes every step of every catalog journey, preserving order/enabled/skippable/label/subtitle", () => {
      for (const [key, def] of Object.entries(JOURNEY_CATALOG) as [
        string,
        JourneyDefinition,
      ][]) {
        const journey = prisma._journeys.get(key)!;
        expect(journey).toBeDefined();
        const rows = prisma._steps
          .filter((s) => s.journeyId === journey.id)
          .sort((a, b) => a.order - b.order);

        expect(rows).toHaveLength(def.steps.length);
        rows.forEach((row, i) => {
          const stepDef = def.steps[i];
          expect(row.stepKey).toBe(stepDef.key);
          expect(row.order).toBe(i);
          expect(row.enabled).toBe(true);
          expect(row.skippable).toBe(stepDef.skippableByDefault);
          // `label`/`subtitle` are NOT NULL on `JourneyStep` (unlike
          // `OnboardingJourneyStep.labelOverride/subtitleOverride`): bootstrap
          // must copy the catalog default text straight into the row.
          expect(row.label).toBe(stepDef.label);
          expect(row.subtitle).toBe(stepDef.defaultSubtitle);
        });
      }
    });

    it("every step experience is a valid JOURNEY_STEP_EXPERIENCES value (defaults to FULL for legacy full-page onboarding)", () => {
      for (const row of prisma._steps) {
        expect(["SUMMARY", "FULL"]).toContain(row.experience);
      }
      // Onboarding steps are full pages today, never a summary widget.
      expect(prisma._steps.every((s) => s.experience === "FULL")).toBe(true);
    });

    it("materializes every trigger of every catalog journey with matching targeting/device/policy fields", () => {
      for (const [key, def] of Object.entries(JOURNEY_CATALOG) as [
        string,
        JourneyDefinition,
      ][]) {
        const journey = prisma._journeys.get(key)!;
        const rows = prisma._triggers.filter((t) => t.journeyId === journey.id);
        expect(rows).toHaveLength(def.triggers.length);
        def.triggers.forEach((triggerDef) => {
          expect(rows).toContainEqual(
            expect.objectContaining({
              targetProjectType: triggerDef.targetProjectType,
              targetProjectId: triggerDef.targetProjectId,
              crossProject: triggerDef.crossProject,
              device: triggerDef.device,
              repeatPolicy: triggerDef.repeatPolicy,
              dismissPolicy: triggerDef.dismissPolicy,
              active: true,
            }),
          );
        });
      }
    });

    it("legacy onboarding triggers fire on PROJECT_CREATED and never populate screenKey/actionKey", () => {
      for (const row of prisma._triggers) {
        expect(row.triggerType).toBe("PROJECT_CREATED");
        expect(row.screenKey).toBeNull();
        expect(row.actionKey).toBeNull();
      }
    });

    it("PESSOAL journey has strictly more steps than REFORMA (regression-proof: relative comparison, never a bare number)", () => {
      const pessoalId = prisma._journeys.get(
        onboardingJourneyKey(ProjectType.PESSOAL),
      )!.id;
      const reformaId = prisma._journeys.get(
        onboardingJourneyKey(ProjectType.REFORMA),
      )!.id;
      const pessoalSteps = prisma._steps.filter(
        (s) => s.journeyId === pessoalId,
      );
      const reformaSteps = prisma._steps.filter(
        (s) => s.journeyId === reformaId,
      );

      expect(pessoalSteps.length).toBeGreaterThan(reformaSteps.length);
      expect(pessoalSteps.length).toBe(
        JOURNEY_CATALOG[onboardingJourneyKey(ProjectType.PESSOAL)].steps.length,
      );
      expect(reformaSteps.length).toBe(
        JOURNEY_CATALOG[onboardingJourneyKey(ProjectType.REFORMA)].steps.length,
      );
    });
  });

  describe("idempotency", () => {
    it("running bootstrap() twice creates zero additional Journey/Step/Trigger rows", async () => {
      await build();
      await service.bootstrap();

      const journeysAfterFirst = prisma._journeys.size;
      const stepsAfterFirst = prisma._steps.length;
      const triggersAfterFirst = prisma._triggers.length;
      const journeyCreateCallsAfterFirst =
        prisma.journey.create.mock.calls.length;

      await service.bootstrap();

      expect(prisma._journeys.size).toBe(journeysAfterFirst);
      expect(prisma._steps.length).toBe(stepsAfterFirst);
      expect(prisma._triggers.length).toBe(triggersAfterFirst);
      expect(prisma.journey.create.mock.calls.length).toBe(
        journeyCreateCallsAfterFirst,
      );
    });

    it("a fully-bootstrapped run is a no-op for every create/createMany call on the second pass", async () => {
      await build();
      await service.bootstrap();
      prisma.journey.create.mockClear();
      prisma.journeyStep.create.mockClear();
      prisma.journeyStep.createMany.mockClear();
      prisma.journeyTrigger.create.mockClear();
      prisma.journeyTrigger.createMany.mockClear();

      await service.bootstrap();

      expect(prisma.journey.create).not.toHaveBeenCalled();
      expect(prisma.journeyStep.create).not.toHaveBeenCalled();
      expect(prisma.journeyStep.createMany).not.toHaveBeenCalled();
      expect(prisma.journeyTrigger.create).not.toHaveBeenCalled();
      expect(prisma.journeyTrigger.createMany).not.toHaveBeenCalled();
    });
  });

  describe("never overwrites a customized journey", () => {
    it("an already-existing journey with admin-customized steps is left byte-for-byte unchanged", async () => {
      const existingJourneyId = "journey-pessoal-existing";
      const customizedSteps: JourneyStepRow[] = [
        {
          id: "step-custom-1",
          journeyId: existingJourneyId,
          stepKey: "expense",
          order: 0,
          experience: "FULL",
          enabled: false, // admin disabled this step
          skippable: false, // admin made it mandatory
          label: "Meu gasto customizado",
          subtitle: "Texto que o admin escreveu.",
        },
      ];

      await build({
        journeys: [
          {
            id: existingJourneyId,
            key: onboardingJourneyKey(ProjectType.PESSOAL),
            name: "Onboarding — PESSOAL (customizado)",
            description: "custom",
            active: true,
          },
        ],
        steps: customizedSteps,
      });

      await service.bootstrap();

      // Byte-for-byte: the exact same row objects, untouched.
      const rowsAfter = prisma._steps.filter(
        (s) => s.journeyId === existingJourneyId,
      );
      expect(rowsAfter).toEqual(customizedSteps);
      expect(rowsAfter).toHaveLength(1);

      // Bootstrap must not have even attempted to touch this journey's rows.
      expect(prisma.journeyStep.create).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ journeyId: existingJourneyId }),
        }),
      );
      expect(prisma.journeyStep.createMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({ journeyId: existingJourneyId }),
          ]),
        }),
      );
    });

    it("only creates the MISSING journeys, leaving an already-bootstrapped one untouched (partial hydration)", async () => {
      const existingKey = onboardingJourneyKey(ProjectType.CASA);
      const existingRow: JourneyRow = {
        id: "journey-casa-existing",
        key: existingKey,
        name: "existing",
        description: "existing",
        active: true,
      };
      await build({ journeys: [existingRow] });

      await service.bootstrap();

      // Every OTHER catalog key now exists...
      for (const key of listJourneyKeys()) {
        expect(prisma._journeys.has(key)).toBe(true);
      }
      // ...but the pre-existing one was never recreated (still the original row).
      expect(prisma._journeys.get(existingKey)).toEqual(existingRow);
      expect(prisma.journey.create).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ key: existingKey }),
        }),
      );
      // And total journey count is still exactly the full catalog size.
      expect(prisma._journeys.size).toBe(listJourneyKeys().length);
    });
  });
});
