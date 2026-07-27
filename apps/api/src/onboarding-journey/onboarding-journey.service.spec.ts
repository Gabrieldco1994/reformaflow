import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ONBOARDING_JOURNEY_DEFAULTS, ProjectType } from '@reformaflow/domain';
import { PrismaService } from '../prisma/prisma.service';
import { OnboardingJourneyService } from './onboarding-journey.service';

function makeRow(over: Partial<any> = {}) {
  return {
    id: 'j1',
    projectType: ProjectType.PESSOAL,
    stepKey: 'funding',
    order: 0,
    enabled: true,
    skippable: true,
    labelOverride: null,
    subtitleOverride: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...over,
  };
}

describe('OnboardingJourneyService', () => {
  let service: OnboardingJourneyService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      onboardingJourneyStep: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockImplementation((args: any) => Promise.resolve(args)),
      },
      $transaction: jest.fn().mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OnboardingJourneyService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(OnboardingJourneyService);
  });

  describe('getJourney', () => {
    it('sem nenhuma linha no banco devolve a jornada padrão completa', async () => {
      const journey = await service.getJourney(ProjectType.PESSOAL);

      const defaults = ONBOARDING_JOURNEY_DEFAULTS[ProjectType.PESSOAL];
      expect(journey).toHaveLength(defaults.length);
      expect(journey.map((s) => s.key)).toEqual(defaults.map((d) => d.key));
      // ponytail: expense+import são desabilitados automaticamente quando expense-import está ativo
      const enabledKeys = journey.filter((s) => s.enabled).map((s) => s.key);
      expect(enabledKeys).toEqual(['funding', 'expense-import', 'receipt', 'maria-insight', 'feedback']);
      expect(journey[0]!.subtitle).toBe(defaults[0]!.defaultSubtitle);
    });

    it('aplica overrides salvos: ordem, enabled, skippable e textos', async () => {
      prisma.onboardingJourneyStep.findMany.mockResolvedValue([
        makeRow({ stepKey: 'expense', order: 0 }),
        makeRow({
          stepKey: 'funding',
          order: 1,
          skippable: false,
          labelOverride: 'Banco',
          subtitleOverride: 'Informe seu saldo',
        }),
        makeRow({ stepKey: 'receipt', order: 2, enabled: false }),
      ]);

      const journey = await service.getJourney(ProjectType.PESSOAL);

      expect(journey[0]!.key).toBe('expense');
      expect(journey[1]!).toMatchObject({
        key: 'funding',
        label: 'Banco',
        subtitle: 'Informe seu saldo',
        skippable: false,
      });
      expect(journey.find((s) => s.key === 'receipt')!.enabled).toBe(false);
      expect(prisma.onboardingJourneyStep.findMany).toHaveBeenCalledWith({
        where: { projectType: ProjectType.PESSOAL },
        orderBy: { order: 'asc' },
      });
    });

    it('rejeita projectType inválido sem consultar o banco', async () => {
      await expect(service.getJourney('BANANA' as ProjectType)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.onboardingJourneyStep.findMany).not.toHaveBeenCalled();
    });
  });

  describe('getAllJourneys', () => {
    it('devolve os 6 tipos, com default para quem não tem config', async () => {
      prisma.onboardingJourneyStep.findMany.mockResolvedValue([
        makeRow({ projectType: ProjectType.CASA, stepKey: 'bill', enabled: false }),
      ]);

      const all = await service.getAllJourneys();

      expect(Object.keys(all).sort()).toEqual(Object.values(ProjectType).sort());
      expect(all[ProjectType.CASA]!.find((s) => s.key === 'bill')!.enabled).toBe(false);
      expect(all[ProjectType.PESSOAL]!).toHaveLength(
        ONBOARDING_JOURNEY_DEFAULTS[ProjectType.PESSOAL].length,
      );
    });
  });

  describe('saveJourney', () => {
    it('faz upsert por [projectType, stepKey] e devolve a jornada resolvida', async () => {
      prisma.onboardingJourneyStep.findMany.mockResolvedValue([
        makeRow({ stepKey: 'funding', order: 3, enabled: false }),
      ]);

      const result = await service.saveJourney(ProjectType.PESSOAL, {
        steps: [{ stepKey: 'funding', order: 3, enabled: false, skippable: true }],
      });

      expect(prisma.onboardingJourneyStep.upsert).toHaveBeenCalledTimes(1);
      const arg = prisma.onboardingJourneyStep.upsert.mock.calls[0][0];
      expect(arg.where).toEqual({
        projectType_stepKey: { projectType: ProjectType.PESSOAL, stepKey: 'funding' },
      });
      expect(arg.create).toMatchObject({
        projectType: ProjectType.PESSOAL,
        stepKey: 'funding',
        order: 3,
        enabled: false,
        skippable: true,
        labelOverride: null,
        subtitleOverride: null,
      });
      expect(arg.update).toMatchObject({ order: 3, enabled: false, skippable: true });
      expect(result.find((s) => s.key === 'funding')!.enabled).toBe(false);
    });

    it('normaliza texto vazio/em branco para null (cai no default)', async () => {
      await service.saveJourney(ProjectType.PESSOAL, {
        steps: [
          { stepKey: 'funding', order: 0, enabled: true, skippable: true, label: '  ', subtitle: null },
        ],
      });

      const arg = prisma.onboardingJourneyStep.upsert.mock.calls[0][0];
      expect(arg.create.labelOverride).toBeNull();
      expect(arg.create.subtitleOverride).toBeNull();
    });

    it('stepKey desconhecido para o tipo → 400 e nada persistido', async () => {
      await expect(
        service.saveJourney(ProjectType.PESSOAL, {
          steps: [
            { stepKey: 'funding', order: 0, enabled: true, skippable: true },
            { stepKey: 'nao-existe', order: 1, enabled: true, skippable: true },
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.onboardingJourneyStep.upsert).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('stepKey de outro tipo de projeto → 400 (não vaza tela entre tipos)', async () => {
      await expect(
        service.saveJourney(ProjectType.REFORMA, {
          steps: [{ stepKey: 'funding', order: 0, enabled: true, skippable: true }],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.onboardingJourneyStep.upsert).not.toHaveBeenCalled();
    });

    it('stepKey duplicado no body → 400 (upserts conflitantes)', async () => {
      await expect(
        service.saveJourney(ProjectType.PESSOAL, {
          steps: [
            { stepKey: 'funding', order: 0, enabled: true, skippable: true },
            { stepKey: 'funding', order: 1, enabled: false, skippable: true },
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.onboardingJourneyStep.upsert).not.toHaveBeenCalled();
    });

    it('projectType inválido → 400 e nada persistido', async () => {
      await expect(
        service.saveJourney('BANANA' as ProjectType, {
          steps: [{ stepKey: 'funding', order: 0, enabled: true, skippable: true }],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.onboardingJourneyStep.upsert).not.toHaveBeenCalled();
    });

    it('escreve todos os upserts numa única transação (all-or-nothing)', async () => {
      await service.saveJourney(ProjectType.REFORMA, {
        steps: [
          { stepKey: 'expense', order: 1, enabled: true, skippable: false },
          { stepKey: 'feedback', order: 0, enabled: true, skippable: true },
        ],
      });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.onboardingJourneyStep.upsert).toHaveBeenCalledTimes(2);
    });
  });
});
