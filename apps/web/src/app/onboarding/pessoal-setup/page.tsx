'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/contexts/auth-context';
import { LifeOneLogo } from '@/components/LifeOneLogo';
import { maskCurrencyInput, currencyInputToCents } from '@/lib/currency-input';
import { ArrowRight, Building2, CreditCard, CheckCircle2, SkipForward, AlertTriangle } from 'lucide-react';

/**
 * Guided "do zero" onboarding for new users.
 * 
 * Flow:
 * 1. Auto-creates the PESSOAL project (name editable)
 * 2. Bank-account step (openingBalance = hero number anchor)
 * 3. Credit-card step (closingDay/dueDay = invoice features)
 * 4. Land on Cockpit
 * 
 * Reuses existing API endpoints — no new backend logic.
 */

const INSTITUTIONS = [
  { value: 'ITAU', label: 'Itaú' },
  { value: 'NUBANK', label: 'Nubank' },
  { value: 'BRADESCO', label: 'Bradesco' },
  { value: 'SANTANDER', label: 'Santander' },
  { value: 'BB', label: 'Banco do Brasil' },
  { value: 'CAIXA', label: 'Caixa' },
  { value: 'INTER', label: 'Inter' },
  { value: 'C6', label: 'C6' },
  { value: 'XP', label: 'XP' },
  { value: 'OUTRO', label: 'Outro' },
];

const BRANDS = ['Visa', 'Mastercard', 'Elo', 'Amex', 'Hipercard'];

type Step = 'project' | 'bank' | 'card' | 'done';

