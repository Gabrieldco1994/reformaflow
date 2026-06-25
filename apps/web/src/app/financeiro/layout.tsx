'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, LogOut } from 'lucide-react';
import { useAuth } from '@/contexts/auth-context';

export default function FinanceiroLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { user, loading, logout, hasModule } = useAuth();

  useEffect(() => {
    if (!loading && !user) {
      router.replace('/login');
      return;
    }
    if (!loading && user && !hasModule('financialDashboard')) {
      router.replace('/projects');
    }
  }, [loading, user, hasModule, router]);

  if (loading || !user || !hasModule('financialDashboard')) {
    return (
      <div className="flex h-screen items-center justify-center bg-white">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-darc-red" />
      </div>
    );
  }

  async function handleLogout() {
    await logout();
    router.replace('/login');
  }

  return (
    <div className="min-h-screen bg-darc-linen/30">
      <header className="bg-white border-b border-darc-linen sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 md:px-6 h-14 flex items-center justify-between">
          <Link
            href="/projects"
            className="flex items-center gap-2 text-darc-velvet hover:text-darc-red transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <span className="font-editorial italic text-base">Projetos</span>
          </Link>
          <div className="flex items-center gap-3">
            <span className="hidden md:inline text-xs text-darc-velvet/60">{user.name}</span>
            <button
              onClick={handleLogout}
              title="Sair"
              className="p-2 rounded-full text-darc-velvet/70 hover:bg-darc-linen/60 hover:text-darc-red transition-colors"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>
      <main className="font-platform-content">{children}</main>
    </div>
  );
}
