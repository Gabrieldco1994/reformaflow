import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';

@Injectable()
export class AgentChatThrottleGuard implements CanActivate {
  private readonly byIp = new Map<string, number[]>();
  private readonly byTenantUser = new Map<string, number[]>();
  private readonly windowMs = 60 * 1000;
  private readonly maxPerIp = 60;
  private readonly maxPerTenantUser = 30;

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & {
      tenantId?: string;
      user?: { id?: string };
    }>();
    const now = Date.now();
    const ip = this.clientIp(req);
    const tenant = req.tenantId || 'unknown-tenant';
    const userId = req.user?.id || 'unknown-user';

    this.check(this.byIp, ip, now, this.maxPerIp);
    this.check(
      this.byTenantUser,
      `${tenant}:${userId}`,
      now,
      this.maxPerTenantUser,
    );
    if (this.byIp.size + this.byTenantUser.size > 20_000) this.sweep(now);
    return true;
  }

  private check(
    store: Map<string, number[]>,
    key: string,
    now: number,
    max: number,
  ): void {
    const recent = (store.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= max) {
      throw new HttpException(
        'Muitas requisições para o assistente. Tente novamente em instantes.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    recent.push(now);
    store.set(key, recent);
  }

  private sweep(now: number): void {
    for (const store of [this.byIp, this.byTenantUser]) {
      for (const [k, times] of store) {
        const live = times.filter((t) => now - t < this.windowMs);
        if (live.length === 0) store.delete(k);
        else store.set(k, live);
      }
    }
  }

  private clientIp(req: Request): string {
    const flyIp = req.headers['fly-client-ip'];
    if (typeof flyIp === 'string' && flyIp) return flyIp.trim();
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) {
      const parts = xff
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      if (parts.length) return parts[parts.length - 1]!;
    }
    return req.ip || 'unknown';
  }
}
