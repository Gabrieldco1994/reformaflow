'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth, type ModuleSlug } from '@/contexts/auth-context';

export function useRequireModule(slug: ModuleSlug) {
  const { user, loading, hasModule } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace('/login');
      return;
    }
    if (!hasModule(slug)) {
      router.replace('/no-permission');
    }
  }, [loading, user, hasModule, slug, router]);

  return { loading, allowed: !!user && hasModule(slug) };
}
