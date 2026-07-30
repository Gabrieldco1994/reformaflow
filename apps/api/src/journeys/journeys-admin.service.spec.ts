import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ProjectType } from '@reformaflow/domain';
import { PrismaService } from '../prisma/prisma.service';
import { JourneysAdminService } from './journeys-admin.service';

/**
 * RED spec for #339 (Jornadas Etapa B — API admin, elegibilidade e conclusão).
 *
 * `apps/api/src/journeys/journeys-admin.service.ts` does not exist yet — this
 * whole file fails to resolve the import until `backend-expert` lands it.
 *
 * Contract assumed below (issue #339 is the only source; QA is pinning the
 * concrete shape ahead of implementation, same convention as the #338
 * `journey-bootstrap.service.spec.ts` RED spec):
 *
 *   - `JourneysAdminService(prisma: PrismaService)` exposes:
 *       - `list(): Promise<AdminJourneyView[]>` — ALL journeys (active AND
 *         inactive; retirement is `active:false`, never a physical delete).
 *       - `get(id: string): Promise<AdminJourneyView>` — 404 if missing or
 *         soft-deleted (`deletedAt` set — `Journey` IS soft-deletable).
 *       - `create(dto: CreateJourneyInput): Promise<AdminJourneyView>`.
 *       - `update(id: string, dto: UpdateJourneyInput): Promise<AdminJourneyView>`.
 *   - This is a GLOBAL admin panel (mirrors `/admin/onboarding/journeys`
 *     today — no `tenantId` on `Journey`/`JourneyTrigger`/`JourneyStep` in
 *     the #338 schema). `targetProjectId` existence is checked GLOBALLY
 *     here (does the project exist at all); tenant OWNERSHIP of a project is
 *     enforced only at runtime by the eligibility/completion services,
 *     which DO have a tenant in context.
 *   - `steps: []` (zero steps) is a VALID journey — issue #339 explicitly
 *     requires steps to work "com 0, 1, 4, 6 e muitas etapas". `triggers`
 *     must have at least one entry — a journey needs some way to fire.
 *   - Validation happens BEFORE any write — an invalid payload must never
 *     call `prisma.$transaction`/`.create` (half-written journeys are worse
 *     than a rejected request).
 *   - No row is ever physically deleted (`.delete()` is intentionally absent
 *     from the mock below — if the implementation calls it, the mock throws
 *     "is not a function" and the test fails loudly).
 */

type AnyFn = jest.Mock;

interface JourneyRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  active: boolean;
  deletedAt: Date | null;
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

interface ProjectRow {
  id: string;
  tenantId: string;
  type: string;
  deletedAt: Date | null;
}

interface PrismaMock {
  journey: { findMany: AnyFn; findFirst: AnyFn; create: AnyFn; update: AnyFn };
  journeyStep: {
    findMany: AnyFn;
    create: AnyFn;
    createMany: AnyFn;
    update: AnyFn;
  };
  journeyTrigger: {
    findMany: AnyFn;
    findFirst: AnyFn;
    create: AnyFn;
    createMany: AnyFn;
    update: AnyFn;
    // Deliberadamente SEM `upsert`: a chave natural de `JourneyTrigger` tem
    // 4 campos nullable (`targetProjectType`/`targetProjectId`/`screenKey`/
    // `actionKey`) e o `WhereUniqueInput` compound que o Prisma Client REAL
    // gera para essa tupla exige `string`, não `string | null` — passar
    // `null` ali só "funcionava" no mock antigo porque ele fazia igualdade
    // de JS, não refletia a rejeição real do Prisma. Se a implementação
    // regredir para `tx.journeyTrigger.upsert(...)`, este mock explode com
    // "is not a function" e o teste falha alto, do mesmo jeito que o
    // comentário sobre `.delete()` no topo do arquivo já garante para
    // deleção física.
  };
  project: { findFirst: AnyFn };
  $transaction: AnyFn;
  _journeys: JourneyRow[];
  _steps: JourneyStepRow[];
  _triggers: JourneyTriggerRow[];
}

let idSeq = 0;
const nextId = (prefix: string) => `${prefix}-${++idSeq}`;

