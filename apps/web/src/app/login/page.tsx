'use client';

export const dynamic = 'force-dynamic';

import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/contexts/auth-context';

function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rawNext = search.get('next') || '/';
  const next = (() => {
    if (!rawNext.startsWith('/')) return '/';
    if (rawNext.startsWith('/login')) return '/';
    if (rawNext.startsWith('/no-permission')) return '/';
    return rawNext;
  })();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(username, password);
      router.replace(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha no login');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 relative overflow-hidden"
      style={{ background: 'linear-gradient(135deg, #F6CFF2 0%, #E2366B 50%, #EB1C24 100%)' }}
    >
      <div className="absolute inset-0 opacity-20 pointer-events-none" style={{ background: 'radial-gradient(circle at 20% 80%, #BFA4D1 0%, transparent 50%), radial-gradient(circle at 80% 20%, #F27D33 0%, transparent 50%)' }} />
      <form
        onSubmit={handleSubmit}
        className="relative w-full max-w-sm bg-darc-off-white/95 backdrop-blur-sm p-10 rounded-2xl shadow-darc-hero border border-darc-linen space-y-6"
      >
        <div className="text-center">
          <h1 className="font-editorial text-5xl text-darc-red leading-none">D&apos;arc</h1>
          <p className="text-[10px] tracking-[0.3em] uppercase text-darc-maroon mt-2 font-medium">Studio</p>
          <p className="text-sm text-darc-raspberry/80 mt-4 italic">Entre para continuar</p>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-[11px] font-medium tracking-wider uppercase text-darc-maroon mb-1.5">
              Usuário
            </label>
            <input
              type="text"
              autoComplete="username"
              required
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-3 py-2.5 bg-transparent border-b border-darc-linen rounded-none text-sm text-darc-maroon focus:outline-none focus:border-darc-red transition-colors"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium tracking-wider uppercase text-darc-maroon mb-1.5">
              Senha
            </label>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2.5 bg-transparent border-b border-darc-linen rounded-none text-sm text-darc-maroon focus:outline-none focus:border-darc-red transition-colors"
            />
          </div>
        </div>

        {error && (
          <div className="text-xs text-darc-linen bg-darc-raspberry rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full bg-darc-red hover:bg-darc-raspberry disabled:opacity-50 disabled:cursor-not-allowed text-darc-linen font-medium tracking-wider uppercase py-3 rounded-lg text-xs transition-colors"
        >
          {submitting ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen" />}>
      <LoginForm />
    </Suspense>
  );
}
