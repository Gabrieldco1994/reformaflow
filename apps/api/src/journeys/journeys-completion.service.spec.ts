import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ProjectType } from '@reformaflow/domain';
import { PrismaService } from '../prisma/prisma.service';
import { JourneysCompletionService } from './journeys-completion.service';

/**
 * RED spec for #339 (Jornadas Etapa B). `journeys-completion.service.ts`
 * does not exist yet — import fails until `backend-expert` lands it.
 *
 * Contract assumed (issue #339 AC: "Conclusão é idempotente para
 * ONCE_PER_USER e ONCE_PER_PROJECT; ALWAYS permanece elegível sem criar
 * JourneyCompletion"):
 *
 *   - `JourneysCompletionService(prisma).complete(journeyId, dto, tenantId, userId)`
 *     where `dto = { triggerId: string; projectId?: string }`. `triggerId`
 *     is REQUIRED — the client got it straight from the `/journeys/eligible`
 *     response, so there is no ambiguity about WHICH trigger (and therefore
 *     which `repeatPolicy`) is being completed.
 *   - `triggerId` must belong to `journeyId` — a trigger id from a
 *     different journey is a `BadRequestException` (never silently
 *     accepted, never a 404 that could leak whether the id exists at all).
 *   - `projectId`, if given, is tenant-scoped
 *     (`prisma.project.findFirst({ where: { id, tenantId, deletedAt: null } })`);
 *     a cross-tenant or nonexistent `projectId` is `NotFoundException`.
 *   - Per the matched trigger's `repeatPolicy`:
 *       - `ONCE_PER_USER`: `completionKey = \`${tenantId}:${userId}:none\`` —
 *         upserts a `JourneyCompletion` row (`completedAt` set). Calling
 *         `complete()` twice must NOT create a second row (idempotent).
 *       - `ONCE_PER_PROJECT`: requires `projectId` in the dto (else
 *         `BadRequestException` — can't record project-scoped completion
 *         without a project); `completionKey = \`${tenantId}:${userId}:${projectId}\`.
 *       - `ALWAYS`: NEVER calls `journeyCompletion.create`/`upsert` at all —
 *         this is the sharpest mutation-catching assertion: the mock's
 *         `create`/`upsert` must show zero calls after `complete()`.
 *   - Return shape: `{ completed: true; recorded: boolean }` — `recorded`
 *     is `false` only for `ALWAYS` (no row persisted), `true` otherwise
 *     (whether just-created or already existing from a prior call).
 */

type AnyFn = jest.Mock;

interface JourneyRow {
  id: string;
  key: string;
  active: boolean;
  deletedAt: Date | null;
}

interface JourneyTriggerRow {
  id: string;
  journeyId: string;
  repeatPolicy: string;
  targetProjectType: string | null;
  targetProjectId: string | null;
  active: boolean;
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
  journey: { findFirst: AnyFn };
  journeyTrigger: { findFirst: AnyFn };
  journeyCompletion: { findUnique: AnyFn; create: AnyFn; upsert: AnyFn };
  project: { findFirst: AnyFn };
  _completions: JourneyCompletionRow[];
}

let idSeq = 0;
const nextId = (prefix: string) => `${prefix}-${++idSeq}`;

