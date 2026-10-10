import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { readImportAuthForRequest } from "./import-session.auth";
import {
  IMPORT_SESSION_CLOCK,
  type ImportSessionClock,
} from "./import-session.capability";

export const IMPORT_SESSION_THROTTLED_OPERATION = {
  CREATE: "CREATE",
  RESERVE: "RESERVE",
  UPLOAD: "UPLOAD",
  ANALYZE: "ANALYZE",
  DOWNLOAD: "DOWNLOAD",
} as const;
export type ImportSessionThrottledOperation =
  (typeof IMPORT_SESSION_THROTTLED_OPERATION)[keyof typeof IMPORT_SESSION_THROTTLED_OPERATION];

const OPERATION_METADATA = "import-session-throttled-operation";
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 30;
const MAX_BUCKETS = 20_000;
const THROTTLED_MESSAGE =
  "Muitas requisições de importação. Tente novamente em instantes.";

export const ThrottleImportSessionOperation = (
  operation: ImportSessionThrottledOperation,
): MethodDecorator => SetMetadata(OPERATION_METADATA, operation);

/**
 * Per-actor, per-operation sliding window. Authentication has already minted the
 * request context before this method guard runs.
 */
@Injectable()
export class ImportSessionOperationThrottleGuard implements CanActivate {
  private readonly buckets = new Map<string, number[]>();

  constructor(
    private readonly reflector: Reflector,
    @Inject(IMPORT_SESSION_CLOCK) private readonly clock: ImportSessionClock,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const operation = this.reflector.get<ImportSessionThrottledOperation>(
      OPERATION_METADATA,
      context.getHandler(),
    );
    if (!operation) return true;

    const request = context.switchToHttp().getRequest<object>();
    const auth = readImportAuthForRequest(request);
    const now = this.clock.now().getTime();
    const key = JSON.stringify([auth.tenantId, auth.userId, operation]);
    const recent = (this.buckets.get(key) ?? []).filter(
      (instant) => now - instant < WINDOW_MS,
    );
    if (recent.length >= MAX_REQUESTS) {
      throw new HttpException(THROTTLED_MESSAGE, HttpStatus.TOO_MANY_REQUESTS);
    }
    recent.push(now);
    this.buckets.set(key, recent);
    if (this.buckets.size > MAX_BUCKETS) this.sweep(now);
    return true;
  }

  private sweep(now: number): void {
    for (const [key, instants] of this.buckets) {
      const recent = instants.filter((instant) => now - instant < WINDOW_MS);
      if (recent.length === 0) this.buckets.delete(key);
      else this.buckets.set(key, recent);
    }
    while (this.buckets.size > MAX_BUCKETS) {
      const oldest = this.buckets.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }
}
