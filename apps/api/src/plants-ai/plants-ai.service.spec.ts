import { PlantsAiService, type PlantDiagnosisResult } from './plants-ai.service';
import { buildPlantSchedule } from './plants-schedule';
import { PLANTS_AI_GENERATED_BY } from './plants-ai.constants';
import { NotFoundException } from '@nestjs/common';

const GENERATED_BY = PLANTS_AI_GENERATED_BY;
const TENANT_ID = 'tenant-1';
const PROJECT_ID = 'project-1';
const PLANT_ID = 'plant-1';
const OTHER_PLANT_ID = 'plant-2';
const FIXED_NOW = new Date('2026-07-11T12:00:00.000Z');

type ReminderRecord = {
  id: string;
  tenantId: string;
  projectId: string;
  plantId: string | null;
  titulo: string;
  descricao?: string | null;
  data: Date;
  recorrencia: string;
  status: string;
  prioridade: string;
  generatedBy: string | null;
  deletedAt: Date | null;
};

type MaintenanceRecord = {
  id: string;
  tenantId: string;
  projectId: string;
  plantId: string | null;
  tipo: string;
  dataRealizada: Date;
  dataProxima: Date | null;
  observacoes?: string | null;
  generatedBy: string | null;
  deletedAt: Date | null;
};

type PlantRecord = {
  id: string;
  tenantId: string;
  projectId: string;
  especiePopular?: string | null;
  especieCientifica?: string | null;
  ultimaSaude?: string | null;
  ultimoRiscoPet?: string | null;
  ultimoDiagnosticoEm?: Date | null;
};

type MockState = {
  nextId: number;
  reminders: ReminderRecord[];
  maintenanceLogs: MaintenanceRecord[];
  diagnosisLogs: Array<Record<string, unknown>>;
  plants: PlantRecord[];
};

function createDiagnosis(): PlantDiagnosisResult {
  return {
    especieProvavel: {
      nomePopular: 'Jiboia',
      nomeCientifico: 'Epipremnum aureum',
      confianca: 0.9,
    },
    saude: { status: 'ATENCAO', confianca: 0.8, sinais: ['manchas nas folhas'] },
    pet: { risco: 'CAUTELA', observacao: 'evitar ingestão' },
    cuidados: {
      rega: 'regar quando solo secar',
      luz: 'indireta',
      poda: 'leve',
      adubacao: 'mensal',
      solo: 'drenado',
    },
    problemasPossiveis: [
      {
        nome: 'fungo foliar',
        gravidade: 'MEDIA',
        probabilidade: 0.7,
        descricao: 'possível infecção inicial',
        planoAcao: ['remover folhas afetadas'],
      },
    ],
  };
}

function createFile(): Express.Multer.File {
  return {
    buffer: Buffer.from('fake-image'),
    mimetype: 'image/jpeg',
    originalname: 'leaf.jpg',
  } as Express.Multer.File;
}

function createState(): MockState {
  return {
    nextId: 1,
    reminders: [],
    maintenanceLogs: [],
    diagnosisLogs: [],
    plants: [
      { id: PLANT_ID, tenantId: TENANT_ID, projectId: PROJECT_ID },
      { id: OTHER_PLANT_ID, tenantId: TENANT_ID, projectId: PROJECT_ID },
    ],
  };
}

function matchesWhere(record: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => record[key] === value);
}

