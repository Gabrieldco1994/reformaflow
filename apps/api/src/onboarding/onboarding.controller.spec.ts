import { Test, TestingModule } from '@nestjs/testing';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

describe('OnboardingController', () => {
  let controller: OnboardingController;
  let service: OnboardingService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [OnboardingController],
      providers: [OnboardingService],
    }).compile();

    controller = module.get<OnboardingController>(OnboardingController);
    service = module.get<OnboardingService>(OnboardingService);
  });

  describe('GET /onboarding/journey/:projectType', () => {
    it('returns PESSOAL catalog with funding step for PESSOAL type', async () => {
      const result = await controller.getJourney('PESSOAL');

      expect(result).toBeDefined();
      expect(result.steps).toBeDefined();
      expect(Array.isArray(result.steps)).toBe(true);

      const fundingStep = result.steps.find((s: any) => s.key === 'funding');
      expect(fundingStep).toBeDefined();
      expect(fundingStep!.key).toBe('funding');

      const bankStep = result.steps.find((s: any) => s.key === 'bank');
      const cardStep = result.steps.find((s: any) => s.key === 'card');
      expect(bankStep).toBeUndefined();
      expect(cardStep).toBeUndefined();
    });

    it('returns generic catalog for REFORMA type (unchanged)', async () => {
      const result = await controller.getJourney('REFORMA');

      expect(result).toBeDefined();
      expect(result.steps).toBeDefined();
      expect(Array.isArray(result.steps)).toBe(true);
    });

    it('returns catalog with proper structure', async () => {
      const result = await controller.getJourney('PESSOAL');

      expect(result.steps[0]).toHaveProperty('key');
      expect(result.steps[0]).toHaveProperty('label');
      expect(result.steps[0]).toHaveProperty('defaultSubtitle');
      expect(result.steps[0]).toHaveProperty('alwaysAvailable');
      expect(result.steps[0]).toHaveProperty('skippableByDefault');
    });
  });
});