function makePrismaMock(
  seed: {
    journeys?: JourneyRow[];
    steps?: JourneyStepRow[];
    triggers?: JourneyTriggerRow[];
    projects?: ProjectRow[];
  } = {},
): PrismaMock {
  const journeys = [...(seed.journeys ?? [])];
  const steps = [...(seed.steps ?? [])];
  const triggers = [...(seed.triggers ?? [])];
  const projects = [...(seed.projects ?? [])];

  const mock: PrismaMock = {
    journey: {
      findMany: jest.fn().mockImplementation(() => Promise.resolve([...journeys])),
      findFirst: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          Promise.resolve(
            journeys.find(
              (j) =>
                (where.id === undefined || j.id === where.id) &&
                (where.key === undefined || j.key === where.key) &&
                (where.deletedAt === undefined || j.deletedAt === where.deletedAt),
            ) ?? null,
          ),
        ),
      create: jest.fn().mockImplementation(({ data }: any) => {
        const row: JourneyRow = {
          id: nextId('journey'),
          deletedAt: null,
          active: true,
          description: null,
          ...data,
        };
        journeys.push(row);
        return Promise.resolve(row);
      }),
      update: jest.fn().mockImplementation(({ where, data }: any) => {
        const row = journeys.find((j) => j.id === where.id)!;
        Object.assign(row, data);
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
        const row: JourneyStepRow = { id: nextId('step'), ...data };
        steps.push(row);
        return Promise.resolve(row);
      }),
      createMany: jest.fn().mockImplementation(({ data }: any) => {
        const rows = data.map((d: any) => ({ id: nextId('step'), ...d }));
        steps.push(...rows);
        return Promise.resolve({ count: rows.length });
      }),
      update: jest.fn().mockImplementation(({ where, data }: any) => {
        const existing = steps.find(
          (s) =>
            s.journeyId === where.journeyId_stepKey.journeyId &&
            s.stepKey === where.journeyId_stepKey.stepKey,
        );
        if (!existing) return Promise.reject(new Error('journeyStep.update: registro não existe'));
        Object.assign(existing, data);
        return Promise.resolve(existing);
      }),
      // Deliberadamente SEM `upsert`, pela mesma razão de `journeyTrigger`
      // abaixo: o Prisma real VALIDA o payload `create` de um upsert mesmo
      // quando o registro já existe e o branch tomado é o `update`. Para um
      // passo já salvo, o patch é PARCIAL (sem `stepKey`), então o `create`
      // era rejeitado em runtime e todo `PUT` com etapas devolvia 500. O mock
      // antigo tinha `upsert` e fazia igualdade de JS, então nunca reproduziu
      // a rejeição. Se a implementação regredir para `tx.journeyStep.upsert`,
      // este mock explode com "is not a function" e o teste falha alto.
    },
    journeyTrigger: {
      findMany: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          Promise.resolve(triggers.filter((t) => t.journeyId === where.journeyId)),
        ),
      // Filtro por campos simples — inclusive `null` nos 4 opcionais — é
      // exatamente o que o Prisma Client real aceita para esses campos
      // (`StringNullableFilter | string | null`). Isso é o que substitui o
      // `upsert` de chave composta que não existe mais aqui.
      findFirst: jest.fn().mockImplementation(({ where }: any) =>
        Promise.resolve(
          triggers.find(
            (t) =>
              t.journeyId === where.journeyId &&
              t.triggerType === where.triggerType &&
              t.targetProjectType === where.targetProjectType &&
              t.targetProjectId === where.targetProjectId &&
              t.screenKey === where.screenKey &&
              t.actionKey === where.actionKey,
          ) ?? null,
        ),
      ),
      create: jest.fn().mockImplementation(({ data }: any) => {
        const row: JourneyTriggerRow = { id: nextId('trigger'), ...data };
        triggers.push(row);
        return Promise.resolve(row);
      }),
      createMany: jest.fn().mockImplementation(({ data }: any) => {
        const rows = data.map((d: any) => ({ id: nextId('trigger'), ...d }));
        triggers.push(...rows);
        return Promise.resolve({ count: rows.length });
      }),
      update: jest.fn().mockImplementation(({ where, data }: any) => {
        const row = triggers.find((t) => t.id === where.id)!;
        Object.assign(row, data);
        return Promise.resolve(row);
      }),
    },
    project: {
      findFirst: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          Promise.resolve(projects.find((p) => p.id === where.id && p.deletedAt === null) ?? null),
        ),
    },
    $transaction: jest
      .fn()
      .mockImplementation((arg: any) => (Array.isArray(arg) ? Promise.all(arg) : arg(mock))),
    _journeys: journeys,
    _steps: steps,
    _triggers: triggers,
  };
  return mock;
}

