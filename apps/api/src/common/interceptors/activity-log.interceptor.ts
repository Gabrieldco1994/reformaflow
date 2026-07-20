import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { tap } from 'rxjs/operators';
import { PrismaService } from '../../prisma/prisma.service';

// Modules too noisy or internal to log
const SKIP_MODULES = new Set(['auth', 'tts', 'link-preview', 'notifications', 'demo', 'users']);

function deriveAction(method: string, routePath?: string): string | null {
  const verbMap: Record<string, string> = { POST: 'create', PATCH: 'update', PUT: 'update', DELETE: 'delete' };
  const verb = verbMap[method];
  if (!verb || !routePath) return null;
  const parts = routePath.split('/').filter(Boolean);
  const module = parts[0];
  if (!module || SKIP_MODULES.has(module)) return null;
  // Special sub-routes: /users/:id/force-logout → users.force-logout (skipped above)
  const lastPart = parts[parts.length - 1];
  if (lastPart && !lastPart.startsWith(':') && parts.length > 2) {
    return `${module}.${lastPart}`;
  }
  return `${module}.${verb}`;
}

@Injectable()
export class ActivityLogInterceptor implements NestInterceptor {
  constructor(private prisma: PrismaService) {}

  intercept(ctx: ExecutionContext, next: CallHandler) {
    const req = ctx.switchToHttp().getRequest();
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return next.handle();

    return next.handle().pipe(
      tap(() => {
        const userId: string | undefined = req.user?.id;
        const tenantId: string | undefined = req.user?.tenantId;
        if (!userId || !tenantId) return;
        const action = deriveAction(req.method, req.route?.path);
        if (!action) return;
        // ponytail: fire-and-forget, telemetry loss is acceptable
        void this.prisma.userActivityLog.create({ data: { userId, tenantId, action } }).catch(() => {});
      }),
    );
  }
}
