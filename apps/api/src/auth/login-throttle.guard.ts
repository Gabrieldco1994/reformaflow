import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * Rate-limiter de login em memória (sem dependência externa).
 * Protege contra brute-force com dois limites independentes:
 *  - por IP confiável + username (janela deslizante)
 *  - por username isolado (cap por conta, resiste a rotação de IP/header)
 *
 * Adequado para deploy single-instance (Fly). O IP é derivado de fontes
 * confiáveis (Fly-Client-IP / express req.ip), nunca do valor mais à esquerda
 * de X-Forwarded-For, que é controlado pelo cliente e seria falsificável.
 */
@Injectable()
export class LoginThrottleGuard implements CanActivate {
  private readonly byIpUser = new Map<string, number[]>();
  private readonly byUser = new Map<string, number[]>();
  private readonly windowMs = 10 * 60 * 1000; // 10 min
  private readonly maxPerIpUser = 10;
  private readonly maxPerUser = 30;

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const ip = this.clientIp(req);
    const username =
      typeof req.body?.username === 'string'
        ? req.body.username.toLowerCase().trim()
        : '';

    const now = Date.now();
    this.check(this.byIpUser, `${ip}:${username}`, now, this.maxPerIpUser);
    if (username) this.check(this.byUser, username, now, this.maxPerUser);

    if (this.byIpUser.size + this.byUser.size > 20_000) this.sweep(now);
    return true;
  }

  /** IP confiável: Fly injeta Fly-Client-IP; senão usa o valor mais à DIREITA
   * de X-Forwarded-For (anexado pelo proxy), com fallback para req.ip. */
  private clientIp(req: Request): string {
    const flyIp = req.headers['fly-client-ip'];
    if (typeof flyIp === 'string' && flyIp) return flyIp.trim();
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) {
      const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1]!;
    }
    return req.ip || 'unknown';
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
        'Muitas tentativas de login. Tente novamente em alguns minutos.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    recent.push(now);
    store.set(key, recent);
  }

  private sweep(now: number) {
    for (const store of [this.byIpUser, this.byUser]) {
      for (const [k, times] of store) {
        const live = times.filter((t) => now - t < this.windowMs);
        if (live.length === 0) store.delete(k);
        else store.set(k, live);
      }
    }
  }
}
