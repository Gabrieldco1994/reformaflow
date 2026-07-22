'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LifeOneLogo } from '@/components/LifeOneLogo';
import { useAuth } from '@/contexts/auth-context';
import { ApiResponseError } from '@/lib/api';

const fieldClass =
  'min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3.5 py-2.5 text-[14px] text-lifeone-ink placeholder:text-lifeone-ink-4 focus:border-lifeone-blue focus:outline-none focus:ring-2 focus:ring-lifeone-blue/25';

function newIdempotencyKey() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `register-simple-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function SimpleRegisterPage() {
  const router = useRouter();
  const { register } = useAuth();
  const [ownerName, setOwnerName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const submissionLock = useRef(false);
  const idempotencyKey = useRef(newIdempotencyKey());

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  function validate(): string | null {
    if (ownerName.trim().length < 2) return 'Informe seu nome.';
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return 'Informe um email válido.';
    }
    if (password.length < 8) return 'Crie uma senha com pelo menos 8 caracteres.';
    return null;
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submissionLock.current) return;
    setError(null);
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    submissionLock.current = true;
    setSubmitting(true);
    try {
      // ponytail: auto-generate tenant and username from email to reduce fields
      const emailPrefix = email.trim().split('@')[0];
      const tenantName = ownerName.trim();
      const username = emailPrefix.length >= 3 ? emailPrefix : `user_${Date.now()}`;

      await register(
        {
          tenantName,
          ownerName: ownerName.trim(),
          email: email.trim(),
          username,
          password,
          projectTypes: [],
        },
        idempotencyKey.current,
      );
      // Skip objective selector and go directly to onboarding
      router.replace('/onboarding/setup?type=PESSOAL');
    } catch (caught) {
      if (caught instanceof ApiResponseError) idempotencyKey.current = newIdempotencyKey();
      setError(caught instanceof Error ? caught.message : 'Não foi possível criar sua conta. Tente novamente.');
    } finally {
      submissionLock.current = false;
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-lifeone-canvas px-4 py-6 font-geist sm:px-6 sm:py-10">
      <div className="mx-auto w-full max-w-md">
        <header className="mb-8 flex items-center justify-between gap-4">
          <LifeOneLogo compact />
          <Link href="/login" className="flex min-h-11 items-center rounded-[10px] px-3 text-[13px] font-semibold text-lifeone-blue hover:bg-white/60">
            Entrar
          </Link>
        </header>

        <div className="rounded-[22px] border border-lifeone-hairline bg-lifeone-card shadow-lifeone-card p-6 sm:p-8">
          <div className="mb-6">
            <h1 className="text-[28px] font-bold leading-tight text-lifeone-ink">Criar conta</h1>
            <p className="mt-2 text-[14px] text-lifeone-ink-3">Rápido e simples. Em três passos.</p>
          </div>

          <form onSubmit={handleSubmit} noValidate aria-busy={submitting} className="space-y-4">
            {error && (
              <div ref={errorRef} role="alert" tabIndex={-1} className="rounded-[10px] border border-[#FECDCA] bg-[#FEF3F2] px-3 py-2.5 text-[13px] text-[#B42318] outline-none focus:ring-2 focus:ring-[#B42318]/30">
                <strong className="block font-semibold">Revise o cadastro</strong>
                {error}
              </div>
            )}

            <div>
              <label htmlFor="ownerName" className="mb-1.5 block text-[12px] font-medium text-lifeone-ink-2">
                Seu nome
              </label>
              <input
                id="ownerName"
                name="ownerName"
                autoComplete="name"
                required
                minLength={2}
                value={ownerName}
                onChange={(event) => setOwnerName(event.target.value)}
                className={fieldClass}
                placeholder="Ex.: Ana Silva"
              />
            </div>

            <div>
              <label htmlFor="email" className="mb-1.5 block text-[12px] font-medium text-lifeone-ink-2">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className={fieldClass}
                placeholder="seu@email.com"
              />
            </div>

            <div>
              <label htmlFor="password" className="mb-1.5 block text-[12px] font-medium text-lifeone-ink-2">
                Senha (mínimo 8 caracteres)
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className={fieldClass}
                placeholder="••••••••"
              />
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="mt-6 flex min-h-11 w-full items-center justify-center rounded-[10px] bg-lifeone-blue px-4 py-3 text-[14px] font-semibold text-white shadow-lifeone-card transition-transform hover:brightness-95 active:scale-[0.99] disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none"
            >
              {submitting ? 'Criando sua LifeOne…' : 'Criar conta'}
            </button>
          </form>

          <p className="mt-4 text-center text-[12px] text-lifeone-ink-4">
            Já tem uma conta?{' '}
            <Link href="/login" className="font-semibold text-lifeone-blue hover:underline">
              Faça login
            </Link>
          </p>

          <div className="mt-6 border-t border-lifeone-hairline pt-6">
            <p className="text-center text-[11px] text-lifeone-ink-4">
              <Link href="/register" className="text-lifeone-blue hover:underline">
                Cadastro com mais opções
              </Link>
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
