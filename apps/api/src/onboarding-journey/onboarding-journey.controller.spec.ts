import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ProjectType } from '@reformaflow/domain';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AdminOnboardingJourneyController } from './admin-onboarding-journey.controller';
import { OnboardingJourneyController } from './onboarding-journey.controller';

function makeService() {
  return {
    getJourney: jest.fn().mockResolvedValue([]),
    getAllJourneys: jest.fn().mockResolvedValue({}),
    saveJourney: jest.fn().mockResolvedValue([]),
  } as any;
}

function contextFor(controller: any, handler: any, role: string) {
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as any;
}

describe('OnboardingJourneyController (leitura, qualquer autenticado)', () => {
  it('não exige papel ADMIN — o wizard de onboarding roda como USER', () => {
    expect(Reflect.getMetadata(ROLES_KEY, OnboardingJourneyController)).toBeUndefined();

    const guard = new RolesGuard(new Reflector());
    expect(
      guard.canActivate(
        contextFor(
          OnboardingJourneyController,
          OnboardingJourneyController.prototype.get,
          'USER',
        ),
      ),
    ).toBe(true);
  });

  it('delega a resolução da jornada para o service', async () => {
    const service = makeService();
    const controller = new OnboardingJourneyController(service);

    await controller.get(ProjectType.PESSOAL);

    expect(service.getJourney).toHaveBeenCalledWith(ProjectType.PESSOAL);
  });
});

describe('AdminOnboardingJourneyController (escrita, ADMIN-only)', () => {
  it('mantém o controller inteiro restrito a ADMIN', () => {
    expect(Reflect.getMetadata(ROLES_KEY, AdminOnboardingJourneyController)).toEqual([
      'ADMIN',
    ]);
  });

  it('bloqueia USER tanto na listagem quanto na escrita', () => {
    const guard = new RolesGuard(new Reflector());

    expect(() =>
      guard.canActivate(
        contextFor(
          AdminOnboardingJourneyController,
          AdminOnboardingJourneyController.prototype.list,
          'USER',
        ),
      ),
    ).toThrow(ForbiddenException);

    expect(() =>
      guard.canActivate(
        contextFor(
          AdminOnboardingJourneyController,
          AdminOnboardingJourneyController.prototype.update,
          'USER',
        ),
      ),
    ).toThrow(ForbiddenException);
  });

  it('libera ADMIN', () => {
    const guard = new RolesGuard(new Reflector());
    expect(
      guard.canActivate(
        contextFor(
          AdminOnboardingJourneyController,
          AdminOnboardingJourneyController.prototype.list,
          'ADMIN',
        ),
      ),
    ).toBe(true);
  });

  it('list devolve todos os tipos e update repassa o body ao service', async () => {
    const service = makeService();
    const controller = new AdminOnboardingJourneyController(service);

    await controller.list();
    expect(service.getAllJourneys).toHaveBeenCalled();

    const dto = {
      steps: [{ stepKey: 'bank', order: 0, enabled: true, skippable: true }],
    };
    await controller.update(ProjectType.PESSOAL, dto as any);
    expect(service.saveJourney).toHaveBeenCalledWith(ProjectType.PESSOAL, dto);
  });
});
