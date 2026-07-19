'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import Clarity from '@microsoft/clarity';
import { useOptionalAuth } from '@/contexts/auth-context';

const enabled =
  !!process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID && process.env.NODE_ENV === 'production';

// ponytail: init once client-side, prod only (avoid polluting Clarity with local/dev sessions).
// Tags every session with tenantId/role so recordings are attributable per tenant in the
// Clarity dashboard (filter/segment across all tenants) instead of one anonymous blob.
export function ClarityAnalytics() {
  const user = useOptionalAuth()?.user ?? null;
  const pathname = usePathname();

  useEffect(() => {
    if (!enabled) return;
    Clarity.init(process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID!);
  }, []);

  useEffect(() => {
    if (!enabled || !user) return;
    Clarity.setTag('tenantId', user.tenantId);
    Clarity.setTag('role', user.role);
    Clarity.identify(user.id, undefined, undefined, user.tenantId);
  }, [user, pathname]);

  return null;
}
