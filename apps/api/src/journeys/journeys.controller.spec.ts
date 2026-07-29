import { JourneysController } from './journeys.controller';

/**
 * RED spec for #339. `journeys.controller.ts` does not exist yet.
 *
 * Contract assumed (issue #339 escopo: "GET /journeys/eligible... POST
 * /journeys/:id/complete"), user-facing — mirrors `OnboardingJourneyController`
 * (no `@Roles`, any authenticated USER; `TenantInterceptor` injects
 * `request.tenantId`, `@CurrentUser()` injects `request.user`):
 *
 *   - `@Controller('journeys')`, no `RolesGuard`/`@Roles` (any authenticated
 *     user runs their own eligible journeys — same reasoning as
 *     `OnboardingJourneyController`).
 *   - `constructor(eligibility: JourneysEligibilityService, completion: JourneysCompletionService)`.
 *   - `GET /journeys/eligible` -> `eligible(query, tenantId, user)` where
 *     `query` comes from `@Query()` as a plain object with the raw string
 *     query params (`triggerType`, `device`, `projectId?`, `projectType?`,
 *     `screenKey?`, `actionKey?`) — delegates AS-IS to
 *     `JourneysEligibilityService.getEligible(query, tenantId, user.id)`.
 *   - `POST /journeys/:id/complete` -> `complete(id, dto, tenantId, user)`
 *     -> `JourneysCompletionService.complete(id, dto, tenantId, user.id)`.
 */

function makeEligibilityService() {
  return { getEligible: jest.fn().mockResolvedValue([]) } as any;
}

function makeCompletionService() {
  return {
    complete: jest.fn().mockResolvedValue({ completed: true, recorded: true }),
  } as any;
}

describe('JourneysController', () => {
  let controller: JourneysController;
  let eligibility: ReturnType<typeof makeEligibilityService>;
  let completion: ReturnType<typeof makeCompletionService>;

  beforeEach(() => {
    eligibility = makeEligibilityService();
    completion = makeCompletionService();
    controller = new JourneysController(eligibility, completion);
  });

  describe('GET /journeys/eligible', () => {
    it('delegates the exact query object, tenantId and user.id to the eligibility service', async () => {
      const query = {
        triggerType: 'PROJECT_CREATED',
        device: 'web',
        projectId: 'proj-1',
      };
      const rows = [{ journeyId: 'j1' }];
      eligibility.getEligible.mockResolvedValue(rows);

      const result = await controller.eligible(query as any, 'tenant-a', {
        id: 'user-1',
      } as any);

      expect(eligibility.getEligible).toHaveBeenCalledWith(query, 'tenant-a', 'user-1');
      expect(result).toBe(rows);
    });

    it('returns an empty array as-is (no error, no wrapping) when nothing is eligible', async () => {
      eligibility.getEligible.mockResolvedValue([]);
      const result = await controller.eligible(
        { triggerType: 'SIGNUP_COMPLETED', device: 'mobile' } as any,
        'tenant-a',
        { id: 'user-1' } as any,
      );
      expect(result).toEqual([]);
    });
  });

  describe('POST /journeys/:id/complete', () => {
    it('forwards the :id param, body, tenantId and user.id to the completion service', async () => {
      const dto = { triggerId: 't1', projectId: 'proj-1' };

      const result = await controller.complete('journey-123', dto as any, 'tenant-a', {
        id: 'user-1',
      } as any);

      expect(completion.complete).toHaveBeenCalledWith('journey-123', dto, 'tenant-a', 'user-1');
      expect(result).toEqual({ completed: true, recorded: true });
    });

    it('propagates the exact resolved value from the completion service (recorded:false for ALWAYS)', async () => {
      completion.complete.mockResolvedValue({
        completed: true,
        recorded: false,
      });
      const result = await controller.complete(
        'journey-123',
        { triggerId: 't1' } as any,
        'tenant-a',
        { id: 'user-1' } as any,
      );
      expect(result).toEqual({ completed: true, recorded: false });
    });
  });
});