function makePrismaMock(state: MockState) {
  const mock: any = {
    plant: {
      findFirst: jest.fn(async ({ where }) => state.plants.find((plant) => matchesWhere(plant, where)) ?? null),
      update: jest.fn(async ({ where, data }) => {
        const plant = state.plants.find((entry) => entry.id === where.id);
        if (!plant) return null;
        Object.assign(plant, data);
        return plant;
      }),
    },
    reminder: {
      updateMany: jest.fn(async ({ where, data }) => {
        let count = 0;
        for (const reminder of state.reminders) {
          if (!matchesWhere(reminder, where)) continue;
          Object.assign(reminder, data);
          count += 1;
        }
        return { count };
      }),
      createMany: jest.fn(async ({ data }) => {
        const rows = Array.isArray(data) ? data : [data];
        for (const row of rows) {
          state.reminders.push({
            id: 'rem-' + state.nextId++,
            deletedAt: null,
            ...row,
          });
        }
        return { count: rows.length };
      }),
      findMany: jest.fn(async ({ where, orderBy }: any) => {
        let results = state.reminders.filter((rem: any) => matchesWhere(rem, where));
        if (orderBy) {
          const orderKey = Object.keys(orderBy)[0];
          const orderDir = orderBy[orderKey];
          results.sort((a: any, b: any) => {
            const aVal = a[orderKey];
            const bVal = b[orderKey];
            if (aVal < bVal) return orderDir === 'asc' ? -1 : 1;
            if (aVal > bVal) return orderDir === 'asc' ? 1 : -1;
            return 0;
          });
        }
        return results;
      }),
    },
    maintenanceLog: {
      updateMany: jest.fn(async ({ where, data }) => {
        let count = 0;
        for (const log of state.maintenanceLogs) {
          if (!matchesWhere(log, where)) continue;
          Object.assign(log, data);
          count += 1;
        }
        return { count };
      }),
      createMany: jest.fn(async ({ data }) => {
        const rows = Array.isArray(data) ? data : [data];
        for (const row of rows) {
          state.maintenanceLogs.push({
            id: 'man-' + state.nextId++,
            deletedAt: null,
            ...row,
          });
        }
        return { count: rows.length };
      }),
      findMany: jest.fn(async ({ where, orderBy }: any) => {
        let results = state.maintenanceLogs.filter((log: any) => matchesWhere(log, where));
        if (orderBy) {
          const orderKey = Object.keys(orderBy)[0];
          const orderDir = orderBy[orderKey];
          results.sort((a: any, b: any) => {
            const aVal = a[orderKey];
            const bVal = b[orderKey];
            if (aVal < bVal) return orderDir === 'asc' ? -1 : 1;
            if (aVal > bVal) return orderDir === 'asc' ? 1 : -1;
            return 0;
          });
        }
        return results;
      }),
    },
    plantDiagnosisLog: {
      create: jest.fn(async ({ data }) => {
        const record = { id: 'log-' + state.nextId++, ...data };
        state.diagnosisLogs.push(record);
        return record;
      }),
      findMany: jest.fn(async ({ where, orderBy }: any) => {
        let results = state.diagnosisLogs.filter((log: any) => matchesWhere(log, where));
        if (orderBy) {
          const orderKey = Object.keys(orderBy)[0];
          const orderDir = orderBy[orderKey];
          results.sort((a: any, b: any) => {
            const aVal = a[orderKey];
            const bVal = b[orderKey];
            if (aVal < bVal) return orderDir === 'asc' ? -1 : 1;
            if (aVal > bVal) return orderDir === 'asc' ? 1 : -1;
            return 0;
          });
        }
        return results;
      }),
    },
    __txUnsupported: Promise.resolve([]),
  };

  mock['$' + 'transaction'] = jest.fn(async (arg: unknown) => {
    if (typeof arg === 'function') {
      return arg(mock);
    }
    return Promise.all(arg as Array<Promise<unknown>>);
  });

  return mock;
}

function activeGeneratedReminders(state: MockState, plantId: string): ReminderRecord[] {
  return state.reminders.filter(
    (reminder) =>
      reminder.tenantId === TENANT_ID
      && reminder.projectId === PROJECT_ID
      && reminder.plantId === plantId
      && reminder.generatedBy === GENERATED_BY
      && reminder.deletedAt === null,
  );
}

function activeGeneratedMaintenance(state: MockState, plantId: string): MaintenanceRecord[] {
  return state.maintenanceLogs.filter(
    (log) =>
      log.tenantId === TENANT_ID
      && log.projectId === PROJECT_ID
      && log.plantId === plantId
      && log.generatedBy === GENERATED_BY
      && log.deletedAt === null,
  );
}