function makePrismaMock(seed: {
  journeys?: JourneyRow[];
  triggers?: JourneyTriggerRow[];
  completions?: JourneyCompletionRow[];
  projects?: ProjectRow[];
}): PrismaMock {
  const journeys = [...(seed.journeys ?? [])];
  const triggers = [...(seed.triggers ?? [])];
  const completions = [...(seed.completions ?? [])];
  const projects = [...(seed.projects ?? [])];

  return {
    journey: {
      findFirst: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          Promise.resolve(
            journeys.find((j) => j.id === where.id && j.active && !j.deletedAt) ?? null,
          ),
        ),
    },
    journeyTrigger: {
      findFirst: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          Promise.resolve(
            triggers.find((t) => t.id === where.id && t.journeyId === where.journeyId) ?? null,
          ),
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
      create: jest.fn().mockImplementation(({ data }: any) => {
        const row: JourneyCompletionRow = {
          id: nextId('completion'),
          dismissedAt: null,
          ...data,
        };
        completions.push(row);
        return Promise.resolve(row);
      }),
      upsert: jest.fn().mockImplementation(({ where, create, update }: any) => {
        const key = where.journeyId_completionKey;
        const existing = completions.find(
          (c) => c.journeyId === key.journeyId && c.completionKey === key.completionKey,
        );
        if (existing) {
          Object.assign(existing, update);
          return Promise.resolve(existing);
        }
        const row: JourneyCompletionRow = {
          id: nextId('completion'),
          dismissedAt: null,
          ...create,
        };
        completions.push(row);
        return Promise.resolve(row);
      }),
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

const journey: JourneyRow = {
  id: 'j1',
  key: 'onboarding:PESSOAL',
  active: true,
  deletedAt: null,
};

function trigger(over: Partial<JourneyTriggerRow>): JourneyTriggerRow {
  return {
    id: 't1',
    journeyId: 'j1',
    repeatPolicy: 'ONCE_PER_USER',
    targetProjectType: null,
    targetProjectId: null,
    active: true,
    ...over,
  };
}

describe('JourneysCompletionService', () => {
  let service: JourneysCompletionService;
  let prisma: PrismaMock;

  async function build(seed: Parameters<typeof makePrismaMock>[0]) {
    prisma = makePrismaMock(seed);
    const module: TestingModule = await Test.createTestingModule({
      providers: [JourneysCompletionService, { provide: PrismaService, useValue: prisma as any }],
    }).compile();
    service = module.get(JourneysCompletionService);
  }

  beforeEach(() => {
    idSeq = 0;
  });

  describe('invalid ids', () => {
    it('rejects a nonexistent journeyId with NotFound', async () => {
      await build({ journeys: [], triggers: [] });
      await expect(
        service.complete('ghost-journey', { triggerId: 't1' } as any, 'tenant-a', 'user-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects an inactive journey with NotFound', async () => {
      await build({
        journeys: [{ ...journey, active: false }],
        triggers: [trigger({})],
      });
      await expect(
        service.complete('j1', { triggerId: 't1' } as any, 'tenant-a', 'user-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a triggerId that does not belong to journeyId (foreign trigger) with BadRequest', async () => {
      await build({
        journeys: [journey, { id: 'j2', key: 'other', active: true, deletedAt: null }],
        triggers: [trigger({ id: 't-of-j2', journeyId: 'j2' })],
      });
      await expect(
        service.complete('j1', { triggerId: 't-of-j2' } as any, 'tenant-a', 'user-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a completely nonexistent triggerId with BadRequest', async () => {
      await build({ journeys: [journey], triggers: [] });
      await expect(
        service.complete('j1', { triggerId: 'ghost-trigger' } as any, 'tenant-a', 'user-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('tenant gating on projectId', () => {
    it('rejects a projectId belonging to another tenant as NotFound', async () => {
      await build({
        journeys: [journey],
        triggers: [trigger({ repeatPolicy: 'ONCE_PER_PROJECT' })],
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
        service.complete(
          'j1',
          { triggerId: 't1', projectId: 'proj-x' } as any,
          'tenant-a',
          'user-1',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('ONCE_PER_USER — idempotent, project-agnostic', () => {
    it('creates exactly one JourneyCompletion row keyed tenant:user:none on first call', async () => {
      await build({
        journeys: [journey],
        triggers: [trigger({ repeatPolicy: 'ONCE_PER_USER' })],
      });

      const result = await service.complete('j1', { triggerId: 't1' } as any, 'tenant-a', 'user-1');

      expect(result).toEqual({ completed: true, recorded: true });
      expect(prisma._completions).toHaveLength(1);
      expect(prisma._completions[0]).toMatchObject({
        journeyId: 'j1',
        tenantId: 'tenant-a',
        userId: 'user-1',
        completionKey: 'tenant-a:user-1:none',
      });
      expect(prisma._completions[0].completedAt).not.toBeNull();
    });

    it('calling complete() twice leaves EXACTLY one row (idempotent, not a duplicate)', async () => {
      await build({
        journeys: [journey],
        triggers: [trigger({ repeatPolicy: 'ONCE_PER_USER' })],
      });

      await service.complete('j1', { triggerId: 't1' } as any, 'tenant-a', 'user-1');
      const second = await service.complete('j1', { triggerId: 't1' } as any, 'tenant-a', 'user-1');

      expect(prisma._completions).toHaveLength(1);
      expect(second).toEqual({ completed: true, recorded: true });
    });

    it('is scoped per user — a different user completing does not affect the first user completion count', async () => {
      await build({
        journeys: [journey],
        triggers: [trigger({ repeatPolicy: 'ONCE_PER_USER' })],
      });

      await service.complete('j1', { triggerId: 't1' } as any, 'tenant-a', 'user-1');
      await service.complete('j1', { triggerId: 't1' } as any, 'tenant-a', 'user-2');

      expect(prisma._completions).toHaveLength(2);
      expect(new Set(prisma._completions.map((c) => c.completionKey))).toEqual(
        new Set(['tenant-a:user-1:none', 'tenant-a:user-2:none']),
      );
    });

    it('passing a projectId is IGNORED for the completionKey (ONCE_PER_USER is project-agnostic)', async () => {
      await build({
        journeys: [journey],
        triggers: [trigger({ repeatPolicy: 'ONCE_PER_USER' })],
        projects: [
          {
            id: 'proj-1',
            tenantId: 'tenant-a',
            type: ProjectType.PESSOAL,
            deletedAt: null,
          },
        ],
      });

      await service.complete(
        'j1',
        { triggerId: 't1', projectId: 'proj-1' } as any,
        'tenant-a',
        'user-1',
      );

      expect(prisma._completions).toHaveLength(1);
      expect(prisma._completions[0].completionKey).toBe('tenant-a:user-1:none');
    });
  });

  describe('ONCE_PER_PROJECT — idempotent, requires a project', () => {
    it('rejects when projectId is missing (cannot record project-scoped completion without one)', async () => {
      await build({
        journeys: [journey],
        triggers: [trigger({ repeatPolicy: 'ONCE_PER_PROJECT' })],
      });
      await expect(
        service.complete('j1', { triggerId: 't1' } as any, 'tenant-a', 'user-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma._completions).toHaveLength(0);
    });

    it('creates exactly one row keyed tenant:user:projectId on first call', async () => {
      await build({
        journeys: [journey],
        triggers: [trigger({ repeatPolicy: 'ONCE_PER_PROJECT' })],
        projects: [
          {
            id: 'proj-1',
            tenantId: 'tenant-a',
            type: ProjectType.PESSOAL,
            deletedAt: null,
          },
        ],
      });

      const result = await service.complete(
        'j1',
        { triggerId: 't1', projectId: 'proj-1' } as any,
        'tenant-a',
        'user-1',
      );

      expect(result).toEqual({ completed: true, recorded: true });
      expect(prisma._completions).toHaveLength(1);
      expect(prisma._completions[0].completionKey).toBe('tenant-a:user-1:proj-1');
    });

    it('calling complete() twice for the SAME project leaves exactly one row', async () => {
      await build({
        journeys: [journey],
        triggers: [trigger({ repeatPolicy: 'ONCE_PER_PROJECT' })],
        projects: [
          {
            id: 'proj-1',
            tenantId: 'tenant-a',
            type: ProjectType.PESSOAL,
            deletedAt: null,
          },
        ],
      });

      await service.complete(
        'j1',
        { triggerId: 't1', projectId: 'proj-1' } as any,
        'tenant-a',
        'user-1',
      );
      await service.complete(
        'j1',
        { triggerId: 't1', projectId: 'proj-1' } as any,
        'tenant-a',
        'user-1',
      );

      expect(prisma._completions).toHaveLength(1);
    });

    it('completing for a DIFFERENT project creates a SECOND, independent row', async () => {
      await build({
        journeys: [journey],
        triggers: [trigger({ repeatPolicy: 'ONCE_PER_PROJECT' })],
        projects: [
          {
            id: 'proj-1',
            tenantId: 'tenant-a',
            type: ProjectType.PESSOAL,
            deletedAt: null,
          },
          {
            id: 'proj-2',
            tenantId: 'tenant-a',
            type: ProjectType.PESSOAL,
            deletedAt: null,
          },
        ],
      });

      await service.complete(
        'j1',
        { triggerId: 't1', projectId: 'proj-1' } as any,
        'tenant-a',
        'user-1',
      );
      await service.complete(
        'j1',
        { triggerId: 't1', projectId: 'proj-2' } as any,
        'tenant-a',
        'user-1',
      );

      expect(prisma._completions).toHaveLength(2);
      expect(new Set(prisma._completions.map((c) => c.completionKey))).toEqual(
        new Set(['tenant-a:user-1:proj-1', 'tenant-a:user-1:proj-2']),
      );
    });
  });

  describe('ALWAYS — never persisted', () => {
    it('never calls journeyCompletion.create nor .upsert, and reports recorded:false', async () => {
      await build({
        journeys: [journey],
        triggers: [trigger({ repeatPolicy: 'ALWAYS' })],
      });

      const result = await service.complete('j1', { triggerId: 't1' } as any, 'tenant-a', 'user-1');

      expect(result).toEqual({ completed: true, recorded: false });
      expect(prisma.journeyCompletion.create).not.toHaveBeenCalled();
      expect(prisma.journeyCompletion.upsert).not.toHaveBeenCalled();
      expect(prisma._completions).toHaveLength(0);
    });

    it('stays recorded:false consistently across repeated calls (no row ever appears)', async () => {
      await build({
        journeys: [journey],
        triggers: [trigger({ repeatPolicy: 'ALWAYS' })],
      });

      await service.complete('j1', { triggerId: 't1' } as any, 'tenant-a', 'user-1');
      await service.complete('j1', { triggerId: 't1' } as any, 'tenant-a', 'user-1');

      expect(prisma._completions).toHaveLength(0);
    });
  });
});
