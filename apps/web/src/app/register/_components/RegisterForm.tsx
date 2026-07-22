'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/auth-context';
import { ApiResponseError } from '@/lib/api';

const fieldClass =
  'min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3.5 py-2.5 text-[14px] text-lifeone-ink placeholder:text-lifeone-ink-4 focus:border-lifeone-blue focus:outline-none focus:ring-2 focus:ring-lifeone-blue/25';

function newIdempotencyKey() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `register-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function RegisterForm() {
  const router = useRouter();
  const { register } = useAuth();
  const [ownerName, setOwnerName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
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
    <form onSubmit={handleSubmit} noValidate aria-busy={submitting} className="rounded-[22px] border border-lifeone-hairline bg-lifeone-card p-6 shadow-lifeone-card sm:p-8">
      <h1 className="text-[27px] font-bold leading-tight tracking-[-0.035em] text-lifeone-ink sm:text-[32px]">Criar conta grátis</h1>
      <p className="mt-2 text-[14px] leading-relaxed text-lifeone-ink-3">Leva menos de 1 minuto.</p>

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
          <div className="relative">
            <input id="password" name="password" type={showPassword ? 'text' : 'password'} autoComplete="new-password" required minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} className={fieldClass} />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-lifeone-ink-3 hover:text-lifeone-ink-2"
              aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
            >
              {showPassword ? (
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
              ) : (
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-4.803m5.596-3.856a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.921 17.921l2.121-2.121m-6.042-6.042L5.586 3.586M3 21h18" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>

      <button type="submit" disabled={submitting} className="mt-6 flex min-h-11 w-full items-center justify-center rounded-[10px] bg-lifeone-blue px-4 py-3 text-[14px] font-semibold text-white shadow-lifeone-card transition-transform hover:brightness-95 active:scale-[0.99] disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none">
        {submitting ? 'Criando sua conta…' : 'Criar minha conta grátis'}
      </button>
    </form>
  );
}