export default function PessoalSetupPage() {
  const router = useRouter();
  const { user, refresh } = useAuth();
  const [step, setStep] = useState<Step>('project');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState('Minha vida financeira');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createdRef = useRef(false);

  // --- Step 1: Auto-create PESSOAL project ---
  const createProject = useCallback(async () => {
    if (createdRef.current) return;
    createdRef.current = true;
    setCreating(true);
    setError(null);
    try {
      const project = await api.post<{ id: string }>('/projects', {
        name: projectName.trim() || 'Minha vida financeira',
        type: 'PESSOAL',
      });
      setProjectId(project.id);
      await refresh();
      setStep('bank');
    } catch (e) {
      createdRef.current = false;
      setError(e instanceof Error ? e.message : 'Erro ao criar projeto');
    } finally {
      setCreating(false);
    }
  }, [projectName, refresh]);

  // --- Bank account state ---
  const [bankInstitution, setBankInstitution] = useState('NUBANK');
  const [bankNickname, setBankNickname] = useState('');
  const [bankLast4, setBankLast4] = useState('');
  const [openingBalance, setOpeningBalance] = useState('');
  const [bankSaving, setBankSaving] = useState(false);
  const [bankError, setBankError] = useState<string | null>(null);
  const [showSkipWarning, setShowSkipWarning] = useState(false);

  async function handleSaveBank() {
    if (!projectId) return;
    if (!/^\d{4}$/.test(bankLast4)) {
      setBankError('Informe os 4 últimos dígitos da conta');
      return;
    }
    setBankSaving(true);
    setBankError(null);
    try {
      const body: Record<string, unknown> = {
        institution: bankInstitution,
        last4: bankLast4,
      };
      if (bankNickname.trim()) body.nickname = bankNickname.trim();
      body.openingBalanceCents = openingBalance ? currencyInputToCents(openingBalance) : 0;
      body.openingBalanceDate = new Date().toISOString();
      await api.post(`/projects/${projectId}/bank-accounts`, body);
      setStep('card');
    } catch (e) {
      setBankError(e instanceof Error ? e.message : 'Erro ao salvar conta');
    } finally {
      setBankSaving(false);
    }
  }

  // --- Credit card state ---
  const [cardInstitution, setCardInstitution] = useState('NUBANK');
  const [cardBrand, setCardBrand] = useState('Visa');
  const [cardNickname, setCardNickname] = useState('');
  const [cardLast4, setCardLast4] = useState('');
  const [closingDay, setClosingDay] = useState('');
  const [dueDay, setDueDay] = useState('');
  const [cardSaving, setCardSaving] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);

  async function handleSaveCard() {
    if (!projectId) return;
    if (!/^\d{4}$/.test(cardLast4)) {
      setCardError('Informe os 4 últimos dígitos do cartão');
      return;
    }
    if (!closingDay) {
      setCardError('Informe o dia de fechamento para evitar o estado "configurar"');
      return;
    }
    setCardSaving(true);
    setCardError(null);
    try {
      const body: Record<string, unknown> = {
        institution: cardInstitution,
        brand: cardBrand,
        last4: cardLast4,
      };
      if (cardNickname.trim()) body.nickname = cardNickname.trim();
      if (closingDay) body.closingDay = parseInt(closingDay, 10);
      if (dueDay) body.dueDay = parseInt(dueDay, 10);
      await api.post(`/projects/${projectId}/credit-cards`, body);
      setStep('done');
    } catch (e) {
      setCardError(e instanceof Error ? e.message : 'Erro ao salvar cartão');
    } finally {
      setCardSaving(false);
    }
  }

  // --- Redirect to Cockpit on done ---
  useEffect(() => {
    if (step === 'done' && projectId) {
      const timer = setTimeout(() => {
        router.replace(`/projects/${projectId}/monthly`);
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [step, projectId, router]);

  // Stepper progress indicator
  const steps: { key: Step; label: string }[] = [
    { key: 'project', label: 'Projeto' },
    { key: 'bank', label: 'Conta' },
    { key: 'card', label: 'Cartão' },
    { key: 'done', label: 'Pronto' },
  ];
  const currentIdx = steps.findIndex((s) => s.key === step);

  return (
    <main className="min-h-screen bg-lifeone-canvas px-4 py-6 font-geist sm:px-6 sm:py-10">
      <div className="mx-auto w-full max-w-lg">
        <header className="mb-8 flex items-center justify-between">
          <LifeOneLogo compact />
          <span className="text-[12px] font-medium text-lifeone-ink-3">Começando do zero</span>
        </header>

        {/* Stepper dots */}
        <div className="mb-8 flex items-center justify-center gap-2" aria-label="Progresso do setup">
          {steps.map((s, i) => (
            <div key={s.key} className="flex items-center gap-2">
              <div
                className={`flex h-8 w-8 items-center justify-center rounded-full text-[12px] font-bold transition-colors ${
                  i < currentIdx
                    ? 'bg-lifeone-blue text-white'
                    : i === currentIdx
                      ? 'border-2 border-lifeone-blue bg-white text-lifeone-blue'
                      : 'border border-lifeone-hairline bg-lifeone-surface text-lifeone-ink-4'
                }`}
              >
                {i < currentIdx ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
              </div>
              {i < steps.length - 1 && (
                <div className={`h-0.5 w-6 sm:w-10 ${i < currentIdx ? 'bg-lifeone-blue' : 'bg-lifeone-hairline'}`} />
              )}
            </div>
          ))}
        </div>

        {/* --- STEP: Project creation --- */}
        {step === 'project' && (
          <section className="rounded-[18px] border border-lifeone-hairline bg-lifeone-card p-6 shadow-lifeone-card">
            <h2 className="text-[20px] font-bold text-lifeone-ink">Seu projeto financeiro pessoal</h2>
            <p className="mt-2 text-[14px] text-lifeone-ink-3">
              Vamos criar o projeto que centraliza seu dinheiro — contas, cartões, receitas e despesas do dia a dia.
            </p>
            <div className="mt-5">
              <label htmlFor="projectName" className="mb-1.5 block text-[12px] font-medium text-lifeone-ink-2">
                Nome do projeto
              </label>
              <input
                id="projectName"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="Minha vida financeira"
                className="min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3.5 py-2.5 text-[14px] text-lifeone-ink placeholder:text-lifeone-ink-4 focus:border-lifeone-blue focus:outline-none focus:ring-2 focus:ring-lifeone-blue/25"
              />
            </div>
            {error && (
              <p className="mt-3 text-[13px] text-[#B42318]">{error}</p>
            )}
            <button
              onClick={createProject}
              disabled={creating}
              className="mt-6 flex min-h-11 w-full items-center justify-center gap-2 rounded-[10px] bg-lifeone-blue px-4 py-3 text-[14px] font-semibold text-white shadow-lifeone-card transition-transform hover:brightness-95 active:scale-[0.99] disabled:cursor-wait disabled:opacity-60"
            >
              {creating ? 'Criando…' : 'Criar e continuar'}
              {!creating && <ArrowRight className="h-4 w-4" />}
            </button>
          </section>
        )}

        {/* --- STEP: Bank account --- */}
        {step === 'bank' && (
          <section className="rounded-[18px] border border-lifeone-hairline bg-lifeone-card p-6 shadow-lifeone-card">
            <div className="mb-4 flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-[#E8F5EE] text-[#1E924A]">
                <Building2 className="h-5 w-5" />
              </span>
              <div>
                <h2 className="text-[18px] font-bold text-lifeone-ink">Sua conta bancária</h2>
                <p className="text-[13px] text-lifeone-ink-3">A base do Caixa Real no cockpit</p>
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-[12px] font-medium text-lifeone-ink-2">Banco</label>
                <select
                  value={bankInstitution}
                  onChange={(e) => setBankInstitution(e.target.value)}
                  className="min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3 py-2.5 text-[14px]"
                >
                  {INSTITUTIONS.map((i) => <option key={i.value} value={i.value}>{i.label}</option>)}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[12px] font-medium text-lifeone-ink-2">Apelido (opcional)</label>
                <input
                  value={bankNickname}
                  onChange={(e) => setBankNickname(e.target.value)}
                  placeholder="Ex: Nubank Conta Corrente"
                  className="min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3.5 py-2.5 text-[14px] placeholder:text-lifeone-ink-4 focus:border-lifeone-blue focus:outline-none focus:ring-2 focus:ring-lifeone-blue/25"
                />
              </div>
              <div>
                <label className="mb-1 block text-[12px] font-medium text-lifeone-ink-2">Últimos 4 dígitos</label>
                <input
                  value={bankLast4}
                  onChange={(e) => setBankLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  placeholder="1234"
                  maxLength={4}
                  inputMode="numeric"
                  className="min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3.5 py-2.5 text-[14px] font-mono placeholder:text-lifeone-ink-4 focus:border-lifeone-blue focus:outline-none focus:ring-2 focus:ring-lifeone-blue/25"
                />
              </div>

              {/* Opening balance — the hero field */}
              <div className="rounded-[12px] border-2 border-lifeone-blue/30 bg-[#EFF6FF] p-4">
                <p className="text-[13px] font-semibold text-lifeone-ink">Quanto você tem na conta hoje?</p>
                <p className="mt-1 text-[11px] text-lifeone-ink-3">
                  É o ponto de partida do Caixa Real — o número que bate com seu extrato bancário.
                </p>
                <input
                  value={openingBalance}
                  onChange={(e) => setOpeningBalance(maskCurrencyInput(e.target.value))}
                  placeholder="5.000,00"
                  inputMode="numeric"
                  className="mt-2.5 min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-white px-3.5 py-2.5 text-[16px] font-semibold font-mono text-lifeone-ink placeholder:text-lifeone-ink-4 focus:border-lifeone-blue focus:outline-none focus:ring-2 focus:ring-lifeone-blue/25"
                />
              </div>
            </div>

            {bankError && <p className="mt-3 text-[13px] text-[#B42318]">{bankError}</p>}

            <div className="mt-5 flex flex-col gap-2">
              <button
                onClick={handleSaveBank}
                disabled={bankSaving}
                className="flex min-h-11 w-full items-center justify-center gap-2 rounded-[10px] bg-lifeone-blue px-4 py-3 text-[14px] font-semibold text-white hover:brightness-95 active:scale-[0.99] disabled:cursor-wait disabled:opacity-60"
              >
                {bankSaving ? 'Salvando…' : 'Salvar e continuar'}
                {!bankSaving && <ArrowRight className="h-4 w-4" />}
              </button>

              {!showSkipWarning ? (
                <button
                  onClick={() => setShowSkipWarning(true)}
                  className="flex min-h-11 items-center justify-center gap-1.5 text-[13px] text-lifeone-ink-3 hover:text-lifeone-ink"
                >
                  <SkipForward className="h-3.5 w-3.5" /> Pular por agora
                </button>
              ) : (
                <div className="rounded-[10px] border border-[#FECDCA] bg-[#FEF3F2] p-3">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-[#B42318]" />
                    <div>
                      <p className="text-[12px] font-semibold text-[#B42318]">Sem o saldo, o Caixa não bate com o banco</p>
                      <p className="mt-0.5 text-[11px] text-[#7A271A]">
                        O cockpit vai mostrar apenas o fluxo realizado (entradas − saídas), não o saldo real da conta.
                        Você pode definir depois em Contas Bancárias.
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => setStep('card')}
                    className="mt-2 flex min-h-9 items-center justify-center gap-1 rounded-[8px] border border-[#FECDCA] px-3 py-1.5 text-[12px] font-medium text-[#B42318] hover:bg-[#FEE4E2]"
                  >
                    <SkipForward className="h-3 w-3" /> Pular mesmo assim
                  </button>
                </div>
              )}
            </div>
          </section>
        )}

        {/* --- STEP: Credit card --- */}
        {step === 'card' && (
          <section className="rounded-[18px] border border-lifeone-hairline bg-lifeone-card p-6 shadow-lifeone-card">
            <div className="mb-4 flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-[#EDE9FE] text-[#7C3AED]">
                <CreditCard className="h-5 w-5" />
              </span>
              <div>
                <h2 className="text-[18px] font-bold text-lifeone-ink">Seus cartões de crédito</h2>
                <p className="text-[13px] text-lifeone-ink-3">Opcional — pule se preferir cadastrar depois</p>
              </div>
            </div>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-[12px] font-medium text-lifeone-ink-2">Banco</label>
                  <select
                    value={cardInstitution}
                    onChange={(e) => setCardInstitution(e.target.value)}
                    className="min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3 py-2.5 text-[14px]"
                  >
                    {INSTITUTIONS.map((i) => <option key={i.value} value={i.value}>{i.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-[12px] font-medium text-lifeone-ink-2">Bandeira</label>
                  <select
                    value={cardBrand}
                    onChange={(e) => setCardBrand(e.target.value)}
                    className="min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3 py-2.5 text-[14px]"
                  >
                    {BRANDS.map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="mb-1 block text-[12px] font-medium text-lifeone-ink-2">Apelido (opcional)</label>
                <input
                  value={cardNickname}
                  onChange={(e) => setCardNickname(e.target.value)}
                  placeholder="Ex: Nubank Roxo"
                  className="min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3.5 py-2.5 text-[14px] placeholder:text-lifeone-ink-4 focus:border-lifeone-blue focus:outline-none focus:ring-2 focus:ring-lifeone-blue/25"
                />
              </div>
              <div>
                <label className="mb-1 block text-[12px] font-medium text-lifeone-ink-2">Últimos 4 dígitos</label>
                <input
                  value={cardLast4}
                  onChange={(e) => setCardLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  placeholder="5678"
                  maxLength={4}
                  inputMode="numeric"
                  className="min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3.5 py-2.5 text-[14px] font-mono placeholder:text-lifeone-ink-4 focus:border-lifeone-blue focus:outline-none focus:ring-2 focus:ring-lifeone-blue/25"
                />
              </div>

              {/* Closing/due day — the key fields */}
              <div className="rounded-[12px] border-2 border-[#7C3AED]/20 bg-[#F5F3FF] p-4">
                <p className="text-[13px] font-semibold text-lifeone-ink">Dias de fechamento e vencimento</p>
                <p className="mt-1 text-[11px] text-lifeone-ink-3">
                  É o que permite calcular suas faturas corretamente e prever saídas do mês.
                </p>
                <div className="mt-2.5 grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-[11px] text-lifeone-ink-3">Dia fechamento</label>
                    <input
                      type="number"
                      value={closingDay}
                      onChange={(e) => setClosingDay(e.target.value)}
                      placeholder="25"
                      min={1}
                      max={31}
                      className="min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-white px-3.5 py-2.5 text-[14px] font-mono focus:border-lifeone-blue focus:outline-none focus:ring-2 focus:ring-lifeone-blue/25"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] text-lifeone-ink-3">Dia vencimento</label>
                    <input
                      type="number"
                      value={dueDay}
                      onChange={(e) => setDueDay(e.target.value)}
                      placeholder="10"
                      min={1}
                      max={31}
                      className="min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-white px-3.5 py-2.5 text-[14px] font-mono focus:border-lifeone-blue focus:outline-none focus:ring-2 focus:ring-lifeone-blue/25"
                    />
                  </div>
                </div>
              </div>
            </div>

            {cardError && <p className="mt-3 text-[13px] text-[#B42318]">{cardError}</p>}

            <div className="mt-5 flex flex-col gap-2">
              <button
                onClick={handleSaveCard}
                disabled={cardSaving}
                className="flex min-h-11 w-full items-center justify-center gap-2 rounded-[10px] bg-lifeone-blue px-4 py-3 text-[14px] font-semibold text-white hover:brightness-95 active:scale-[0.99] disabled:cursor-wait disabled:opacity-60"
              >
                {cardSaving ? 'Salvando…' : 'Salvar e finalizar'}
                {!cardSaving && <ArrowRight className="h-4 w-4" />}
              </button>
              <button
                onClick={() => setStep('done')}
                className="flex min-h-11 items-center justify-center gap-1.5 text-[13px] text-lifeone-ink-3 hover:text-lifeone-ink"
              >
                <SkipForward className="h-3.5 w-3.5" /> Pular — cadastro depois
              </button>
            </div>
          </section>
        )}

        {/* --- STEP: Done --- */}
        {step === 'done' && (
          <section className="rounded-[18px] border border-lifeone-hairline bg-lifeone-card p-8 shadow-lifeone-card text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[#E8F5EE]">
              <CheckCircle2 className="h-8 w-8 text-[#1E924A]" />
            </div>
            <h2 className="mt-4 text-[22px] font-bold text-lifeone-ink">Tudo pronto!</h2>
            <p className="mt-2 text-[14px] text-lifeone-ink-3">
              Seu Cockpit financeiro está configurado. Levando você para a visão do mês…
            </p>
            <div className="mt-4 flex justify-center">
              <div className="h-1 w-24 overflow-hidden rounded-full bg-lifeone-hairline">
                <div className="h-full animate-pulse rounded-full bg-lifeone-blue" style={{ width: '60%' }} />
              </div>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