function minimalTrigger(over: Partial<JourneyTriggerRow> = {}) {
  return {
    triggerType: 'PROJECT_CREATED',
    targetProjectType: ProjectType.PESSOAL,
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

describe('JourneysAdminService', () => {
  let service: JourneysAdminService;
  let prisma: PrismaMock;

  async function build(seed?: Parameters<typeof makePrismaMock>[0]) {
    prisma = makePrismaMock(seed);
    const module: TestingModule = await Test.createTestingModule({
      providers: [JourneysAdminService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(JourneysAdminService);
  }

  beforeEach(() => {
    idSeq = 0;
  });

  describe('create — happy paths', () => {
    it('creates a journey with 1 step + 1 trigger and returns the full generated shape', async () => {
      await build();

      const result = await service.create({
        key: 'tour:new-feature',
        name: 'Tour de recurso novo',
        description: 'desc',
        steps: [
          { stepKey: 'intro', order: 0, label: 'Intro', subtitle: 'sub', experience: 'SUMMARY' },
        ],
        triggers: [minimalTrigger()],
      } as any);

      expect(result.key).toBe('tour:new-feature');
      expect(result.name).toBe('Tour de recurso novo');
      expect(result.active).toBe(true);
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]).toMatchObject({
        stepKey: 'intro',
        order: 0,
        label: 'Intro',
        subtitle: 'sub',
        enabled: true,
        skippable: true,
      });
      expect(result.triggers).toHaveLength(1);
      expect(result.triggers[0]).toMatchObject({
        triggerType: 'PROJECT_CREATED',
        targetProjectType: ProjectType.PESSOAL,
      });
      expect(typeof result.id).toBe('string');
      expect(result.id).not.toBe('');
    });

    it('allows a journey with ZERO steps (boundary — must not be rejected as empty)', async () => {
      await build();

      const result = await service.create({
        key: 'alert:no-steps',
        name: 'Só notifica, sem etapas',
        steps: [],
        triggers: [
          minimalTrigger({
            triggerType: 'SIGNUP_COMPLETED',
            targetProjectType: null,
          }),
        ],
      } as any);

      expect(result.steps).toEqual([]);
      expect(prisma._steps.filter((s) => s.journeyId === result.id)).toHaveLength(0);
    });

    it('defaults active to true when omitted', async () => {
      await build();
      const result = await service.create({
        key: 'tour:default-active',
        name: 'x',
        steps: [],
        triggers: [minimalTrigger()],
      } as any);
      expect(result.active).toBe(true);
    });
  });

  describe('create — rejects before writing anything', () => {
    it('rejects an empty/whitespace key and never calls journey.create', async () => {
      await build();
      await expect(
        service.create({
          key: '   ',
          name: 'x',
          steps: [],
          triggers: [minimalTrigger()],
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.journey.create).not.toHaveBeenCalled();
      expect(prisma._journeys).toHaveLength(0);
    });

    it('rejects a duplicate key with Conflict, not a generic BadRequest', async () => {
      await build({
        journeys: [
          {
            id: 'existing',
            key: 'onboarding:PESSOAL',
            name: 'x',
            description: null,
            active: true,
            deletedAt: null,
          },
        ],
      });
      await expect(
        service.create({
          key: 'onboarding:PESSOAL',
          name: 'dup',
          steps: [],
          triggers: [minimalTrigger()],
        } as any),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.journey.create).not.toHaveBeenCalled();
    });

    it('accepts a name of exactly 120 chars but rejects 121 (exact boundary)', async () => {
      await build();
      const name120 = 'n'.repeat(120);
      const name121 = 'n'.repeat(121);

      await expect(
        service.create({
          key: 'k1',
          name: name120,
          steps: [],
          triggers: [minimalTrigger()],
        } as any),
      ).resolves.toMatchObject({ name: name120 });

      await expect(
        service.create({
          key: 'k2',
          name: name121,
          steps: [],
          triggers: [minimalTrigger()],
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts a description of exactly 500 chars but rejects 501 (exact boundary)', async () => {
      await build();
      const desc500 = 'd'.repeat(500);
      const desc501 = 'd'.repeat(501);

      await expect(
        service.create({
          key: 'k1',
          name: 'x',
          description: desc500,
          steps: [],
          triggers: [minimalTrigger()],
        } as any),
      ).resolves.toMatchObject({ description: desc500 });

      await expect(
        service.create({
          key: 'k2',
          name: 'x',
          description: desc501,
          steps: [],
          triggers: [minimalTrigger()],
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects ZERO triggers (a journey must have at least one way to fire)', async () => {
      await build();
      await expect(
        service.create({ key: 'k', name: 'x', steps: [], triggers: [] } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.journey.create).not.toHaveBeenCalled();
    });

    it('rejects an unknown triggerType', async () => {
      await build();
      await expect(
        service.create({
          key: 'k',
          name: 'x',
          steps: [],
          triggers: [minimalTrigger({ triggerType: 'BOGUS' as any })],
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an unknown device', async () => {
      await build();
      await expect(
        service.create({
          key: 'k',
          name: 'x',
          steps: [],
          triggers: [minimalTrigger({ device: 'tablet' as any })],
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an unknown repeatPolicy', async () => {
      await build();
      await expect(
        service.create({
          key: 'k',
          name: 'x',
          steps: [],
          triggers: [minimalTrigger({ repeatPolicy: 'FOREVER' as any })],
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an unknown dismissPolicy', async () => {
      await build();
      await expect(
        service.create({
          key: 'k',
          name: 'x',
          steps: [],
          triggers: [minimalTrigger({ dismissPolicy: 'silent' as any })],
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects experience:FULL for a stepKey without a slug (feedback/maria-insight — no page to navigate to)', async () => {
      await build();
      await expect(
        service.create({
          key: 'k',
          name: 'x',
          steps: [{ stepKey: 'feedback', order: 0, label: 'Feedback', experience: 'FULL' }],
          triggers: [minimalTrigger()],
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects experience:FULL for maria-insight (no page to navigate to)', async () => {
      await build();
      await expect(
        service.create({
          key: 'k',
          name: 'x',
          steps: [{ stepKey: 'maria-insight', order: 0, label: 'Maria', experience: 'FULL' }],
          triggers: [minimalTrigger()],
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts experience:SUMMARY for feedback (steps without slugs can only be SUMMARY)', async () => {
      await build();
      const result = await service.create({
        key: 'k',
        name: 'x',
        steps: [{ stepKey: 'feedback', order: 0, label: 'Feedback', experience: 'SUMMARY' }],
        triggers: [minimalTrigger()],
      } as any);
      expect(result.steps[0].experience).toBe('SUMMARY');
      expect(result.steps[0].stepKey).toBe('feedback');
    });

    it('accepts experience:SUMMARY for maria-insight (steps without slugs can only be SUMMARY)', async () => {
      await build();
      const result = await service.create({
        key: 'k',
        name: 'x',
        steps: [{ stepKey: 'maria-insight', order: 0, label: 'Maria', experience: 'SUMMARY' }],
        triggers: [minimalTrigger()],
      } as any);
      expect(result.steps[0].experience).toBe('SUMMARY');
      expect(result.steps[0].stepKey).toBe('maria-insight');
    });

    it('accepts experience:FULL for a stepKey WITH a slug (expense → expenses)', async () => {
      await build();
      const result = await service.create({
        key: 'k',
        name: 'x',
        steps: [{ stepKey: 'expense', order: 0, label: 'Despesa', experience: 'FULL' }],
        triggers: [minimalTrigger()],
      } as any);
      expect(result.steps[0].experience).toBe('FULL');
    });

    it('accepts experience:FULL for funding (composite step mapped to Visão Conta → conta)', async () => {
      await build();
      const result = await service.create({
        key: 'k',
        name: 'x',
        steps: [{ stepKey: 'funding', order: 0, label: 'Contas & cartões', experience: 'FULL' }],
        triggers: [minimalTrigger()],
      } as any);
      expect(result.steps[0].experience).toBe('FULL');
    });

    // Etapa E, parte 2 (todo #338): stepKey do catálogo de resumos
    // INFORMATIVOS (`summary-catalog.ts`) nunca tem rota de "Etapa Completa"
    // — a mesma regra que já protege `feedback`/`maria-insight` acima também
    // precisa valer para as ~18 telas novas do resumo informativo, senão um
    // admin poderia configurar uma jornada que tenta navegar para um
    // dashboard/Gantt/canvas inteiro como "etapa guiada", violando a regra
    // do plano ("a etapa nunca reproduz dashboard, canvas, gráfico, Gantt ou
    // lista completa").
    it('rejects experience:FULL for um stepKey do catálogo de resumo informativo (dashboard — sem rota de Etapa Completa)', async () => {
      await build();
      await expect(
        service.create({
          key: 'k',
          name: 'x',
          steps: [{ stepKey: 'dashboard', order: 0, label: 'Dashboard', experience: 'FULL' }],
          triggers: [minimalTrigger()],
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('SCREEN_VISIT without screenKey is rejected', async () => {
      await build();
      await expect(
        service.create({
          key: 'k',
          name: 'x',
          steps: [],
          triggers: [minimalTrigger({ triggerType: 'SCREEN_VISIT', screenKey: null })],
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('SCREEN_VISIT with an actionKey set (mutually exclusive column) is rejected', async () => {
      await build();
      await expect(
        service.create({
          key: 'k',
          name: 'x',
          steps: [],
          triggers: [
            minimalTrigger({
              triggerType: 'SCREEN_VISIT',
              screenKey: 'monthly',
              actionKey: 'expense.new',
            }),
          ],
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('SCREEN_VISIT with targetProjectType null is rejected — screens are always type-specific', async () => {
      await build();
      await expect(
        service.create({
          key: 'k',
          name: 'x',
          steps: [],
          triggers: [
            minimalTrigger({
              triggerType: 'SCREEN_VISIT',
              screenKey: 'monthly',
              targetProjectType: null,
            }),
          ],
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('SCREEN_VISIT with a screenKey that does not belong to targetProjectType is rejected (incompatible target)', async () => {
      await build();
      // 'bills' only exists in CASA's nav, not PESSOAL's — cross-catalog mismatch.
      await expect(
        service.create({
          key: 'k',
          name: 'x',
          steps: [],
          triggers: [
            minimalTrigger({
              triggerType: 'SCREEN_VISIT',
              screenKey: 'bills',
              targetProjectType: ProjectType.PESSOAL,
            }),
          ],
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('SCREEN_VISIT with a screenKey that DOES belong to targetProjectType is accepted', async () => {
      await build();
      await expect(
        service.create({
          key: 'k',
          name: 'x',
          steps: [],
          triggers: [
            minimalTrigger({
              triggerType: 'SCREEN_VISIT',
              screenKey: 'bills',
              targetProjectType: ProjectType.CASA,
            }),
          ],
        } as any),
      ).resolves.toBeDefined();
    });

    it('ACTION without actionKey is rejected', async () => {
      await build();
      await expect(
        service.create({
          key: 'k',
          name: 'x',
          steps: [],
          triggers: [minimalTrigger({ triggerType: 'ACTION', actionKey: null })],
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('ACTION with an actionKey outside JOURNEY_SAFE_ACTIONS is rejected', async () => {
      await build();
      await expect(
        service.create({
          key: 'k',
          name: 'x',
          steps: [],
          triggers: [
            minimalTrigger({
              triggerType: 'ACTION',
              actionKey: 'delete-everything.now',
            }),
          ],
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('ACTION with a screenKey set (mutually exclusive column) is rejected', async () => {
      await build();
      await expect(
        service.create({
          key: 'k',
          name: 'x',
          steps: [],
          triggers: [
            minimalTrigger({
              triggerType: 'ACTION',
              actionKey: 'expense.new',
              screenKey: 'monthly',
            }),
          ],
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it.each(['SIGNUP_COMPLETED', 'PROJECT_CREATED'])(
      '%s with a screenKey set is rejected (not applicable to this triggerType)',
      async (triggerType) => {
        await build();
        await expect(
          service.create({
            key: 'k',
            name: 'x',
            steps: [],
            triggers: [
              minimalTrigger({
                triggerType: triggerType as any,
                screenKey: 'monthly',
              }),
            ],
          } as any),
        ).rejects.toBeInstanceOf(BadRequestException);
      },
    );

    it('crossProject:true with both targetProjectType AND targetProjectId null is rejected (no target to cross to)', async () => {
      await build();
      await expect(
        service.create({
          key: 'k',
          name: 'x',
          steps: [],
          triggers: [
            minimalTrigger({
              crossProject: true,
              targetProjectType: null,
              targetProjectId: null,
            }),
          ],
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('a targetProjectId that does not exist in the DB is rejected', async () => {
      await build({ projects: [] });
      await expect(
        service.create({
          key: 'k',
          name: 'x',
          steps: [],
          triggers: [minimalTrigger({ targetProjectId: 'ghost-project' })],
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('a targetProjectId whose actual type differs from the declared targetProjectType is rejected (incoherent target combo)', async () => {
      await build({
        projects: [
          {
            id: 'proj-1',
            tenantId: 'tenant-a',
            type: ProjectType.CASA,
            deletedAt: null,
          },
        ],
      });
      await expect(
        service.create({
          key: 'k',
          name: 'x',
          steps: [],
          triggers: [
            minimalTrigger({
              targetProjectId: 'proj-1',
              targetProjectType: ProjectType.PESSOAL,
            }),
          ],
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('a targetProjectId whose type matches the declared targetProjectType is accepted', async () => {
      await build({
        projects: [
          {
            id: 'proj-1',
            tenantId: 'tenant-a',
            type: ProjectType.CASA,
            deletedAt: null,
          },
        ],
      });
      await expect(
        service.create({
          key: 'k',
          name: 'x',
          steps: [],
          triggers: [
            minimalTrigger({
              targetProjectId: 'proj-1',
              targetProjectType: ProjectType.CASA,
            }),
          ],
        } as any),
      ).resolves.toBeDefined();
    });

    it('a soft-deleted targetProjectId (deletedAt set) is treated as non-existent', async () => {
      await build({
        projects: [
          {
            id: 'proj-1',
            tenantId: 'tenant-a',
            type: ProjectType.CASA,
            deletedAt: new Date('2026-01-01'),
          },
        ],
      });
      await expect(
        service.create({
          key: 'k',
          name: 'x',
          steps: [],
          triggers: [
            minimalTrigger({
              targetProjectId: 'proj-1',
              targetProjectType: ProjectType.CASA,
            }),
          ],
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a duplicate stepKey within the same payload', async () => {
      await build();
      await expect(
        service.create({
          key: 'k',
          name: 'x',
          steps: [
            { stepKey: 'dup', order: 0, label: 'a' },
            { stepKey: 'dup', order: 1, label: 'b' },
          ],
          triggers: [minimalTrigger()],
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.journey.create).not.toHaveBeenCalled();
    });

    it('rejects two triggers with the exact same natural key (matches the DB @@unique tuple)', async () => {
      await build();
      await expect(
        service.create({
          key: 'k',
          name: 'x',
          steps: [],
          triggers: [minimalTrigger(), minimalTrigger()],
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.journey.create).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('returns an empty array when there are no journeys (never throws on empty catalog)', async () => {
      await build();
      await expect(service.list()).resolves.toEqual([]);
    });

    it('returns BOTH active and inactive journeys, each with steps sorted by order and full trigger detail', async () => {
      await build({
        journeys: [
          {
            id: 'j1',
            key: 'a',
            name: 'A',
            description: null,
            active: true,
            deletedAt: null,
          },
          {
            id: 'j2',
            key: 'b',
            name: 'B',
            description: null,
            active: false,
            deletedAt: null,
          },
        ],
        steps: [
          {
            id: 's2',
            journeyId: 'j1',
            stepKey: 'second',
            order: 1,
            experience: 'FULL',
            label: 'Second',
            subtitle: null,
            enabled: true,
            skippable: true,
          },
          {
            id: 's1',
            journeyId: 'j1',
            stepKey: 'first',
            order: 0,
            experience: 'FULL',
            label: 'First',
            subtitle: null,
            enabled: true,
            skippable: true,
          },
        ],
        triggers: [
          minimalTrigger({ id: 't1', journeyId: 'j1' }) as any,
          minimalTrigger({ id: 't2', journeyId: 'j2' }) as any,
        ],
      });

      const result: any[] = await service.list();
      expect(result.map((j: any) => j.key).sort()).toEqual(['a', 'b']);
      const journeyA = result.find((j: any) => j.key === 'a')!;
      expect(journeyA.active).toBe(true);
      expect(journeyA.steps.map((s: any) => s.stepKey)).toEqual(['first', 'second']);
      const journeyB = result.find((j: any) => j.key === 'b')!;
      expect(journeyB.active).toBe(false);
    });
  });

  describe('get', () => {
    it('returns 404 for a missing id', async () => {
      await build();
      await expect(service.get('nope')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns 404 for a soft-deleted journey (deletedAt set)', async () => {
      await build({
        journeys: [
          {
            id: 'j1',
            key: 'a',
            name: 'A',
            description: null,
            active: true,
            deletedAt: new Date('2026-01-01'),
          },
        ],
      });
      await expect(service.get('j1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the full detail shape for an existing journey', async () => {
      await build({
        journeys: [
          {
            id: 'j1',
            key: 'a',
            name: 'A',
            description: 'd',
            active: true,
            deletedAt: null,
          },
        ],
        steps: [
          {
            id: 's1',
            journeyId: 'j1',
            stepKey: 'x',
            order: 0,
            experience: 'FULL',
            label: 'X',
            subtitle: null,
            enabled: true,
            skippable: true,
          },
        ],
        triggers: [minimalTrigger({ id: 't1', journeyId: 'j1' }) as any],
      });
      const result = await service.get('j1');
      expect(result).toMatchObject({
        id: 'j1',
        key: 'a',
        name: 'A',
        description: 'd',
        active: true,
      });
      expect(result.steps).toHaveLength(1);
      expect(result.triggers).toHaveLength(1);
    });
  });

  describe('update', () => {
    it('toggles active:false (retirement) without touching any step or trigger row', async () => {
      const step = {
        id: 's1',
        journeyId: 'j1',
        stepKey: 'x',
        order: 0,
        experience: 'FULL',
        label: 'X',
        subtitle: null,
        enabled: true,
        skippable: true,
      };
      const trigger = minimalTrigger({ id: 't1', journeyId: 'j1' }) as any;
      await build({
        journeys: [
          {
            id: 'j1',
            key: 'a',
            name: 'A',
            description: null,
            active: true,
            deletedAt: null,
          },
        ],
        steps: [step],
        triggers: [trigger],
      });

      const result = await service.update('j1', { active: false } as any);

      expect(result.active).toBe(false);
      expect(prisma._steps.find((s) => s.id === 's1')).toEqual(step);
      expect(prisma._triggers.find((t) => t.id === 't1')).toEqual(trigger);
    });

    it('disables a single step by stepKey (enabled:false) WITHOUT deleting the row', async () => {
      await build({
        journeys: [
          {
            id: 'j1',
            key: 'a',
            name: 'A',
            description: null,
            active: true,
            deletedAt: null,
          },
        ],
        steps: [
          {
            id: 's1',
            journeyId: 'j1',
            stepKey: 'x',
            order: 0,
            experience: 'FULL',
            label: 'X',
            subtitle: null,
            enabled: true,
            skippable: true,
          },
        ],
        triggers: [minimalTrigger({ id: 't1', journeyId: 'j1' }) as any],
      });

      const result = await service.update('j1', {
        steps: [{ stepKey: 'x', enabled: false }],
      } as any);

      const stepAfter = result.steps.find((s: any) => s.stepKey === 'x')!;
      expect(stepAfter.enabled).toBe(false);
      expect(prisma._steps).toHaveLength(1); // never physically removed
    });

    it('patches an EXISTING step via journeyStep.update — nunca pelo caminho de create', async () => {
      // Regressão: a implementação antiga usava `journeyStep.upsert`, cujo
      // payload `create` o Prisma real VALIDA mesmo tomando o branch de
      // update. Como o patch de um passo existente é parcial (sem `stepKey`),
      // todo `PUT` com etapas devolvia 500 em runtime. Este teste prende o
      // caminho: passo existente → `update`, e `create` nunca é chamado.
      await build({
        journeys: [
          { id: 'j1', key: 'a', name: 'A', description: null, active: true, deletedAt: null },
        ],
        steps: [
          {
            id: 's1',
            journeyId: 'j1',
            stepKey: 'x',
            order: 0,
            experience: 'FULL',
            label: 'X',
            subtitle: null,
            enabled: true,
            skippable: true,
          },
        ],
        triggers: [minimalTrigger({ id: 't1', journeyId: 'j1' }) as any],
      });

      const result = await service.update('j1', {
        steps: [{ stepKey: 'x', order: 3 }],
      } as any);

      expect(prisma.journeyStep.update).toHaveBeenCalledTimes(1);
      expect(prisma.journeyStep.update).toHaveBeenCalledWith({
        where: { journeyId_stepKey: { journeyId: 'j1', stepKey: 'x' } },
        data: { order: 3 },
      });
      expect(prisma.journeyStep.create).not.toHaveBeenCalled();

      // efeitos colaterais: só `order` muda, o resto da linha sobrevive
      const row = prisma._steps.find((s) => s.stepKey === 'x')!;
      expect(row.order).toBe(3);
      expect(row.label).toBe('X');
      expect(row.experience).toBe('FULL');
      expect(row.enabled).toBe(true);
      expect(row.skippable).toBe(true);
      expect(prisma._steps).toHaveLength(1);
      expect(result.steps.find((s: any) => s.stepKey === 'x')!.order).toBe(3);
    });

    it('adds a brand-new step via update (upsert-create path) leaving existing ones untouched', async () => {
      await build({
        journeys: [
          {
            id: 'j1',
            key: 'a',
            name: 'A',
            description: null,
            active: true,
            deletedAt: null,
          },
        ],
        steps: [
          {
            id: 's1',
            journeyId: 'j1',
            stepKey: 'x',
            order: 0,
            experience: 'FULL',
            label: 'X',
            subtitle: null,
            enabled: true,
            skippable: true,
          },
        ],
        triggers: [minimalTrigger({ id: 't1', journeyId: 'j1' }) as any],
      });

      const result = await service.update('j1', {
        steps: [{ stepKey: 'y', order: 1, label: 'Y', experience: 'SUMMARY' }],
      } as any);

      expect(result.steps.map((s: any) => s.stepKey).sort()).toEqual(['x', 'y']);
    });

    it('an update with no fields is a no-op that returns the current state unchanged', async () => {
      await build({
        journeys: [
          {
            id: 'j1',
            key: 'a',
            name: 'A',
            description: null,
            active: true,
            deletedAt: null,
          },
        ],
        steps: [],
        triggers: [minimalTrigger({ id: 't1', journeyId: 'j1' }) as any],
      });
      const before = await service.get('j1');
      const after = await service.update('j1', {} as any);
      expect(after).toEqual(before);
    });

    it('returns 404 for a missing id and never writes anything', async () => {
      await build();
      await expect(service.update('nope', { active: false } as any)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.journey.update).not.toHaveBeenCalled();
    });

    // Regressão: `JourneyTrigger.@@unique([journeyId, triggerType,
    // targetProjectType, targetProjectId, screenKey, actionKey])` tem 4
    // campos nullable. O Prisma Client REAL gera o `WhereUniqueInput`
    // compound dessa tupla exigindo `string` (não `string | null`) em cada
    // um deles — um `upsert` com esse `where` composto e algum campo `null`
    // rejeita em runtime (só "passava" no código antigo com um `as any` que
    // escondia o erro de tipo, não o de execução). O mock acima reflete
    // isso: não existe mais `journeyTrigger.upsert`, só `findFirst` +
    // `create`/`update` — se a implementação regredir para `upsert` com a
    // chave composta, `prisma.journeyTrigger.upsert` explode com "is not a
    // function" e este teste (e todos os outros que passam por
    // `triggerPatches`) falha alto.
    it('resolves an existing trigger whose natural key has null fields via findFirst+update (never upsert on the compound key)', async () => {
      const existingTrigger = minimalTrigger({
        id: 't1',
        journeyId: 'j1',
        triggerType: 'PROJECT_CREATED',
        targetProjectType: ProjectType.PESSOAL,
        targetProjectId: null,
        screenKey: null,
        actionKey: null,
        active: true,
      }) as any;
      await build({
        journeys: [
          {
            id: 'j1',
            key: 'a',
            name: 'A',
            description: null,
            active: true,
            deletedAt: null,
          },
        ],
        steps: [],
        triggers: [existingTrigger],
      });

      const result = await service.update('j1', {
        triggers: [
          {
            triggerType: 'PROJECT_CREATED',
            targetProjectType: ProjectType.PESSOAL,
            active: false,
          },
        ],
      } as any);

      // Encontrou a linha existente com filtros simples (inclusive `null`
      // explícito nos campos opcionais) — nunca um `where` de chave
      // composta.
      expect(prisma.journeyTrigger.findFirst).toHaveBeenCalledWith({
        where: {
          journeyId: 'j1',
          triggerType: 'PROJECT_CREATED',
          targetProjectType: ProjectType.PESSOAL,
          targetProjectId: null,
          screenKey: null,
          actionKey: null,
        },
      });
      // Atualizou a linha existente (por `id`) em vez de duplicar.
      expect(prisma.journeyTrigger.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 't1' } }),
      );
      expect(prisma.journeyTrigger.create).not.toHaveBeenCalled();
      expect(prisma._triggers).toHaveLength(1);
      expect(result.triggers).toHaveLength(1);
      expect(result.triggers[0]).toMatchObject({ id: 't1', active: false });
    });

    it('creates a brand-new trigger (does not match the existing natural key) via create, not upsert', async () => {
      const existingTrigger = minimalTrigger({
        id: 't1',
        journeyId: 'j1',
        triggerType: 'PROJECT_CREATED',
        targetProjectType: ProjectType.PESSOAL,
        targetProjectId: null,
        screenKey: null,
        actionKey: null,
      }) as any;
      await build({
        journeys: [
          {
            id: 'j1',
            key: 'a',
            name: 'A',
            description: null,
            active: true,
            deletedAt: null,
          },
        ],
        steps: [],
        triggers: [existingTrigger],
      });

      const result = await service.update('j1', {
        triggers: [
          {
            triggerType: 'PROJECT_CREATED',
            targetProjectType: ProjectType.PESSOAL,
          },
          {
            triggerType: 'ACTION',
            actionKey: 'expense.new',
          },
        ],
      } as any);

      expect(prisma.journeyTrigger.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            journeyId: 'j1',
            triggerType: 'ACTION',
            actionKey: 'expense.new',
          }),
        }),
      );
      expect(prisma._triggers).toHaveLength(2);
      expect(result.triggers.map((t: any) => t.triggerType).sort()).toEqual([
        'ACTION',
        'PROJECT_CREATED',
      ]);
    });

    it('re-applies the same SCREEN_VISIT/ACTION coherence validations as create', async () => {
      await build({
        journeys: [
          {
            id: 'j1',
            key: 'a',
            name: 'A',
            description: null,
            active: true,
            deletedAt: null,
          },
        ],
        steps: [],
        triggers: [minimalTrigger({ id: 't1', journeyId: 'j1' }) as any],
      });
      await expect(
        service.update('j1', {
          triggers: [
            {
              triggerType: 'SCREEN_VISIT',
              screenKey: 'bills',
              targetProjectType: ProjectType.PESSOAL,
            },
          ],
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
