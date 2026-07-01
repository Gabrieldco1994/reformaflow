import 'reflect-metadata';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants';
import { TenantInterceptor } from './interceptors/tenant.interceptor';
import { PendenciaController } from '../pendencia/pendencia.controller';
import { ReminderController } from '../reminder/reminder.controller';
import { MaintenanceController } from '../maintenance/maintenance.controller';
import { RecurringBillController } from '../recurring-bill/recurring-bill.controller';
import { CarInfoController } from '../car-info/car-info.controller';
import { ScheduleController } from '../schedule/schedule.controller';

/**
 * Regression guard for the multi-tenant write bug: these controllers must
 * resolve the tenant from the authenticated request (via TenantInterceptor +
 * @CurrentTenant), NEVER from a raw `x-tenant-id` header the SPA never sends.
 * Reading the header directly made every create/update return 500 (tenantId
 * undefined) from the web app. Keep them wired to TenantInterceptor.
 */
describe('tenant resolution contract (project-scoped controllers)', () => {
  const controllers = [
    ['PendenciaController', PendenciaController],
    ['ReminderController', ReminderController],
    ['MaintenanceController', MaintenanceController],
    ['RecurringBillController', RecurringBillController],
    ['CarInfoController', CarInfoController],
    ['ScheduleController', ScheduleController],
  ] as const;

  it.each(controllers)('%s applies TenantInterceptor', (_name, controller) => {
    const interceptors: unknown[] = Reflect.getMetadata(INTERCEPTORS_METADATA, controller) ?? [];
    const names = interceptors.map((i) =>
      typeof i === 'function' ? i.name : (i as object)?.constructor?.name,
    );
    expect(names).toContain(TenantInterceptor.name);
  });
});
