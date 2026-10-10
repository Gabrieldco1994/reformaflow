import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from "@nestjs/common";
import { ImportSessionErrorCode } from "@reformaflow/domain";
import { ImportSessionError } from "./import-session.errors";
import { ImportUiGrantIssuer } from "./import-session-ui-grant";

/** Custom header a cross-site form/CORS-simple request cannot send. Exactly the value `1`. */
export const IMPORT_UI_HEADER = "x-rf-import-ui";
export const IMPORT_SESSION_UI_ORIGINS = Symbol("IMPORT_SESSION_UI_ORIGINS");

export interface ImportSessionUiOrigins {
  allowed(): readonly string[];
}

const DEFAULT_ORIGIN = "http://localhost:3000";

/**
 * Same source as the global CORS (`CORS_ORIGIN`, comma separated, trimmed), but stricter:
 * only exact http(s) origins survive. `*`, `null`, paths, trailing slashes, other schemes,
 * uppercase variants and credentials are dropped, so the list can only narrow, never widen.
 */
export function parseAllowedImportOrigins(raw: string): string[] {
  const origins: string[] = [];
  for (const entry of raw.split(",").map((part) => part.trim())) {
    if (!entry || entry.includes("*")) continue;
    try {
      const url = new URL(entry);
      if (
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.origin === entry
      ) {
        origins.push(entry);
      }
    } catch {
      // not a URL: dropped
    }
  }
  return origins;
}

@Injectable()
export class EnvImportSessionUiOrigins implements ImportSessionUiOrigins {
  allowed(): readonly string[] {
    const configured = process.env["CORS_ORIGIN"];
    // INT-1: the localhost default exists for local development only. With the production
    // cookie (SameSite=None) an implicit localhost origin would be a CSRF hole, so production
    // without an explicit CORS_ORIGIN denies every UI action (fail closed).
    if (process.env["NODE_ENV"] === "production" && !configured?.trim()) {
      return [];
    }
    return [
      ...new Set(parseAllowedImportOrigins(configured ?? DEFAULT_ORIGIN)),
    ];
  }
}

/**
 * Persistence-side UI protection: the exact Origin of the web UI AND the custom header.
 * It attests the request so the boundary can mint a grant; without it nothing can.
 */
@Injectable()
export class ImportUiGuard implements CanActivate {
  constructor(
    @Inject(IMPORT_SESSION_UI_ORIGINS)
    private readonly origins: ImportSessionUiOrigins,
    private readonly issuer: ImportUiGrantIssuer,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ headers?: Record<string, unknown> }>();
    const headers = request?.headers ?? {};
    const origin = headers["origin"];
    const marker = headers[IMPORT_UI_HEADER];
    if (
      typeof origin !== "string" ||
      marker !== "1" ||
      !this.origins.allowed().includes(origin)
    ) {
      throw new ImportSessionError(ImportSessionErrorCode.UI_ACTION_REQUIRED);
    }
    this.issuer.attestRequest(request);
    return true;
  }
}
