'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/contexts/auth-context';
import { LifeOneLogo } from '@/components/LifeOneLogo';
import { api } from '@/lib/api';

function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registerEnabled, setRegisterEnabled] = useState(false);

  useEffect(() => {
    let active = true;
    api.get<{ registerEnabled: boolean }>('/auth/config')
      .then((config) => { if (active) setRegisterEnabled(config.registerEnabled === true); })
      .catch(() => { if (active) setRegisterEnabled(false); });
    return () => { active = false; };
  }, []);

  const rawNext = search.get('next') || '/app';
  const next = (() => {
    if (!rawNext.startsWith('/')) return '/app';
    if (rawNext.startsWith('/login')) return '/app';
    if (rawNext.startsWith('/no-permission')) return '/app';
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
    <div className="min-h-screen grid place-items-center px-4 py-10 relative overflow-x-hidden bg-lifeone-canvas font-geist">
      {/* Blue accent glows — LifeOne canvas */}
      <div
        className="absolute inset-0 pointer-events-none"
        aria-hidden
        style={{
          background:
            'radial-gradient(circle at 15% 15%, rgba(10,108,240,0.10) 0%, transparent 42%), radial-gradient(circle at 85% 85%, rgba(10,108,240,0.08) 0%, transparent 45%)',
        }}
      />

      <div className="relative w-full max-w-sm mx-auto min-w-0">
        <div className="flex flex-col items-center mb-7">
          <LifeOneLogo />
          <p className="mt-3 text-[13px] text-lifeone-ink-2 tracking-[-0.01em]">
            Gestão financeira e de vida, num só lugar
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="w-full bg-lifeone-card p-8 rounded-[18px] shadow-lifeone-card border border-lifeone-hairline space-y-6"
        >
          <div>
            <h1
              className="font-geist not-italic text-[20px] font-bold tracking-[-0.02em] text-lifeone-ink"
              style={{ fontFamily: "'Geist', var(--font-sans), system-ui, sans-serif", fontStyle: 'normal', fontWeight: 700 }}
            >
              Entrar
            </h1>
            <p className="text-[13px] text-lifeone-ink-3 mt-0.5">Acesse sua conta para continuar</p>
          </div>

          <div className="space-y-4">
            <div>
              <label htmlFor="login-username" className="block text-[12px] font-medium text-lifeone-ink-2 mb-1.5">
                Usuário
              </label>
              <input
                id="login-username"
                type="text"
                autoComplete="username"
                required
                autoFocus
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-lifeone-surface border border-lifeone-hairline rounded-[10px] text-[14px] text-lifeone-ink placeholder:text-lifeone-ink-4 focus:outline-none focus:border-lifeone-blue focus:ring-2 focus:ring-lifeone-blue/25 transition-all"
              />
            </div>
            <div>
              <label htmlFor="login-password" className="block text-[12px] font-medium text-lifeone-ink-2 mb-1.5">
                Senha
              </label>
              <input
                id="login-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-lifeone-surface border border-lifeone-hairline rounded-[10px] text-[14px] text-lifeone-ink placeholder:text-lifeone-ink-4 focus:outline-none focus:border-lifeone-blue focus:ring-2 focus:ring-lifeone-blue/25 transition-all"
              />
            </div>
          </div>

          {error && (
            <div className="text-[13px] text-[#B42318] bg-[#FEF3F2] border border-[#FECDCA] rounded-[10px] px-3 py-2.5">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-lifeone-blue hover:brightness-95 disabled:opacity-50 disabled:cursor-not-allowed text-[#FFFFFF] font-semibold py-3 rounded-[10px] text-[14px] tracking-[-0.01em] shadow-lifeone-card transition-all active:scale-[0.99]"
          >
            {submitting ? 'Entrando…' : 'Entrar'}
          </button>

          {registerEnabled && (
            <div className="border-t border-lifeone-hairline pt-5 text-center">
              <p className="text-[13px] text-lifeone-ink-3">Ainda não usa a LifeOne?</p>
              <Link href="/register" className="mt-2 inline-flex min-h-11 items-center justify-center rounded-[10px] px-4 text-[14px] font-semibold text-lifeone-blue hover:bg-lifeone-info">
                Criar minha conta
              </Link>
            </div>
          )}
        </form>

        <p className="text-center text-[11px] text-lifeone-ink-4 mt-6">
          LifeOne · SaaS de gestão Financeira e Vida
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-lifeone-canvas" />}>
      <LoginForm />
    </Suspense>
  );
}
