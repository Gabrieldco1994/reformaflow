'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LifeOneLogo } from '@/components/LifeOneLogo';
import { useAuth } from '@/contexts/auth-context';
import { ApiResponseError } from '@/lib/api';

const fieldClass =
  'min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3.5 py-2.5 text-[14px] text-lifeone-ink placeholder:text-lifeone-ink-4 focus:border-lifeone-blue focus:outline-none focus:ring-2 focus:ring-lifeone-blue/25';

function newIdempotencyKey() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `register-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function RegisterPage() {
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

  function validate(): string | null {
    if (ownerName.trim().length < 2) return 'Informe seu nome.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'Informe um email válido.';
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
      await register(
        {
          ownerName: ownerName.trim(),
          email: email.trim(),
          password,
        },
        idempotencyKey.current,
      );
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
    <main className="min-h-screen bg-lifeone-canvas px-4 py-8 font-geist sm:px-6 sm:py-12">
      <div className="mx-auto w-full max-w-md">
        <header className="mb-8 flex items-center justify-between gap-4">
          <LifeOneLogo compact />
          <Link href="/login" className="flex min-h-11 items-center rounded-[10px] px-3 text-[13px] font-semibold text-lifeone-blue hover:bg-white/60">
            Entrar
          </Link>
        </header>

        <form onSubmit={handleSubmit} noValidate aria-busy={submitting} className="rounded-[22px] border border-lifeone-hairline bg-lifeone-card p-6 shadow-lifeone-card sm:p-8">
          <h1 className="text-[27px] font-bold leading-tight tracking-[-0.035em] text-lifeone-ink sm:text-[32px]">Criar conta grátis</h1>
          <p className="mt-2 text-[14px] leading-relaxed text-lifeone-ink-3">Saiba hoje se o mês fecha no azul.</p>

          {error && (
            <div ref={errorRef} role="alert" tabIndex={-1} className="mt-5 rounded-[10px] border border-[#FECDCA] bg-[#FEF3F2] px-3 py-2.5 text-[13px] text-[#B42318] outline-none focus:ring-2 focus:ring-[#B42318]/30">
              <strong className="block font-semibold">Revise o cadastro</strong>
              {error}
            </div>
          )}

          <div className="mt-6 space-y-4">
            <div>
              <label htmlFor="ownerName" className="mb-1.5 block text-[12px] font-medium text-lifeone-ink-2">Seu nome</label>
              <input id="ownerName" name="ownerName" autoComplete="name" required minLength={2} value={ownerName} onChange={(event) => setOwnerName(event.target.value)} className={fieldClass} />
            </div>
            <div>
              <label htmlFor="email" className="mb-1.5 block text-[12px] font-medium text-lifeone-ink-2">Email</label>
              <input id="email" name="email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} className={fieldClass} placeholder="seu@email.com" />
            </div>
            <div>
              <label htmlFor="password" className="mb-1.5 block text-[12px] font-medium text-lifeone-ink-2">Senha</label>
              <input id="password" name="password" type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} className={fieldClass} />
            </div>
          </div>

          <button type="submit" disabled={submitting} className="mt-6 flex min-h-11 w-full items-center justify-center rounded-[10px] bg-lifeone-blue px-4 py-3 text-[14px] font-semibold text-white shadow-lifeone-card transition-transform hover:brightness-95 active:scale-[0.99] disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none">
            {submitting ? 'Criando sua conta…' : 'Criar conta grátis'}
          </button>
        </form>
      </div>
    </main>
  );
}
