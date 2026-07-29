import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ProjectType } from '@reformaflow/domain';
import { PrismaService } from '../prisma/prisma.service';
import { JourneysEligibilityService } from './journeys-eligibility.service';

/**
 * RED spec for #339 (Jornadas Etapa B). `journeys-eligibility.service.ts`
 * does not exist yet — import fails until `backend-expert` lands it.
 *
 * Contract assumed (issue #339 + the #338 schema are the only sources):
 *
 *   - `JourneysEligibilityService(prisma).getEligible(query, tenantId, userId)`
 *     where `query` is:
 *       `{ triggerType: JourneyTriggerType; device: 'web'|'mobile';
 *          projectId?: string; projectType?: ProjectType;
 *          screenKey?: string; actionKey?: string }`.
 *   - `triggerType` and `device` are REQUIRED (caller always knows its own
 *     device and what just happened); everything else is contextual.
 *   - If `projectId` is given, its type is looked up in the DB and MUST
 *     match a given `projectType` (if also given) — an incoherent pair is a
 *     `BadRequestException`, never silently ignored.
 *   - Tenant gating: `projectId` is resolved via
 *     `prisma.project.findFirst({ where: { id, tenantId, deletedAt: null } })`.
 *     A `projectId` belonging to ANOTHER tenant (or nonexistent) throws
 *     `NotFoundException` — the SAME error as "doesn't exist", so the
 *     response never confirms cross-tenant existence.
 *   - A `(journey, trigger)` pair is eligible when: both `active`; trigger's
 *     `triggerType` matches; `device === 'any' || device === query.device`;
 *     `targetProjectType` is `null` (global) OR equals the resolved
 *     project's type; `targetProjectId` is `null` OR equals `query.projectId`;
 *     for `SCREEN_VISIT`, `screenKey` must equal `query.screenKey`; for
 *     `ACTION`, `actionKey` must equal `query.actionKey`.
 *   - Repeat-policy gating against `JourneyCompletion` (unique per
 *     `[journeyId, completionKey]`):
 *       - `ONCE_PER_USER`: `completionKey = \`${tenantId}:${userId}:none\`` —
 *         excluded once completed, REGARDLESS of which project is passed.
 *       - `ONCE_PER_PROJECT`: `completionKey = \`${tenantId}:${userId}:${projectId}\`` —
 *         requires a `projectId`; without one the pair is excluded (can't
 *         reliably resolve project-scoped repeat state).
 *       - `ALWAYS`: NEVER excluded, and `journeyCompletion.findUnique` isn't
 *         even the deciding factor — completion rows are irrelevant here.
 *   - Each eligible entry returns ONLY `enabled` steps, sorted by `order`
 *     ascending — including the empty-array case (0 enabled steps is valid,
 *     not an error).
 */

type AnyFn = jest.Mock;

interface JourneyRow {
  id: string;
  key: string;
  name: string;
  active: boolean;
  deletedAt: Date | null;
}

interface JourneyTriggerRow {
  id: string;
  journeyId: string;
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

interface JourneyCompletionRow {
  id: string;
  journeyId: string;
  tenantId: string;
  userId: string | null;
  projectId: string | null;
  completionKey: string;
  completedAt: Date | null;
  dismissedAt: Date | null;
}

interface ProjectRow {
  id: string;
  tenantId: string;
  type: string;
  deletedAt: Date | null;
}

interface PrismaMock {
  journey: { findMany: AnyFn };
  journeyTrigger: { findMany: AnyFn };
  journeyStep: { findMany: AnyFn };
  journeyCompletion: { findUnique: AnyFn; findMany: AnyFn };
  project: { findFirst: AnyFn };
  _completions: JourneyCompletionRow[];
}

function makePrismaMock(seed: {
  journeys?: JourneyRow[];
  triggers?: JourneyTriggerRow[];
  steps?: JourneyStepRow[];
  completions?: JourneyCompletionRow[];
  projects?: ProjectRow[];
}): PrismaMock {
  const journeys = [...(seed.journeys ?? [])];
  const triggers = [...(seed.triggers ?? [])];
  const steps = [...(seed.steps ?? [])];
  const completions = [...(seed.completions ?? [])];
  const projects = [...(seed.projects ?? [])];

  return {
    journey: {
      findMany: jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve(journeys.filter((j) => j.active && !j.deletedAt)),
        ),
    },
    journeyTrigger: {
      findMany: jest
        .fn()
        .mockImplementation(() => Promise.resolve(triggers.filter((t) => t.active))),
    },
    journeyStep: {
      findMany: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          Promise.resolve(steps.filter((s) => s.journeyId === where.journeyId)),
        ),
    },
    journeyCompletion: {
      findUnique: jest.fn().mockImplementation(({ where }: any) => {
        const key = where.journeyId_completionKey;
        return Promise.resolve(
          completions.find(
            (c) => c.journeyId === key.journeyId && c.completionKey === key.completionKey,
          ) ?? null,
        );
      }),
      findMany: jest.fn().mockImplementation(() => Promise.resolve([...completions])),
    },
    project: {
      findFirst: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          Promise.resolve(
            projects.find(
              (p) => p.id === where.id && p.tenantId === where.tenantId && p.deletedAt === null,
            ) ?? null,
          ),
        ),
    },
    _completions: completions,
  };
}