describe('PlantsAiService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
    jest.restoreAllMocks();
  });

  it('normalizes the returned common name from JBRJ after Gemini responds', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    especieProvavel: {
                      nomePopular: 'nome genérico',
                      nomeCientifico: 'Abarema cochliacarpos',
                      confianca: 0.91,
                    },
                    especiesAlternativas: [],
                    saude: { status: 'SAUDAVEL', confianca: 0.8, sinais: [] },
                    pet: { risco: 'DESCONHECIDO', observacao: '' },
                    cuidados: { rega: '', luz: '', poda: '', adubacao: '', solo: '' },
                    problemasPossiveis: [],
                  }),
                },
              ],
            },
          },
        ],
      }),
    }) as typeof fetch;

    const service = new PlantsAiService(
      {
        project: {
          findFirst: jest.fn().mockResolvedValue({ id: 'project-1', type: 'PLANTAS' }),
        },
      } as never,
      {} as never,
    );

    const diagnosis = await service.diagnose('tenant-1', 'project-1', createFile());

    expect(diagnosis.especieProvavel.nomePopular).toBe('bordão-de-velho');
  });

  describe('diagnoseAndSchedule persistence', () => {
    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(FIXED_NOW);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('replaces the previous AI generation for the same plant without duplicating active records', async () => {
      const state = createState();
      const prisma = makePrismaMock(state);
      const plantService = { setPhoto: jest.fn().mockResolvedValue(undefined) };
      const service = new PlantsAiService(prisma, plantService as never);
      const diagnosis = createDiagnosis();
      const expectedPlan = buildPlantSchedule(diagnosis, PLANT_ID, FIXED_NOW);

      jest.spyOn(service, 'diagnose').mockResolvedValue(diagnosis);

      const firstRun = await service.diagnoseAndSchedule(TENANT_ID, PROJECT_ID, createFile(), true, PLANT_ID);
      const secondRun = await service.diagnoseAndSchedule(TENANT_ID, PROJECT_ID, createFile(), true, PLANT_ID);

      expect(typeof prisma['$' + 'transaction'].mock.calls[0]?.[0]).toBe('function');
      expect(prisma.reminder.updateMany).toHaveBeenCalledWith({
        where: {
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          plantId: PLANT_ID,
          generatedBy: GENERATED_BY,
          deletedAt: null,
        },
        data: { deletedAt: expect.any(Date) },
      });
      expect(prisma.maintenanceLog.updateMany).toHaveBeenCalledWith({
        where: {
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          plantId: PLANT_ID,
          generatedBy: GENERATED_BY,
          deletedAt: null,
        },
        data: { deletedAt: expect.any(Date) },
      });
      expect(activeGeneratedReminders(state, PLANT_ID)).toHaveLength(expectedPlan.reminders.length);
      expect(activeGeneratedMaintenance(state, PLANT_ID)).toHaveLength(expectedPlan.maintenance.length);
      expect(
        state.reminders.filter(
          (reminder) => reminder.plantId === PLANT_ID && reminder.generatedBy === GENERATED_BY && reminder.deletedAt instanceof Date,
        ),
      ).toHaveLength(expectedPlan.reminders.length);
      expect(
        state.maintenanceLogs.filter(
          (log) => log.plantId === PLANT_ID && log.generatedBy === GENERATED_BY && log.deletedAt instanceof Date,
        ),
      ).toHaveLength(expectedPlan.maintenance.length);
      expect(firstRun.schedule.persisted).toEqual({
        reminders: expectedPlan.reminders.length,
        maintenance: expectedPlan.maintenance.length,
        diagnosisLog: true,
      });
      expect(secondRun.schedule.persisted).toEqual({
        reminders: expectedPlan.reminders.length,
        maintenance: expectedPlan.maintenance.length,
        diagnosisLog: true,
      });
      expect(state.diagnosisLogs).toHaveLength(2);
      expect(plantService.setPhoto).toHaveBeenCalledTimes(2);
    });

    it('keeps manual same-plant records untouched when regenerating the AI schedule', async () => {
      const state = createState();
      state.reminders.push({
        id: 'manual-rem-1',
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        plantId: PLANT_ID,
        titulo: 'Lembrete manual',
        descricao: 'feito pelo usuário',
        data: FIXED_NOW,
        recorrencia: 'UNICA',
        status: 'PENDENTE',
        prioridade: 'MEDIA',
        generatedBy: null,
        deletedAt: null,
      });
      state.maintenanceLogs.push({
        id: 'manual-man-1',
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        plantId: PLANT_ID,
        tipo: 'PODA_MANUAL',
        dataRealizada: FIXED_NOW,
        dataProxima: null,
        observacoes: 'feito pelo usuário',
        generatedBy: null,
        deletedAt: null,
      });
      const prisma = makePrismaMock(state);
      const service = new PlantsAiService(prisma, { setPhoto: jest.fn().mockResolvedValue(undefined) } as never);

      jest.spyOn(service, 'diagnose').mockResolvedValue(createDiagnosis());

      await service.diagnoseAndSchedule(TENANT_ID, PROJECT_ID, createFile(), true, PLANT_ID);

      expect(state.reminders.find((reminder) => reminder.id === 'manual-rem-1')?.deletedAt).toBeNull();
      expect(state.maintenanceLogs.find((log) => log.id === 'manual-man-1')?.deletedAt).toBeNull();
      expect(state.reminders.find((reminder) => reminder.id === 'manual-rem-1')?.generatedBy).toBeNull();
      expect(state.maintenanceLogs.find((log) => log.id === 'manual-man-1')?.generatedBy).toBeNull();
    });

    it('keeps AI records from other plants untouched when regenerating one plant schedule', async () => {
      const state = createState();
      state.reminders.push({
        id: 'other-plant-rem-1',
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        plantId: OTHER_PLANT_ID,
        titulo: 'Outro lembrete IA',
        descricao: 'outra planta',
        data: FIXED_NOW,
        recorrencia: 'UNICA',
        status: 'PENDENTE',
        prioridade: 'MEDIA',
        generatedBy: GENERATED_BY,
        deletedAt: null,
      });
      state.maintenanceLogs.push({
        id: 'other-plant-man-1',
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        plantId: OTHER_PLANT_ID,
        tipo: 'TRATAMENTO_OUTRA_PLANTA',
        dataRealizada: FIXED_NOW,
        dataProxima: null,
        observacoes: 'outra planta',
        generatedBy: GENERATED_BY,
        deletedAt: null,
      });
      const prisma = makePrismaMock(state);
      const service = new PlantsAiService(prisma, { setPhoto: jest.fn().mockResolvedValue(undefined) } as never);

      jest.spyOn(service, 'diagnose').mockResolvedValue(createDiagnosis());

      await service.diagnoseAndSchedule(TENANT_ID, PROJECT_ID, createFile(), true, PLANT_ID);

      expect(activeGeneratedReminders(state, OTHER_PLANT_ID)).toHaveLength(1);
      expect(activeGeneratedMaintenance(state, OTHER_PLANT_ID)).toHaveLength(1);
      expect(state.reminders.find((reminder) => reminder.id === 'other-plant-rem-1')?.deletedAt).toBeNull();
      expect(state.maintenanceLogs.find((log) => log.id === 'other-plant-man-1')?.deletedAt).toBeNull();
    });

    it('auto-creates the plant when no plantId is given, so reminders are never orphaned', async () => {
      const state = createState();
      const prisma = makePrismaMock(state);
      const createdPlant = { id: 'auto-created-1', tenantId: TENANT_ID, projectId: PROJECT_ID };
      const plantService = {
        setPhoto: jest.fn().mockResolvedValue(undefined),
        create: jest.fn(async (_tenantId: string, _projectId: string, dto: { nome: string }) => {
          const plant = { ...createdPlant, nome: dto.nome };
          state.plants.push(plant);
          return plant;
        }),
      };
      const service = new PlantsAiService(prisma, plantService as never);
      const diagnosis = createDiagnosis();
      jest.spyOn(service, 'diagnose').mockResolvedValue(diagnosis);

      const result = await service.diagnoseAndSchedule(TENANT_ID, PROJECT_ID, createFile(), true, undefined);

      expect(plantService.create).toHaveBeenCalledWith(TENANT_ID, PROJECT_ID, { nome: diagnosis.especieProvavel.nomePopular });
      expect(result.plantId).toBe(createdPlant.id);
      expect(activeGeneratedReminders(state, createdPlant.id).length).toBeGreaterThan(0);
      expect(state.reminders.some((reminder) => reminder.plantId === null)).toBe(false);
    });

    it('uses the user-given name over the AI-detected one when auto-creating the plant', async () => {
      const state = createState();
      const prisma = makePrismaMock(state);
      const plantService = {
        setPhoto: jest.fn().mockResolvedValue(undefined),
        create: jest.fn(async (_tenantId: string, _projectId: string, dto: { nome: string }) => {
          const plant = { id: 'auto-created-2', tenantId: TENANT_ID, projectId: PROJECT_ID, nome: dto.nome };
          state.plants.push(plant);
          return plant;
        }),
      };
      const service = new PlantsAiService(prisma, plantService as never);
      jest.spyOn(service, 'diagnose').mockResolvedValue(createDiagnosis());

      await service.diagnoseAndSchedule(TENANT_ID, PROJECT_ID, createFile(), true, undefined, 'Jiboia da sala');

      expect(plantService.create).toHaveBeenCalledWith(TENANT_ID, PROJECT_ID, { nome: 'Jiboia da sala' });
    });
  });

  describe('PlantsAiService.getPlantInsights', () => {
    // Test 1: Happy path — plant with diagnosis, reminders, maintenance
    it('should return complete insights for plant with all data', async () => {
      const state = createState();
      const diagnosis = createDiagnosis();
      state.diagnosisLogs.push({
        id: 'diag-1',
        plantId: PLANT_ID,
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        especiePopular: diagnosis.especieProvavel.nomePopular,
        especieCientifica: diagnosis.especieProvavel.nomeCientifico,
        confiancaEspecie: diagnosis.especieProvavel.confianca,
        saudeStatus: diagnosis.saude.status,
        saudeConfianca: diagnosis.saude.confianca,
        riscoPet: diagnosis.pet.risco,
        diagnosisJson: JSON.stringify(diagnosis),
        createdAt: FIXED_NOW,
      });
      state.reminders.push({
        id: 'rem-1',
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        plantId: PLANT_ID,
        titulo: 'Regar',
        descricao: 'Regar a planta',
        data: new Date('2026-07-12'),
        recorrencia: 'DIARIA',
        status: 'PENDENTE',
        prioridade: 'MEDIA',
        generatedBy: null,
        deletedAt: null,
      });
      state.maintenanceLogs.push({
        id: 'man-1',
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        plantId: PLANT_ID,
        tipo: 'REGA',
        dataRealizada: new Date('2026-07-10'),
        dataProxima: null,
        observacoes: 'Mantém folhas hidratadas',
        generatedBy: null,
        deletedAt: null,
      });

      const prisma = makePrismaMock(state);
      const service = new PlantsAiService(prisma, { setPhoto: jest.fn() } as never);

      const result = await service.getPlantInsights(TENANT_ID, PROJECT_ID, PLANT_ID);

      expect(result).toBeDefined();
      expect(result.diagnosis).toBeDefined();
      expect(result.diagnosis?.especieProvavel.nomePopular).toBe('Jiboia');
      expect(result.cuidadoAgendado.reminders).toHaveLength(1);
      expect(result.cuidadoAgendado.maintenance).toHaveLength(1);
      expect(result.lastDiagnosisDate).toEqual(FIXED_NOW);
    });

    // Test 2: Plant exists but has no diagnosis
    it('should return null diagnosis when no PlantDiagnosisLog exists', async () => {
      const state = createState();
      const prisma = makePrismaMock(state);
      const service = new PlantsAiService(prisma, { setPhoto: jest.fn() } as never);

      const result = await service.getPlantInsights(TENANT_ID, PROJECT_ID, PLANT_ID);

      expect(result).toBeDefined();
      expect(result.diagnosis).toBeNull();
      expect(result.cuidadoAgendado.reminders).toHaveLength(0);
      expect(result.cuidadoAgendado.maintenance).toHaveLength(0);
      expect(result.lastDiagnosisDate).toBeUndefined();
    });

    // Test 3: Multiple diagnoses — returns latest (by createdAt DESC)
    it('should return the most recent diagnosis when multiple logs exist', async () => {
      const state = createState();
      const diagnosis1 = createDiagnosis();
      const diagnosis2 = { ...diagnosis1, saude: { ...diagnosis1.saude, status: 'CRITICA' as const } };

      state.diagnosisLogs.push(
        {
          id: 'diag-1',
          plantId: PLANT_ID,
          projectId: PROJECT_ID,
          tenantId: TENANT_ID,
          especiePopular: diagnosis1.especieProvavel.nomePopular,
          especieCientifica: diagnosis1.especieProvavel.nomeCientifico,
          confiancaEspecie: diagnosis1.especieProvavel.confianca,
          saudeStatus: diagnosis1.saude.status,
          saudeConfianca: diagnosis1.saude.confianca,
          riscoPet: diagnosis1.pet.risco,
          diagnosisJson: JSON.stringify(diagnosis1),
          createdAt: new Date('2026-07-10'),
        },
        {
          id: 'diag-2',
          plantId: PLANT_ID,
          projectId: PROJECT_ID,
          tenantId: TENANT_ID,
          especiePopular: diagnosis2.especieProvavel.nomePopular,
          especieCientifica: diagnosis2.especieProvavel.nomeCientifico,
          confiancaEspecie: diagnosis2.especieProvavel.confianca,
          saudeStatus: diagnosis2.saude.status,
          saudeConfianca: diagnosis2.saude.confianca,
          riscoPet: diagnosis2.pet.risco,
          diagnosisJson: JSON.stringify(diagnosis2),
          createdAt: new Date('2026-07-11'),
        },
      );

      const prisma = makePrismaMock(state);
      const service = new PlantsAiService(prisma, { setPhoto: jest.fn() } as never);

      const result = await service.getPlantInsights(TENANT_ID, PROJECT_ID, PLANT_ID);

      expect(result.diagnosis?.saude.status).toBe('CRITICA');
      expect(result.lastDiagnosisDate).toEqual(new Date('2026-07-11'));
    });

    // Test 4: Soft-deleted records excluded
    it('should exclude soft-deleted reminders and maintenance tasks', async () => {
      const state = createState();
      state.reminders.push(
        {
          id: 'rem-1',
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          plantId: PLANT_ID,
          titulo: 'Regar',
          descricao: null,
          data: new Date('2026-07-12'),
          recorrencia: 'DIARIA',
          status: 'PENDENTE',
          prioridade: 'MEDIA',
          generatedBy: null,
          deletedAt: null,
        },
        {
          id: 'rem-2',
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          plantId: PLANT_ID,
          titulo: 'Remover',
          descricao: null,
          data: new Date('2026-07-13'),
          recorrencia: 'UNICA',
          status: 'PENDENTE',
          prioridade: 'MEDIA',
          generatedBy: null,
          deletedAt: new Date('2026-07-01'),
        },
      );
      state.maintenanceLogs.push(
        {
          id: 'man-1',
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          plantId: PLANT_ID,
          tipo: 'REGA',
          dataRealizada: new Date('2026-07-10'),
          dataProxima: null,
          observacoes: null,
          generatedBy: null,
          deletedAt: null,
        },
        {
          id: 'man-2',
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          plantId: PLANT_ID,
          tipo: 'PODA',
          dataRealizada: new Date('2026-07-09'),
          dataProxima: null,
          observacoes: null,
          generatedBy: null,
          deletedAt: new Date('2026-07-01'),
        },
      );

      const prisma = makePrismaMock(state);
      const service = new PlantsAiService(prisma, { setPhoto: jest.fn() } as never);

      const result = await service.getPlantInsights(TENANT_ID, PROJECT_ID, PLANT_ID);

      expect(result.cuidadoAgendado.reminders).toHaveLength(1);
      expect(result.cuidadoAgendado.maintenance).toHaveLength(1);
    });

    // Test 5: Tenancy boundary — reject if plant belongs to wrong tenant
    it('should throw NotFoundException if plant tenant_id != currentTenant', async () => {
      const state = createState();
      state.plants[0].tenantId = 'other-tenant';

      const prisma = makePrismaMock(state);
      const service = new PlantsAiService(prisma, { setPhoto: jest.fn() } as never);

      await expect(service.getPlantInsights(TENANT_ID, PROJECT_ID, PLANT_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    // Test 6: Malformed diagnosis JSON — graceful degradation
    it('should set diagnosis to null when diagnosisJson is invalid JSON', async () => {
      const state = createState();
      state.diagnosisLogs.push({
        id: 'diag-1',
        plantId: PLANT_ID,
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        especiePopular: 'Jiboia',
        especieCientifica: 'Epipremnum aureum',
        confiancaEspecie: 0.9,
        saudeStatus: 'ATENCAO',
        saudeConfianca: 0.8,
        riscoPet: 'CAUTELA',
        diagnosisJson: '{broken json',
        createdAt: FIXED_NOW,
      });

      const prisma = makePrismaMock(state);
      const service = new PlantsAiService(prisma, { setPhoto: jest.fn() } as never);

      const result = await service.getPlantInsights(TENANT_ID, PROJECT_ID, PLANT_ID);

      expect(result.diagnosis).toBeNull();
    });

    // Test 7: Invariant — if diagnosis exists, cuidados must be non-null
    it('should always include cuidados object if diagnosis is parsed', async () => {
      const state = createState();
      const diagnosis = createDiagnosis();
      state.diagnosisLogs.push({
        id: 'diag-1',
        plantId: PLANT_ID,
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        especiePopular: diagnosis.especieProvavel.nomePopular,
        especieCientifica: diagnosis.especieProvavel.nomeCientifico,
        confiancaEspecie: diagnosis.especieProvavel.confianca,
        saudeStatus: diagnosis.saude.status,
        saudeConfianca: diagnosis.saude.confianca,
        riscoPet: diagnosis.pet.risco,
        diagnosisJson: JSON.stringify(diagnosis),
        createdAt: FIXED_NOW,
      });

      const prisma = makePrismaMock(state);
      const service = new PlantsAiService(prisma, { setPhoto: jest.fn() } as never);

      const result = await service.getPlantInsights(TENANT_ID, PROJECT_ID, PLANT_ID);

      expect(result.diagnosis).toBeDefined();
      expect(result.diagnosis?.cuidados).toBeDefined();
      expect(result.diagnosis?.cuidados.rega).toBeDefined();
      expect(result.diagnosis?.cuidados.luz).toBeDefined();
      expect(result.diagnosis?.cuidados.poda).toBeDefined();
      expect(result.diagnosis?.cuidados.adubacao).toBeDefined();
      expect(result.diagnosis?.cuidados.solo).toBeDefined();
    });

    // Test 8: Enum validation — all status/type enums valid
    it('should validate enum fields (saude.status, pet.risco, reminder.status, etc)', async () => {
      const state = createState();
      const diagnosis = createDiagnosis();
      state.diagnosisLogs.push({
        id: 'diag-1',
        plantId: PLANT_ID,
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        especiePopular: diagnosis.especieProvavel.nomePopular,
        especieCientifica: diagnosis.especieProvavel.nomeCientifico,
        confiancaEspecie: diagnosis.especieProvavel.confianca,
        saudeStatus: diagnosis.saude.status,
        saudeConfianca: diagnosis.saude.confianca,
        riscoPet: diagnosis.pet.risco,
        diagnosisJson: JSON.stringify(diagnosis),
        createdAt: FIXED_NOW,
      });
      state.reminders.push({
        id: 'rem-1',
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        plantId: PLANT_ID,
        titulo: 'Regar',
        descricao: null,
        data: new Date('2026-07-12'),
        recorrencia: 'DIARIA',
        status: 'PENDENTE',
        prioridade: 'ALTA',
        generatedBy: null,
        deletedAt: null,
      });

      const prisma = makePrismaMock(state);
      const service = new PlantsAiService(prisma, { setPhoto: jest.fn() } as never);

      const result = await service.getPlantInsights(TENANT_ID, PROJECT_ID, PLANT_ID);

      expect(['SAUDAVEL', 'ATENCAO', 'CRITICA']).toContain(result.diagnosis?.saude.status);
      expect(['SEGURO', 'CAUTELA', 'TOXICA', 'DESCONHECIDO']).toContain(result.diagnosis?.pet.risco);
      expect(result.cuidadoAgendado.reminders[0].status).toBe('PENDENTE');
      expect(['BAIXA', 'MEDIA', 'ALTA', 'URGENTE']).toContain(result.cuidadoAgendado.reminders[0].prioridade);
    });

    // Test 9: Reminder sort order — ascending by data
    it('should return reminders sorted by data (earliest first)', async () => {
      const state = createState();
      state.reminders.push(
        {
          id: 'rem-1',
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          plantId: PLANT_ID,
          titulo: 'Regar 1',
          descricao: null,
          data: new Date('2026-07-15'),
          recorrencia: 'DIARIA',
          status: 'PENDENTE',
          prioridade: 'MEDIA',
          generatedBy: null,
          deletedAt: null,
        },
        {
          id: 'rem-2',
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          plantId: PLANT_ID,
          titulo: 'Regar 2',
          descricao: null,
          data: new Date('2026-07-12'),
          recorrencia: 'DIARIA',
          status: 'PENDENTE',
          prioridade: 'MEDIA',
          generatedBy: null,
          deletedAt: null,
        },
        {
          id: 'rem-3',
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          plantId: PLANT_ID,
          titulo: 'Regar 3',
          descricao: null,
          data: new Date('2026-07-20'),
          recorrencia: 'DIARIA',
          status: 'PENDENTE',
          prioridade: 'MEDIA',
          generatedBy: null,
          deletedAt: null,
        },
      );

      const prisma = makePrismaMock(state);
      const service = new PlantsAiService(prisma, { setPhoto: jest.fn() } as never);

      const result = await service.getPlantInsights(TENANT_ID, PROJECT_ID, PLANT_ID);

      expect(result.cuidadoAgendado.reminders).toHaveLength(3);
      expect(result.cuidadoAgendado.reminders[0].titulo).toBe('Regar 2');
      expect(result.cuidadoAgendado.reminders[1].titulo).toBe('Regar 1');
      expect(result.cuidadoAgendado.reminders[2].titulo).toBe('Regar 3');
    });

    // Test 10: Maintenance sort order — descending by dataRealizada
    it('should return maintenance sorted by dataRealizada (newest first)', async () => {
      const state = createState();
      state.maintenanceLogs.push(
        {
          id: 'man-1',
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          plantId: PLANT_ID,
          tipo: 'REGA',
          dataRealizada: new Date('2026-07-01'),
          dataProxima: null,
          observacoes: null,
          generatedBy: null,
          deletedAt: null,
        },
        {
          id: 'man-2',
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          plantId: PLANT_ID,
          tipo: 'PODA',
          dataRealizada: new Date('2026-07-10'),
          dataProxima: null,
          observacoes: null,
          generatedBy: null,
          deletedAt: null,
        },
        {
          id: 'man-3',
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          plantId: PLANT_ID,
          tipo: 'ADUBACAO',
          dataRealizada: new Date('2026-07-05'),
          dataProxima: null,
          observacoes: null,
          generatedBy: null,
          deletedAt: null,
        },
      );

      const prisma = makePrismaMock(state);
      const service = new PlantsAiService(prisma, { setPhoto: jest.fn() } as never);

      const result = await service.getPlantInsights(TENANT_ID, PROJECT_ID, PLANT_ID);

      expect(result.cuidadoAgendado.maintenance).toHaveLength(3);
      expect(result.cuidadoAgendado.maintenance[0].tipo).toBe('PODA');
      expect(result.cuidadoAgendado.maintenance[1].tipo).toBe('ADUBACAO');
      expect(result.cuidadoAgendado.maintenance[2].tipo).toBe('REGA');
    });

    // Test 11: Confidence bounds — must be 0 ≤ x ≤ 1
    it('should ensure confidence fields are valid numbers between 0 and 1', async () => {
      const state = createState();
      const diagnosis = {
        ...createDiagnosis(),
        especieProvavel: {
          ...createDiagnosis().especieProvavel,
          confianca: 0.95,
        },
        saude: {
          ...createDiagnosis().saude,
          confianca: 0.85,
        },
      };
      state.diagnosisLogs.push({
        id: 'diag-1',
        plantId: PLANT_ID,
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        especiePopular: diagnosis.especieProvavel.nomePopular,
        especieCientifica: diagnosis.especieProvavel.nomeCientifico,
        confiancaEspecie: diagnosis.especieProvavel.confianca,
        saudeStatus: diagnosis.saude.status,
        saudeConfianca: diagnosis.saude.confianca,
        riscoPet: diagnosis.pet.risco,
        diagnosisJson: JSON.stringify(diagnosis),
        createdAt: FIXED_NOW,
      });

      const prisma = makePrismaMock(state);
      const service = new PlantsAiService(prisma, { setPhoto: jest.fn() } as never);

      const result = await service.getPlantInsights(TENANT_ID, PROJECT_ID, PLANT_ID);

      const spec = result.diagnosis?.especieProvavel;
      const saude = result.diagnosis?.saude;
      expect(spec?.confianca).toBeGreaterThanOrEqual(0);
      expect(spec?.confianca).toBeLessThanOrEqual(1);
      expect(saude?.confianca).toBeGreaterThanOrEqual(0);
      expect(saude?.confianca).toBeLessThanOrEqual(1);
    });

    // Test 12: Empty result sets — reminders/maintenance arrays can be empty
    it('should return empty arrays when no reminders or maintenance scheduled', async () => {
      const state = createState();
      const diagnosis = createDiagnosis();
      state.diagnosisLogs.push({
        id: 'diag-1',
        plantId: PLANT_ID,
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        especiePopular: diagnosis.especieProvavel.nomePopular,
        especieCientifica: diagnosis.especieProvavel.nomeCientifico,
        confiancaEspecie: diagnosis.especieProvavel.confianca,
        saudeStatus: diagnosis.saude.status,
        saudeConfianca: diagnosis.saude.confianca,
        riscoPet: diagnosis.pet.risco,
        diagnosisJson: JSON.stringify(diagnosis),
        createdAt: FIXED_NOW,
      });

      const prisma = makePrismaMock(state);
      const service = new PlantsAiService(prisma, { setPhoto: jest.fn() } as never);

      const result = await service.getPlantInsights(TENANT_ID, PROJECT_ID, PLANT_ID);

      expect(result.diagnosis).toBeDefined();
      expect(result.cuidadoAgendado.reminders).toEqual([]);
      expect(result.cuidadoAgendado.maintenance).toEqual([]);
    });
  });
});
