import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AdminJourneysController } from './admin-journeys.controller';

/**
 * RED spec for #339. `admin-journeys.controller.ts` does not exist yet.
 *
 * Contract assumed (mirrors `AdminOnboardingJourneyController`, the
 * controller this API replaces per the issue's "Escopo" bullet):
 *   - `@Controller('admin/journeys')`, `RolesGuard` + `@Roles('ADMIN')` on
 *     the WHOLE controller (not per-route) — same pattern as
 *     `AdminOnboardingJourneyController`.
 *   - `GET /admin/journeys` -> `list()` -> `JourneysAdminService.list()`.
 *   - `POST /admin/journeys` -> `create(dto)` -> `JourneysAdminService.create(dto)`.
 *   - `GET /admin/journeys/:id` -> `get(id)` -> `JourneysAdminService.get(id)`.
 *   - `PUT /admin/journeys/:id` -> `update(id, dto)` -> `JourneysAdminService.update(id, dto)`.
 */

function makeService() {
  return {
    list: jest.fn().mockResolvedValue([]),
    get: jest.fn().mockResolvedValue({}),
    create: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
  } as any;
}

function contextFor(handler: any, role: string) {
  return {
    getHandler: () => handler,
    getClass: () => AdminJourneysController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as any;
}

describe('AdminJourneysController (ADMIN-only, replaces AdminOnboardingJourneyController)', () => {
  it('restricts the whole controller to ADMIN', () => {
    expect(Reflect.getMetadata(ROLES_KEY, AdminJourneysController)).toEqual(['ADMIN']);
  });

  it.each(['list', 'create', 'get', 'update'] as const)('blocks a plain USER on %s', (method) => {
    const guard = new RolesGuard(new Reflector());
    expect(() =>
      guard.canActivate(contextFor((AdminJourneysController.prototype as any)[method], 'USER')),
    ).toThrow(ForbiddenException);
  });

  it('allows ADMIN through', () => {
    const guard = new RolesGuard(new Reflector());
    expect(guard.canActivate(contextFor(AdminJourneysController.prototype.list, 'ADMIN'))).toBe(
      true,
    );
  });

  it('list() delegates to the service with no arguments and returns its result untouched', async () => {
    const service = makeService();
    const rows = [{ id: 'j1', key: 'a' }];
    service.list.mockResolvedValue(rows);
    const controller = new AdminJourneysController(service);

    await expect(controller.list()).resolves.toBe(rows);
    expect(service.list).toHaveBeenCalledWith();
  });

  it('get(id) forwards the exact :id param', async () => {
    const service = makeService();
    const controller = new AdminJourneysController(service);

    await controller.get('journey-123');

    expect(service.get).toHaveBeenCalledWith('journey-123');
  });

  it('create(dto) forwards the exact body to the service and returns its result', async () => {
    const service = makeService();
    const created = { id: 'new-journey' };
    service.create.mockResolvedValue(created);
    const controller = new AdminJourneysController(service);
    const dto = {
      key: 'k',
      name: 'n',
      steps: [],
      triggers: [{ triggerType: 'PROJECT_CREATED' }],
    };

    await expect(controller.create(dto as any)).resolves.toBe(created);
    expect(service.create).toHaveBeenCalledWith(dto);
  });

  it('update(id, dto) forwards BOTH the :id param and the body to the service', async () => {
    const service = makeService();
    const controller = new AdminJourneysController(service);
    const dto = { active: false };

    await controller.update('journey-123', dto as any);

    expect(service.update).toHaveBeenCalledWith('journey-123', dto);
  });
});