function trigger(over: Partial<JourneyTriggerRow>): JourneyTriggerRow {
  return {
    id: 't1',
    journeyId: 'j1',
    triggerType: 'PROJECT_CREATED',
    targetProjectType: null,
    targetProjectId: null,
    crossProject: false,
    screenKey: null,
    actionKey: null,
    device: 'any',
    repeatPolicy: 'ONCE_PER_USER',
    dismissPolicy: 'DISMISS_UNTIL_LOGIN',
    active: true,
    ...over,
  };
}

describe('JourneysEligibilityService', () => {
  let service: JourneysEligibilityService;
  let prisma: PrismaMock;

  async function build(seed: Parameters<typeof makePrismaMock>[0]) {
    prisma = makePrismaMock(seed);
    const module: TestingModule = await Test.createTestingModule({
      providers: [JourneysEligibilityService, { provide: PrismaService, useValue: prisma as any }],
    }).compile();
    service = module.get(JourneysEligibilityService);
  }

  const journey: JourneyRow = {
    id: 'j1',
    key: 'onboarding:PESSOAL',
    name: 'Onboarding',
    active: true,
    deletedAt: null,
  };

  describe('required query fields', () => {
    it('rejects a missing/invalid triggerType', async () => {
      await build({ journeys: [journey] });
      await expect(
        service.getEligible({ triggerType: 'BOGUS' as any, device: 'web' }, 'tenant-a', 'user-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a missing/invalid device', async () => {
      await build({ journeys: [journey] });
      await expect(
        service.getEligible(
          { triggerType: 'PROJECT_CREATED', device: 'toaster' as any },
          'tenant-a',
          'user-1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('SCREEN_VISIT without screenKey is rejected', async () => {
      await build({ journeys: [journey] });
      await expect(
        service.getEligible(
          { triggerType: 'SCREEN_VISIT', device: 'web' } as any,
          'tenant-a',
          'user-1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('ACTION without actionKey is rejected', async () => {
      await build({ journeys: [journey] });
      await expect(
        service.getEligible({ triggerType: 'ACTION', device: 'web' } as any, 'tenant-a', 'user-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('tenant gating on projectId', () => {
    it('a projectId belonging to ANOTHER tenant is rejected as NotFound (not confirmed to exist elsewhere)', async () => {
      await build({
        journeys: [journey],
        projects: [
          {
            id: 'proj-x',
            tenantId: 'tenant-OTHER',
            type: ProjectType.PESSOAL,
            deletedAt: null,
          },
        ],
      });
      await expect(
        service.getEligible(
          {
            triggerType: 'PROJECT_CREATED',
            device: 'web',
            projectId: 'proj-x',
          },
          'tenant-a',
          'user-1',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('a nonexistent projectId is rejected as NotFound', async () => {
      await build({ journeys: [journey], projects: [] });
      await expect(
        service.getEligible(
          { triggerType: 'PROJECT_CREATED', device: 'web', projectId: 'ghost' },
          'tenant-a',
          'user-1',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('a projectId owned by the caller tenant resolves fine', async () => {
      await build({
        journeys: [journey],
        triggers: [trigger({ targetProjectType: ProjectType.PESSOAL })],
        steps: [],
        projects: [
          {
            id: 'proj-mine',
            tenantId: 'tenant-a',
            type: ProjectType.PESSOAL,
            deletedAt: null,
          },
        ],
      });
      await expect(
        service.getEligible(
          {
            triggerType: 'PROJECT_CREATED',
            device: 'web',
            projectId: 'proj-mine',
          },
          'tenant-a',
          'user-1',
        ),
      ).resolves.toHaveLength(1);
    });

    it('an explicit projectType incoherent with the resolved project type is rejected', async () => {
      await build({
        journeys: [journey],
        projects: [
          {
            id: 'proj-mine',
            tenantId: 'tenant-a',
            type: ProjectType.CASA,
            deletedAt: null,
          },
        ],
      });
      await expect(
        service.getEligible(
          {
            triggerType: 'PROJECT_CREATED',
            device: 'web',
            projectId: 'proj-mine',
            projectType: ProjectType.PESSOAL,
          },
          'tenant-a',
          'user-1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('matching filters', () => {
    it('excludes a trigger whose device is web-only when caller device is mobile', async () => {
      await build({
        journeys: [journey],
        triggers: [trigger({ device: 'web', targetProjectType: null })],
        steps: [],
      });
      const result = await service.getEligible(
        { triggerType: 'PROJECT_CREATED', device: 'mobile' },
        'tenant-a',
        'user-1',
      );
      expect(result).toEqual([]);
    });

    it('includes a device:"any" trigger for both web and mobile callers', async () => {
      await build({
        journeys: [journey],
        triggers: [trigger({ device: 'any', targetProjectType: null })],
        steps: [],
      });
      await expect(
        service.getEligible(
          { triggerType: 'PROJECT_CREATED', device: 'web' },
          'tenant-a',
          'user-1',
        ),
      ).resolves.toHaveLength(1);
      await expect(
        service.getEligible(
          { triggerType: 'PROJECT_CREATED', device: 'mobile' },
          'tenant-a',
          'user-1',
        ),
      ).resolves.toHaveLength(1);
    });

    it('excludes a trigger scoped to a different targetProjectType than the caller', async () => {
      await build({
        journeys: [journey],
        triggers: [trigger({ targetProjectType: ProjectType.CASA })],
        steps: [],
        projects: [
          {
            id: 'proj-mine',
            tenantId: 'tenant-a',
            type: ProjectType.PESSOAL,
            deletedAt: null,
          },
        ],
      });
      const result = await service.getEligible(
        {
          triggerType: 'PROJECT_CREATED',
          device: 'web',
          projectId: 'proj-mine',
        },
        'tenant-a',
        'user-1',
      );
      expect(result).toEqual([]);
    });

    it('excludes a trigger with a fixed targetProjectId different from the caller projectId', async () => {
      await build({
        journeys: [journey],
        triggers: [
          trigger({
            targetProjectId: 'proj-other',
            targetProjectType: ProjectType.PESSOAL,
          }),
        ],
        steps: [],
        projects: [
          {
            id: 'proj-mine',
            tenantId: 'tenant-a',
            type: ProjectType.PESSOAL,
            deletedAt: null,
          },
        ],
      });
      const result = await service.getEligible(
        {
          triggerType: 'PROJECT_CREATED',
          device: 'web',
          projectId: 'proj-mine',
        },
        'tenant-a',
        'user-1',
      );
      expect(result).toEqual([]);
    });

    it('SCREEN_VISIT only matches the exact screenKey', async () => {
      await build({
        journeys: [journey],
        triggers: [
          trigger({
            triggerType: 'SCREEN_VISIT',
            screenKey: 'monthly',
            targetProjectType: ProjectType.PESSOAL,
          }),
        ],
        steps: [],
        projects: [
          {
            id: 'proj-mine',
            tenantId: 'tenant-a',
            type: ProjectType.PESSOAL,
            deletedAt: null,
          },
        ],
      });
      const wrongScreen = await service.getEligible(
        {
          triggerType: 'SCREEN_VISIT',
          device: 'web',
          screenKey: 'dre',
          projectId: 'proj-mine',
        },
        'tenant-a',
        'user-1',
      );
      expect(wrongScreen).toEqual([]);

      const rightScreen = await service.getEligible(
        {
          triggerType: 'SCREEN_VISIT',
          device: 'web',
          screenKey: 'monthly',
          projectId: 'proj-mine',
        },
        'tenant-a',
        'user-1',
      );
      expect(rightScreen).toHaveLength(1);
    });

    it('ACTION only matches the exact actionKey', async () => {
      await build({
        journeys: [journey],
        triggers: [
          trigger({
            triggerType: 'ACTION',
            actionKey: 'expense.new',
            targetProjectType: null,
          }),
        ],
        steps: [],
      });
      const wrongAction = await service.getEligible(
        { triggerType: 'ACTION', device: 'web', actionKey: 'receipt.new' },
        'tenant-a',
        'user-1',
      );
      expect(wrongAction).toEqual([]);

      const rightAction = await service.getEligible(
        { triggerType: 'ACTION', device: 'web', actionKey: 'expense.new' },
        'tenant-a',
        'user-1',
      );
      expect(rightAction).toHaveLength(1);
    });

    it('an inactive trigger is never eligible even if everything else matches', async () => {
      await build({
        journeys: [journey],
        triggers: [trigger({ active: false, targetProjectType: null })],
        steps: [],
      });
      const result = await service.getEligible(
        { triggerType: 'PROJECT_CREATED', device: 'web' },
        'tenant-a',
        'user-1',
      );
      expect(result).toEqual([]);
    });

    it('an inactive Journey excludes ALL of its triggers even if the trigger row itself is active', async () => {
      await build({
        journeys: [{ ...journey, active: false }],
        triggers: [trigger({ targetProjectType: null })],
        steps: [],
      });
      const result = await service.getEligible(
        { triggerType: 'PROJECT_CREATED', device: 'web' },
        'tenant-a',
        'user-1',
      );
      expect(result).toEqual([]);
    });
  });

  describe('repeat-policy gating', () => {
    it('ONCE_PER_USER is excluded once completed, regardless of which project is queried afterwards', async () => {
      await build({
        journeys: [journey],
        triggers: [trigger({ repeatPolicy: 'ONCE_PER_USER', targetProjectType: null })],
        steps: [],
        completions: [
          {
            id: 'c1',
            journeyId: 'j1',
            tenantId: 'tenant-a',
            userId: 'user-1',
            projectId: null,
            completionKey: 'tenant-a:user-1:none',
            completedAt: new Date('2026-01-01'),
            dismissedAt: null,
          },
        ],
      });
      const result = await service.getEligible(
        { triggerType: 'PROJECT_CREATED', device: 'web' },
        'tenant-a',
        'user-1',
      );
      expect(result).toEqual([]);
    });

    it('ONCE_PER_USER stays eligible for a DIFFERENT user who has not completed it', async () => {
      await build({
        journeys: [journey],
        triggers: [trigger({ repeatPolicy: 'ONCE_PER_USER', targetProjectType: null })],
        steps: [],
        completions: [
          {
            id: 'c1',
            journeyId: 'j1',
            tenantId: 'tenant-a',
            userId: 'user-1',
            projectId: null,
            completionKey: 'tenant-a:user-1:none',
            completedAt: new Date('2026-01-01'),
            dismissedAt: null,
          },
        ],
      });
      const result = await service.getEligible(
        { triggerType: 'PROJECT_CREATED', device: 'web' },
        'tenant-a',
        'user-2',
      );
      expect(result).toHaveLength(1);
    });

    it('ONCE_PER_PROJECT is excluded only for the SAME project, staying eligible for a different one', async () => {
      await build({
        journeys: [journey],
        triggers: [
          trigger({
            repeatPolicy: 'ONCE_PER_PROJECT',
            targetProjectType: ProjectType.PESSOAL,
          }),
        ],
        steps: [],
        completions: [
          {
            id: 'c1',
            journeyId: 'j1',
            tenantId: 'tenant-a',
            userId: 'user-1',
            projectId: 'proj-done',
            completionKey: 'tenant-a:user-1:proj-done',
            completedAt: new Date('2026-01-01'),
            dismissedAt: null,
          },
        ],
        projects: [
          {
            id: 'proj-done',
            tenantId: 'tenant-a',
            type: ProjectType.PESSOAL,
            deletedAt: null,
          },
          {
            id: 'proj-fresh',
            tenantId: 'tenant-a',
            type: ProjectType.PESSOAL,
            deletedAt: null,
          },
        ],
      });

      const doneProject = await service.getEligible(
        {
          triggerType: 'PROJECT_CREATED',
          device: 'web',
          projectId: 'proj-done',
        },
        'tenant-a',
        'user-1',
      );
      expect(doneProject).toEqual([]);

      const freshProject = await service.getEligible(
        {
          triggerType: 'PROJECT_CREATED',
          device: 'web',
          projectId: 'proj-fresh',
        },
        'tenant-a',
        'user-1',
      );
      expect(freshProject).toHaveLength(1);
    });

    it('ONCE_PER_PROJECT without a projectId in the query is excluded (ambiguous, cannot resolve repeat state)', async () => {
      await build({
        journeys: [journey],
        triggers: [
          trigger({
            repeatPolicy: 'ONCE_PER_PROJECT',
            targetProjectType: null,
          }),
        ],
        steps: [],
      });
      const result = await service.getEligible(
        { triggerType: 'PROJECT_CREATED', device: 'web' },
        'tenant-a',
        'user-1',
      );
      expect(result).toEqual([]);
    });

    it('ALWAYS stays eligible even with a matching completion row present, and never even queries it', async () => {
      await build({
        journeys: [journey],
        triggers: [trigger({ repeatPolicy: 'ALWAYS', targetProjectType: null })],
        steps: [],
        completions: [
          {
            id: 'c1',
            journeyId: 'j1',
            tenantId: 'tenant-a',
            userId: 'user-1',
            projectId: null,
            completionKey: 'tenant-a:user-1:none',
            completedAt: new Date('2026-01-01'),
            dismissedAt: null,
          },
        ],
      });
      const result = await service.getEligible(
        { triggerType: 'PROJECT_CREATED', device: 'web' },
        'tenant-a',
        'user-1',
      );
      expect(result).toHaveLength(1);
    });
  });

  describe('step ordering — data-driven, 0/1/4/6/many enabled steps', () => {
    it.each([0, 1, 4, 6, 10])(
      'returns exactly %i enabled steps, sorted by order ascending',
      async (count) => {
        const steps: JourneyStepRow[] = [];
        for (let i = 0; i < count; i++) {
          // Insert in REVERSE order on purpose — the service must sort, not trust insertion order.
          steps.push({
            id: `s${i}`,
            journeyId: 'j1',
            stepKey: `step-${count - i}`,
            order: count - i,
            experience: 'FULL',
            label: `Step ${count - i}`,
            subtitle: null,
            enabled: true,
            skippable: true,
          });
        }
        // A disabled step mixed in must never appear regardless of count.
        steps.push({
          id: 'disabled',
          journeyId: 'j1',
          stepKey: 'disabled-step',
          order: -1,
          experience: 'FULL',
          label: 'Disabled',
          subtitle: null,
          enabled: false,
          skippable: true,
        });

        await build({
          journeys: [journey],
          triggers: [trigger({ targetProjectType: null })],
          steps,
        });

        const result = await service.getEligible(
          { triggerType: 'PROJECT_CREATED', device: 'web' },
          'tenant-a',
          'user-1',
        );
        expect(result).toHaveLength(1);
        expect(result[0].steps).toHaveLength(count);
        expect(result[0].steps.every((s: any) => s.stepKey !== 'disabled-step')).toBe(true);
        const orders = result[0].steps.map((s: any) => s.order);
        expect(orders).toEqual([...orders].sort((a, b) => a - b));
      },
    );
  });

  describe('eligible entry shape', () => {
    it('carries the matched trigger id, repeatPolicy, dismissPolicy and crossProject flag', async () => {
      await build({
        journeys: [journey],
        triggers: [
          trigger({
            id: 'trigger-xyz',
            repeatPolicy: 'ALWAYS',
            dismissPolicy: 'REOPEN_NEXT_TRIGGER',
            crossProject: true,
            targetProjectType: null,
          }),
        ],
        steps: [],
      });
      const [entry] = await service.getEligible(
        { triggerType: 'PROJECT_CREATED', device: 'web' },
        'tenant-a',
        'user-1',
      );
      expect(entry).toMatchObject({
        journeyId: 'j1',
        key: 'onboarding:PESSOAL',
        triggerId: 'trigger-xyz',
        repeatPolicy: 'ALWAYS',
        dismissPolicy: 'REOPEN_NEXT_TRIGGER',
        crossProject: true,
      });
    });

    // Regressão: o `route`/`slug` de uma etapa Completa precisa vir da
    // RESPOSTA REAL do serviço (`JOURNEY_STEP_SLUGS` resolvido aqui, no
    // servidor), nunca de um fixture de teste preenchido à mão do lado do
    // consumidor — foi exatamente um fixture com `route` chumbado que deixou
    // o bug original passar verde: o CONSUMO (runtime web) foi corrigido sem
    // que nunca tivesse existido PRODUÇÃO (a API nunca mandava o campo).
    // Só `JourneysEligibilityService` real está sob teste aqui — Prisma é o
    // único mock.
    it('resolves slug from JOURNEY_STEP_SLUGS for a FULL step with a known stepKey (no fixture route/slug supplied)', async () => {
      await build({
        journeys: [journey],
        triggers: [trigger({ id: 'trigger-full' })],
        steps: [
          {
            id: 's1',
            journeyId: 'j1',
            stepKey: 'expense',
            order: 0,
            experience: 'FULL',
            label: 'Despesa',
            subtitle: null,
            enabled: true,
            skippable: true,
          },
        ],
      });
      const [entry] = await service.getEligible(
        { triggerType: 'PROJECT_CREATED', device: 'web' },
        'tenant-a',
        'user-1',
      );
      expect(entry.steps[0]).toMatchObject({ stepKey: 'expense', slug: 'expenses' });
    });

    it('omits slug for a stepKey without a real page (SUMMARY-only, e.g. feedback)', async () => {
      await build({
        journeys: [journey],
        triggers: [trigger({ id: 'trigger-summary' })],
        steps: [
          {
            id: 's1',
            journeyId: 'j1',
            stepKey: 'feedback',
            order: 0,
            experience: 'SUMMARY',
            label: 'Feedback',
            subtitle: null,
            enabled: true,
            skippable: true,
          },
        ],
      });
      const [entry] = await service.getEligible(
        { triggerType: 'PROJECT_CREATED', device: 'web' },
        'tenant-a',
        'user-1',
      );
      expect(entry.steps[0].slug).toBeUndefined();
    });

    // Etapa E, parte 2 (todo #338): stepKey novo do catálogo de resumos
    // INFORMATIVOS (`summary-catalog.ts`, não `onboarding-journey.ts`) — o
    // painel resolve o resumo pelo catálogo do domínio no cliente, nunca por
    // um `slug` vindo do servidor (essas telas não têm rota de "Etapa
    // Completa" — `dashboard` nunca está em `JOURNEY_STEP_SLUGS`). Mesma
    // proteção estrutural do teste acima: serviço REAL, Prisma é o único
    // mock — garante que o servidor nunca inventa um slug para uma tela que
    // só existe como resumo informativo do lado do cliente.
    it('omits slug for an informational-summary-only stepKey (e.g. dashboard)', async () => {
      await build({
        journeys: [journey],
        triggers: [trigger({ id: 'trigger-informational' })],
        steps: [
          {
            id: 's1',
            journeyId: 'j1',
            stepKey: 'dashboard',
            order: 0,
            experience: 'SUMMARY',
            label: 'Dashboard',
            subtitle: null,
            enabled: true,
            skippable: true,
          },
        ],
      });
      const [entry] = await service.getEligible(
        { triggerType: 'PROJECT_CREATED', device: 'web' },
        'tenant-a',
        'user-1',
      );
      expect(entry.steps[0]).toMatchObject({ stepKey: 'dashboard', experience: 'SUMMARY' });
      expect(entry.steps[0].slug).toBeUndefined();
    });
  });
});
