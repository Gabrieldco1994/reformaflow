import { SetMetadata } from '@nestjs/common';

export const SERVICE_OWNED_PROJECT_ACCESS_KEY = 'serviceOwnedProjectAccess';

/**
 * Per-HANDLER opt-out of `ProjectAccessGuard`'s id extraction (projectId/sourceProjectId/
 * targetProjectId in params, query or body). Static metadata only: nothing in the request can
 * set it. Legitimate only when the handler's service reauthorises the caller and resolves the
 * project/card anchor itself on every path (today: the five handlers of the import intake controller). It
 * removes a check; it does not replace one — never add it to a handler whose service does
 * not own tenant + project ACL.
 */
export const ServiceOwnedProjectAccess = () =>
  SetMetadata(SERVICE_OWNED_PROJECT_ACCESS_KEY, true);
