'use client';

export const dynamic = 'force-dynamic';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/auth-context';

export default function NoPermissionPage() {
  const { user, isAdmin, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace('/login');
    }
  }, [user, loading, router]);

  if (loading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="max-w-md text-center bg-white p-8 rounded-xl border border-gray-200">
        <div className="text-4xl mb-3">🚫</div>
        <h1 className="text-lg font-semibold text-gray-900 mb-2">
          Acesso restrito
        </h1>
        <p className="text-sm text-gray-600 mb-1">
          Olá, <strong>{user.name}</strong>. Você está autenticado, mas não tem
          permissão para acessar este módulo.
        </p>
        <p className="text-xs text-gray-500 mb-4">
          Peça ao administrador para liberar.
        </p>
        <div className="flex gap-2 justify-center flex-wrap">
          <a
            href="/projects"
            className="px-4 py-2 text-sm bg-brand-600 text-white hover:bg-brand-700 rounded-lg"
          >
            Ir para meus projetos
          </a>
          {isAdmin && (
            <a
              href="/admin/users"
              className="px-4 py-2 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg"
            >
              Gerenciar usuários
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
