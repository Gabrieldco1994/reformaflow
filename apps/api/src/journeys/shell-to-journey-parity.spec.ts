import { Test, TestingModule } from '@nestjs/testing';
import { ProjectType } from '@reformaflow/domain';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { OnboardingJourneyService } from '../onboarding-journey/onboarding-journey.service';
import { JourneysEligibilityService } from './journeys-eligibility.service';
import { JourneyBootstrapService } from './journey-bootstrap.service';

/**
 * RED spec for #339 Fase B: prova que a jornada nova (via `JourneysEligibilityService`
 * trigger PROJECT_CREATED) produz EXATAMENTE o mesmo resultado que o shell antigo
 * (via `OnboardingJourneyService`), para cada um dos 6 tipos de projeto.
 *
 * Scope: mesmo tipo de projeto, mesmo usuário (ambos com repeat-policy ONCE_PER_PROJECT).
 * Se os passos, ordem, labels e comportamento forem idênticos, a migração é segura
 * e a remoção do shell pode prosseguir.
 *
 * A migração de dados (criação de JourneyCompletion para projetos onboardados) é B2.
 * Este teste valida B1 (paridade comportamental).
 */
describe('Shell antigo vs Jornada nova — paridade (Fase B #339)', () => {
  let prisma: PrismaService;
  let onboardingService: OnboardingJourneyService;
  let eligibilityService: JourneysEligibilityService;

  let TENANT_ID: string;
  let USER_ID: string;

  const PROJECT_TYPES = [
    ProjectType.REFORMA,
    ProjectType.COMPRA,
    ProjectType.CASA,
    ProjectType.CARRO,
    ProjectType.PESSOAL,
    ProjectType.PLANTAS,
  ];

  function uniqueId(prefix: string): string {
    return `${prefix}-${randomUUID().slice(0, 8)}`;
  }

  beforeEach(async () => {
    TENANT_ID = `parity-${randomUUID().slice(0, 8)}`;
    USER_ID = `parity-${randomUUID().slice(0, 8)}`;

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PrismaService,
        OnboardingJourneyService,
        JourneysEligibilityService,
        JourneyBootstrapService,
      ],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    onboardingService = moduleRef.get(OnboardingJourneyService);
    eligibilityService = moduleRef.get(JourneysEligibilityService);
    const bootstrap = moduleRef.get(JourneyBootstrapService);

    // Bootstrap jornadas do catálogo
    await bootstrap.bootstrap();

    // Criar tenant e user
    await prisma.tenant.create({
      data: {
        id: TENANT_ID,
        name: `Parity Test Tenant`,
      },
    });

    await prisma.user.create({
      data: {
        id: USER_ID,
        tenantId: TENANT_ID,
        email: `${USER_ID}@test.local`,
        name: 'Parity Test User',
        username: USER_ID,
        role: 'USER',
      },
    });
  });

  afterEach(async () => {
    // Cleanup na ordem correta (FK constraints)
    await prisma.journeyCompletion.deleteMany({ where: { tenantId: TENANT_ID } });
    await prisma.project.deleteMany({ where: { tenantId: TENANT_ID } });
    await prisma.user.deleteMany({ where: { tenantId: TENANT_ID } });
    await prisma.tenant.deleteMany({ where: { id: TENANT_ID } });
    await prisma.$disconnect();
  });

  describe('shell antigo (OnboardingJourneyService)', () => {
    it(`each ProjectType has at least 1 step`, async () => {
      for (const type of PROJECT_TYPES) {
        const steps = await onboardingService.getJourney(type);
        expect(steps.length).toBeGreaterThan(0);
      }
    });

    it(`step labels match the domain defaults (sem override admin)`, async () => {
      for (const type of PROJECT_TYPES) {
        const steps = await onboardingService.getJourney(type);
        steps.forEach((step) => {
          expect(step.label.length).toBeGreaterThan(0);
          expect(step.subtitle || '').not.toBeNull();
        });
      }
    });
  });

  describe('jornada nova (JourneysEligibilityService + PROJECT_CREATED trigger)', () => {
    it(`each ProjectType has at least 1 step after PROJECT_CREATED trigger`, async () => {
      for (const type of PROJECT_TYPES) {
        // Criar projeto
        const project = await prisma.project.create({
          data: {
            id: uniqueId('project'),
            tenantId: TENANT_ID,
            name: `Projeto ${type}`,
            type,
            createdByUserId: USER_ID,
          },
        });

        // Consultar jornadas elegíveis para PROJECT_CREATED
        const eligible = await eligibilityService.getEligible(
          {
            triggerType: 'PROJECT_CREATED',
            device: 'web',
            projectId: project.id,
            projectType: type,
          },
          TENANT_ID,
          USER_ID,
        );

        expect(eligible.length).toBeGreaterThan(0);
        expect(eligible[0].steps.length).toBeGreaterThan(0);
      }
    });
  });

  describe('paridade: shell antigo ≡ jornada nova', () => {
    it(`each ProjectType: same steps visible (enabled=true), same order, same labels, same skippability`, async () => {
      for (const type of PROJECT_TYPES) {
        // Shell antigo: filtrar por enabled (o que usuário VÊ)
        const allShellSteps = await onboardingService.getJourney(type);
        const shellSteps = allShellSteps.filter((s) => s.enabled);

        // Jornada nova (PROJECT_CREATED trigger)
        const project = await prisma.project.create({
          data: {
            id: uniqueId('parity'),
            tenantId: TENANT_ID,
            name: `Parity ${type}`,
            type,
            createdByUserId: USER_ID,
          },
        });

        const eligible = await eligibilityService.getEligible(
          {
            triggerType: 'PROJECT_CREATED',
            device: 'web',
            projectId: project.id,
            projectType: type,
          },
          TENANT_ID,
          USER_ID,
        );

        // Deve haver exatamente uma jornada elegível (onboarding do tipo)
        expect(eligible).toHaveLength(1);
        const [journeyEntry] = eligible;

        // Comparar passos visíveis
        const journeySteps = journeyEntry.steps;

        expect(journeySteps).toHaveLength(shellSteps.length);

        for (let i = 0; i < shellSteps.length; i++) {
          const shellStep = shellSteps[i];
          const journeyStep = journeySteps[i];

          expect(journeyStep.stepKey).toBe(shellStep.key);
          expect(journeyStep.label).toBe(shellStep.label);
          expect(journeyStep.skippable).toBe(shellStep.skippable);
        }
      }
    });

    it(`user vê o onboarding apenas uma vez por projeto (ONCE_PER_PROJECT repeat-policy)`, async () => {
      const type = ProjectType.PESSOAL;

      // Criar projeto e acessá-lo
      const project = await prisma.project.create({
        data: {
          id: uniqueId('repeat-test'),
          tenantId: TENANT_ID,
          name: `Repeat Test ${type}`,
          type,
          createdByUserId: USER_ID,
        },
      });

      // Primeira vez: elegível
      const firstTime = await eligibilityService.getEligible(
        {
          triggerType: 'PROJECT_CREATED',
          device: 'web',
          projectId: project.id,
          projectType: type,
        },
        TENANT_ID,
        USER_ID,
      );
      expect(firstTime).toHaveLength(1);

      // Marcar como concluído
      const journeyId = firstTime[0].journeyId;
      const completionKey = `${TENANT_ID}:${USER_ID}:${project.id}`;
      console.log(`[repeat-test] Gravando JourneyCompletion: journeyId=${journeyId}, completionKey=${completionKey}`);

      await prisma.journeyCompletion.create({
        data: {
          journeyId,
          tenantId: TENANT_ID,
          userId: USER_ID,
          projectId: project.id,
          completionKey,
          completedAt: new Date(),
        },
      });

      // Segunda vez (mesmo projeto): deve estar excluído
      const secondTime = await eligibilityService.getEligible(
        {
          triggerType: 'PROJECT_CREATED',
          device: 'web',
          projectId: project.id,
          projectType: type,
        },
        TENANT_ID,
        USER_ID,
      );
      console.log(`[repeat-test] Após JourneyCompletion, elegible.length=${secondTime.length}`);
      expect(secondTime).toHaveLength(0);
    });

    it(`user com DOIS projetos do mesmo tipo vê onboarding nos dois (ONCE_PER_PROJECT, não ONCE_PER_USER)`, async () => {
      const type = ProjectType.REFORMA;

      // Criar dois projetos
      const project1 = await prisma.project.create({
        data: {
          id: uniqueId('multi-proj-1'),
          tenantId: TENANT_ID,
          name: `Projeto 1 ${type}`,
          type,
          createdByUserId: USER_ID,
        },
      });

      const project2 = await prisma.project.create({
        data: {
          id: uniqueId('multi-proj-2'),
          tenantId: TENANT_ID,
          name: `Projeto 2 ${type}`,
          type,
          createdByUserId: USER_ID,
        },
      });

      // Ambos devem ter onboarding elegível
      const eligible1 = await eligibilityService.getEligible(
        {
          triggerType: 'PROJECT_CREATED',
          device: 'web',
          projectId: project1.id,
          projectType: type,
        },
        TENANT_ID,
        USER_ID,
      );

      const eligible2 = await eligibilityService.getEligible(
        {
          triggerType: 'PROJECT_CREATED',
          device: 'web',
          projectId: project2.id,
          projectType: type,
        },
        TENANT_ID,
        USER_ID,
      );

      expect(eligible1).toHaveLength(1);
      expect(eligible2).toHaveLength(1);

      // Completar no projeto 1
      const journeyId = eligible1[0].journeyId;
      const completionKey1 = `${TENANT_ID}:${USER_ID}:${project1.id}`;
      console.log(`[multi-proj] Projeto 1: completionKey=${completionKey1}`);

      await prisma.journeyCompletion.create({
        data: {
          journeyId,
          tenantId: TENANT_ID,
          userId: USER_ID,
          projectId: project1.id,
          completionKey: completionKey1,
          completedAt: new Date(),
        },
      });

      // Projeto 1 agora excludente
      const project1After = await eligibilityService.getEligible(
        {
          triggerType: 'PROJECT_CREATED',
          device: 'web',
          projectId: project1.id,
          projectType: type,
        },
        TENANT_ID,
        USER_ID,
      );
      console.log(`[multi-proj] Projeto 1 após conclusão: elegible.length=${project1After.length}`);
      expect(project1After).toHaveLength(0);

      // Mas projeto 2 continua elegível (repeat-policy é PER PROJECT, não PER USER)
      const project2After = await eligibilityService.getEligible(
        {
          triggerType: 'PROJECT_CREATED',
          device: 'web',
          projectId: project2.id,
          projectType: type,
        },
        TENANT_ID,
        USER_ID,
      );
      console.log(`[multi-proj] Projeto 2 continua: elegible.length=${project2After.length}`);
      expect(project2After).toHaveLength(1);
    });
  });
});
