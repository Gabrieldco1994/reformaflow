'use client';

import { useCallback, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CreditCard, Landmark, SkipForward, X } from 'lucide-react';
import BankAccountFormModal from '@/app/projects/[projectId]/bank-accounts/_components/BankAccountFormModal';
import CardFormModal from '@/app/projects/[projectId]/credit-cards/_components/CardFormModal';
import { api } from '@/lib/api';
import type { OnboardingStepProps, OnboardingFunding } from '../../_types';

interface TenantAccount { id: string; nickname?: string | null; institution: string; last4?: string | null }
interface TenantCard { id: string; nickname?: string | null; brand: string; last4: string }

type MiniAreaMode = 'idle' | 'selecting' | 'creating';

interface MiniAreaState {
  mode: MiniAreaMode;
  selectedId: string | null;
}

function accountLabel(a: TenantAccount) {
  return a.nickname || `${a.institution}${a.last4 ? ` ••${a.last4}` : ''}`;
}
function cardLabel(c: TenantCard) {
  return c.nickname || `${c.brand} ••${c.last4}`;
}

/**
 * Passo unificado Contas & cartões (substitui os antigos passos `bank` e `card`).
 * Duas miniáreas independentes; salvar uma não avança o wizard.
 * Um único Continuar + um único Pular.
 */
