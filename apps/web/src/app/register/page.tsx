'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LifeOneLogo } from '@/components/LifeOneLogo';
import { ObjectiveSelector } from '@/components/objectives/ObjectiveSelector';
import type { ObjectiveType } from '@/components/objectives/objective-options';
import { useAuth } from '@/contexts/auth-context';
import { ApiResponseError } from '@/lib/api';
import { pickPrimaryProjectType } from '@/app/onboarding/setup/_lib/primary-project-type';

const fieldClass =
  'min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3.5 py-2.5 text-[14px] text-lifeone-ink placeholder:text-lifeone-ink-4 focus:border-lifeone-blue focus:outline-none focus:ring-2 focus:ring-lifeone-blue/25';

function newIdempotencyKey() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `register-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function RegisterPage() {
  const router = useRouter();
  const { register } = useAuth();
  const [tenantName, setTenantName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirmation, setPasswordConfirmation] = useState('');
  const [projectTypes, setProjectTypes] = useState<ObjectiveType[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const submissionLock = useRef(false);
  const idempotencyKey = useRef(newIdempotencyKey());

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  function validate(): string | null {
    if (tenantName.trim().length < 3) return 'Informe um nome para seu espaço com pelo menos 3 caracteres.';
    if (ownerName.trim().length < 2) return 'Informe seu nome.';
    if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username.trim())) {
      return 'O usuário deve ter de 3 a 40 caracteres: letras, números, ponto, hífen ou sublinhado.';
    }
    if (password.length < 8) return 'Crie uma senha com pelo menos 8 caracteres.';
    if (password !== passwordConfirmation) return 'As senhas não coincidem.';
    if (projectTypes.length < 1) return 'Selecione pelo menos um objetivo.';
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
          tenantName: tenantName.trim(),
          ownerName: ownerName.trim(),
          username: username.trim(),
          password,
          projectTypes,
        },
        idempotencyKey.current,
      );
      // Guided per-type wizard: pick a single primary type (PESSOAL priority,
      // then canonical OBJECTIVE_TYPES order) and route it through the
      // generic onboarding wizard shell.
      const primary = pickPrimaryProjectType(projectTypes);
      router.replace(primary ? `/onboarding/setup?type=${primary}` : '/projects?onboarding=1');
    } catch (caught) {
      if (caught instanceof ApiResponseError) idempotencyKey.current = newIdempotencyKey();
      setError(caught instanceof Error ? caught.message : 'Não foi possível criar sua conta. Tente novamente.');
    } finally {
      submissionLock.current = false;
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen overflow-x-hidden bg-lifeone-canvas px-4 py-6 font-geist sm:px-6 sm:py-10">
      <div className="mx-auto w-full max-w-5xl">
        <header className="mb-6 flex items-center justify-between gap-4">
          <LifeOneLogo compact />
          <Link href="/login" className="flex min-h-11 items-center rounded-[10px] px-3 text-[13px] font-semibold text-lifeone-blue hover:bg-white/60">
            Já tenho conta
          </Link>
        </header>

        <form onSubmit={handleSubmit} noValidate aria-busy={submitting} className="grid min-w-0 overflow-hidden rounded-[22px] border border-lifeone-hairline bg-lifeone-card shadow-lifeone-card lg:grid-cols-[0.82fr_1.18fr]">
          <section className="min-w-0 border-b border-lifeone-hairline p-5 sm:p-8 lg:border-b-0 lg:border-r">
            <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-lifeone-blue">Sua LifeOne começa aqui</p>
            <h1 className="mt-2 text-[27px] font-bold leading-tight tracking-[-0.035em] text-lifeone-ink sm:text-[34px]">Uma conta para seus próximos objetivos.</h1>
            <p className="mt-3 text-[14px] leading-relaxed text-lifeone-ink-3">Crie seu espaço, escolha o que importa agora e entre pronto para nomear o primeiro projeto.</p>

            {error && (
              <div ref={errorRef} role="alert" tabIndex={-1} className="mt-5 rounded-[10px] border border-[#FECDCA] bg-[#FEF3F2] px-3 py-2.5 text-[13px] text-[#B42318] outline-none focus:ring-2 focus:ring-[#B42318]/30">
                <strong className="block font-semibold">Revise o cadastro</strong>
                {error}
              </div>
            )}

            <div className="mt-6 space-y-4">
              <div>
                <label htmlFor="tenantName" className="mb-1.5 block text-[12px] font-medium text-lifeone-ink-2">Nome do seu espaço</label>
                <input id="tenantName" name="tenantName" autoComplete="organization" required minLength={3} value={tenantName} onChange={(event) => setTenantName(event.target.value)} className={fieldClass} placeholder="Ex.: Vida da Ana" />
              </div>
              <div>
                <label htmlFor="ownerName" className="mb-1.5 block text-[12px] font-medium text-lifeone-ink-2">Seu nome</label>
                <input id="ownerName" name="ownerName" autoComplete="name" required minLength={2} value={ownerName} onChange={(event) => setOwnerName(event.target.value)} className={fieldClass} />
              </div>
              <div>
                <label htmlFor="username" className="mb-1.5 block text-[12px] font-medium text-lifeone-ink-2">Usuário</label>
                <input id="username" name="username" autoComplete="username" required minLength={3} maxLength={40} value={username} onChange={(event) => setUsername(event.target.value)} className={fieldClass} />
              </div>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                <div>
                  <label htmlFor="password" className="mb-1.5 block text-[12px] font-medium text-lifeone-ink-2">Senha</label>
                  <input id="password" name="password" type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} className={fieldClass} />
                </div>
                <div>
                  <label htmlFor="passwordConfirmation" className="mb-1.5 block text-[12px] font-medium text-lifeone-ink-2">Confirmar senha</label>
                  <input id="passwordConfirmation" name="passwordConfirmation" type="password" autoComplete="new-password" required minLength={8} value={passwordConfirmation} onChange={(event) => setPasswordConfirmation(event.target.value)} className={fieldClass} />
                </div>
              </div>
            </div>
          </section>

          <section className="min-w-0 bg-lifeone-surface/50 p-5 sm:p-8">
            <ObjectiveSelector selected={projectTypes} onChange={setProjectTypes} disabled={submitting} />
            <button type="submit" disabled={submitting} className="mt-6 flex min-h-11 w-full items-center justify-center rounded-[10px] bg-lifeone-blue px-4 py-3 text-[14px] font-semibold text-white shadow-lifeone-card transition-transform hover:brightness-95 active:scale-[0.99] disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none">
              {submitting ? 'Criando sua LifeOne…' : 'Criar conta e continuar'}
            </button>
            <p className="mt-3 text-center text-[11px] leading-relaxed text-lifeone-ink-4">Seus objetivos controlam quais tipos de projeto ficam disponíveis.</p>
          </section>
        </form>
      </div>
    </main>
  );
}