export function FundingStep({
  projectId,
  onDone,
  onSkip,
  onFundingChange,
  subtitle,
  stepRequired = false,
}: OnboardingStepProps) {
  const qc = useQueryClient();

  const { data: accounts = [] } = useQuery<TenantAccount[]>({
    queryKey: ['tenant', 'bank-accounts'],
    queryFn: () => api.get('/tenant/bank-accounts'),
    staleTime: 30_000,
  });
  const { data: cards = [] } = useQuery<TenantCard[]>({
    queryKey: ['tenant', 'credit-cards'],
    queryFn: () => api.get('/tenant/credit-cards'),
    staleTime: 30_000,
  });

  const [bank, setBank] = useState<MiniAreaState>({ mode: 'idle', selectedId: null });
  const [card, setCard] = useState<MiniAreaState>({ mode: 'idle', selectedId: null });

  // Guard against double-click on Continuar
  const continuarCalled = useRef(false);

  const hasFunding = bank.selectedId !== null || card.selectedId !== null;
  const canContinue = !stepRequired || hasFunding;

  const buildFunding = useCallback(
    (bankId: string | null, cardId: string | null): OnboardingFunding => ({
      bankAccount: bankId
        ? { kind: 'bankAccount', id: bankId, ownerProjectId: projectId, origin: 'created' }
        : null,
      creditCard: cardId
        ? { kind: 'creditCard', id: cardId, ownerProjectId: projectId, origin: 'created' }
        : null,
    }),
    [projectId],
  );

  function handleBankSaved(id: string) {
    qc.invalidateQueries({ queryKey: ['tenant', 'bank-accounts'] });
    setBank({ mode: 'idle', selectedId: id });
    onFundingChange?.(buildFunding(id, card.selectedId));
  }

  function handleCardSaved(id: string) {
    qc.invalidateQueries({ queryKey: ['tenant', 'credit-cards'] });
    setCard({ mode: 'idle', selectedId: id });
    onFundingChange?.(buildFunding(bank.selectedId, id));
  }

  function selectBankExisting(id: string) {
    setBank({ mode: 'idle', selectedId: id });
    onFundingChange?.(buildFunding(id, card.selectedId));
  }

  function selectCardExisting(id: string) {
    setCard({ mode: 'idle', selectedId: id });
    onFundingChange?.(buildFunding(bank.selectedId, id));
  }

  function handleContinuar() {
    if (continuarCalled.current) return;
    continuarCalled.current = true;
    onFundingChange?.(buildFunding(bank.selectedId, card.selectedId));
    onDone();
  }

  const bankAccount = accounts.find((a) => a.id === bank.selectedId);
  const creditCard = cards.find((c) => c.id === card.selectedId);

  return (
    <section className="rounded-[18px] border border-lifeone-hairline bg-lifeone-card p-6 shadow-lifeone-card">
      <h2 className="text-[18px] font-bold text-lifeone-ink">Contas &amp; cartões</h2>
      <p className="mb-5 text-[13px] text-lifeone-ink-3">{subtitle || 'Adicione um dos dois, ou os dois.'}</p>

      {/* ─── Mini-área: Conta bancária ─────────────────────────────────── */}
      <div className="mb-4 rounded-[12px] border border-lifeone-hairline bg-lifeone-surface p-4">
        <div className="mb-2 flex items-center gap-1.5">
          <Landmark className="h-4 w-4 text-lifeone-ink-3" />
          <span className="text-[13px] font-semibold text-lifeone-ink">Conta bancária</span>
          {bank.selectedId && (
            <span className="ml-auto flex items-center gap-1 text-[12px] text-green-600">
              <Check className="h-3.5 w-3.5" /> Adicionada
            </span>
          )}
        </div>

        {bank.selectedId && bankAccount ? (
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-lifeone-ink">{accountLabel(bankAccount)}</span>
            <button
              type="button"
              onClick={() => setBank({ mode: 'idle', selectedId: null })}
              className="ml-2 text-lifeone-ink-4 hover:text-lifeone-ink"
              aria-label="Remover conta"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : bank.mode === 'creating' ? (
          <BankAccountFormModal
            projectId={projectId}
            account={null}
            onClose={() => setBank((s) => ({ ...s, mode: 'idle' }))}
            onSaved={handleBankSaved}
            bare
            hideCancel
          />
        ) : bank.mode === 'selecting' && accounts.length > 0 ? (
          <div className="space-y-1.5">
            <p className="text-[12px] text-lifeone-ink-3">Selecione uma conta:</p>
            {accounts.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => selectBankExisting(a.id)}
                className="flex min-h-11 w-full items-center gap-2 rounded-[8px] border border-lifeone-hairline bg-white px-3 py-2 text-[13px] text-lifeone-ink hover:bg-lifeone-hairline/60 transition-colors"
              >
                {accountLabel(a)}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setBank({ mode: 'creating', selectedId: null })}
              className="text-[12px] text-lifeone-blue hover:underline"
            >
              + Nova conta
            </button>
          </div>
        ) : (
          <div className="flex gap-2">
            {accounts.length > 0 && (
              <button
                type="button"
                onClick={() => setBank({ mode: 'selecting', selectedId: null })}
                className="flex-1 min-h-10 rounded-[8px] border border-lifeone-hairline bg-white px-3 py-2 text-[12px] text-lifeone-ink hover:bg-lifeone-hairline/60 transition-colors"
              >
                Selecionar existente
              </button>
            )}
            <button
              type="button"
              onClick={() => setBank({ mode: 'creating', selectedId: null })}
              className="flex-1 min-h-10 rounded-[8px] border border-lifeone-blue bg-lifeone-blue/5 px-3 py-2 text-[12px] font-medium text-lifeone-blue hover:bg-lifeone-blue/10 transition-colors"
            >
              + Nova conta
            </button>
          </div>
        )}
      </div>

      {/* ─── Mini-área: Cartão ─────────────────────────────────────────── */}
      <div className="mb-5 rounded-[12px] border border-lifeone-hairline bg-lifeone-surface p-4">
        <div className="mb-2 flex items-center gap-1.5">
          <CreditCard className="h-4 w-4 text-lifeone-ink-3" />
          <span className="text-[13px] font-semibold text-lifeone-ink">Cartão de crédito</span>
          {card.selectedId && (
            <span className="ml-auto flex items-center gap-1 text-[12px] text-green-600">
              <Check className="h-3.5 w-3.5" /> Adicionado
            </span>
          )}
        </div>

        {card.selectedId && creditCard ? (
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-lifeone-ink">{cardLabel(creditCard)}</span>
            <button
              type="button"
              onClick={() => setCard({ mode: 'idle', selectedId: null })}
              className="ml-2 text-lifeone-ink-4 hover:text-lifeone-ink"
              aria-label="Remover cartão"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : card.mode === 'creating' ? (
          <CardFormModal
            projectId={projectId}
            card={null}
            onClose={() => setCard((s) => ({ ...s, mode: 'idle' }))}
            onSaved={handleCardSaved}
            bare
            hideCancel
          />
        ) : card.mode === 'selecting' && cards.length > 0 ? (
          <div className="space-y-1.5">
            <p className="text-[12px] text-lifeone-ink-3">Selecione um cartão:</p>
            {cards.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => selectCardExisting(c.id)}
                className="flex min-h-11 w-full items-center gap-2 rounded-[8px] border border-lifeone-hairline bg-white px-3 py-2 text-[13px] text-lifeone-ink hover:bg-lifeone-hairline/60 transition-colors"
              >
                {cardLabel(c)}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setCard({ mode: 'creating', selectedId: null })}
              className="text-[12px] text-lifeone-blue hover:underline"
            >
              + Novo cartão
            </button>
          </div>
        ) : (
          <div className="flex gap-2">
            {cards.length > 0 && (
              <button
                type="button"
                onClick={() => setCard({ mode: 'selecting', selectedId: null })}
                className="flex-1 min-h-10 rounded-[8px] border border-lifeone-hairline bg-white px-3 py-2 text-[12px] text-lifeone-ink hover:bg-lifeone-hairline/60 transition-colors"
              >
                Selecionar existente
              </button>
            )}
            <button
              type="button"
              onClick={() => setCard({ mode: 'creating', selectedId: null })}
              className="flex-1 min-h-10 rounded-[8px] border border-lifeone-blue bg-lifeone-blue/5 px-3 py-2 text-[12px] font-medium text-lifeone-blue hover:bg-lifeone-blue/10 transition-colors"
            >
              + Novo cartão
            </button>
          </div>
        )}
      </div>

      {/* ─── Único Continuar + único Pular ────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={handleContinuar}
          disabled={!canContinue}
          className="flex min-h-11 w-full items-center justify-center rounded-[10px] bg-lifeone-blue px-4 py-3 text-[14px] font-semibold text-white hover:brightness-95 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
        >
          Continuar
        </button>
        {stepRequired && !hasFunding && (
          <p className="text-center text-[12px] text-lifeone-ink-3">
            Selecione ou cadastre ao menos uma fonte para continuar.
          </p>
        )}
        {!stepRequired && (
          <button
            type="button"
            onClick={onSkip}
            className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-4 py-3 text-[13px] font-medium text-lifeone-ink-2 hover:bg-lifeone-hairline/60 transition-colors"
          >
            <SkipForward className="h-3.5 w-3.5" /> Pular por agora
          </button>
        )}
      </div>
    </section>
  );
}
