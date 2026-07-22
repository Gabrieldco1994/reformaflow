'use client';

import { useState } from 'react';
import type { ComponentType } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SkipForward, CreditCard, Landmark, ArrowRight } from 'lucide-react';
import { api } from '@/lib/api';
import ImportStatementModal from '@/app/projects/[projectId]/credit-cards/_components/ImportStatementModal';
import ImportBankStatementModal from '@/app/projects/[projectId]/bank-accounts/_components/ImportBankStatementModal';
import { SemCartaoEmptyState } from '@/app/projects/[projectId]/_components/SemCartaoEmptyState';
import type { CardRow } from '@/app/projects/[projectId]/credit-cards/_types';
import type { BankAccountRow } from '@/app/projects/[projectId]/bank-accounts/_types';
import type { OnboardingStepProps } from '../../_types';

interface TenantCard { id: string; nickname?: string | null; brand: string; last4: string }
interface TenantAccount { id: string; nickname?: string | null; institution: string; last4?: string | null }

interface OptionButtonProps {
  icon: ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}

function OptionButton({ icon: Icon, label, onClick }: OptionButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-11 w-full items-center gap-3 rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-4 py-3 text-[14px] font-medium text-lifeone-ink hover:bg-lifeone-hairline/60 active:scale-[0.99] transition-colors"
    >
      <Icon className="h-4 w-4 shrink-0 text-lifeone-ink-3" />
      <span className="flex-1 text-left">{label}</span>
      <ArrowRight className="h-4 w-4 shrink-0 text-lifeone-ink-4" />
    </button>
  );
}

/**
 * Onboarding step that lets users bulk-import transactions from a card
 * statement or bank statement they already have.
 * "Fatura do cartão" fica sempre visível (mesmo sem cartão cadastrado) —
 * escondê-la empurra quem tem fatura na mão para "Extrato da conta", que
 * inverte o sinal errado e mistura despesa de cartão com caixa real.
 * Espelha o padrão já usado em ImportLauncher.tsx.
 */
export function ImportMassStep({ projectId, onDone, onSkip }: OnboardingStepProps) {
  const { data: cards = [] } = useQuery<TenantCard[]>({
    queryKey: ['tenant', 'credit-cards'],
    queryFn: () => api.get('/tenant/credit-cards'),
    staleTime: 60_000,
  });
  const { data: accounts = [] } = useQuery<TenantAccount[]>({
    queryKey: ['tenant', 'bank-accounts'],
    queryFn: () => api.get('/tenant/bank-accounts'),
    staleTime: 60_000,
  });

  const [importType, setImportType] = useState<'fatura' | 'extrato' | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  // card picker shown when >1 card exists (also reused for the "sem cartão" empty state)
  const [showCardPicker, setShowCardPicker] = useState(false);
  // account picker shown when >1 account exists
  const [showAccountPicker, setShowAccountPicker] = useState(false);

  function openFatura() {
    if (cards.length === 1) {
      setSelectedCardId(cards[0].id);
      setImportType('fatura');
    } else {
      setShowCardPicker(true);
    }
  }

  function openExtrato() {
    if (accounts.length === 1) {
      setSelectedAccountId(accounts[0].id);
      setImportType('extrato');
    } else {
      setShowAccountPicker(true);
    }
  }

  function closeModal() {
    setImportType(null);
    setSelectedCardId(null);
    setSelectedAccountId(null);
  }

  const activeCard = cards.find((c: TenantCard) => c.id === selectedCardId) ?? null;
  const activeAccount = accounts.find((a: TenantAccount) => a.id === selectedAccountId) ?? null;

  return (
    <section className="rounded-[18px] border border-lifeone-hairline bg-lifeone-card p-6 shadow-lifeone-card">
      <h2 className="text-[18px] font-bold text-lifeone-ink">Importe seus lançamentos de uma vez</h2>
      <p className="text-[13px] text-lifeone-ink-3">
        Use o extrato ou fatura que já tem — detectamos os valores automaticamente
      </p>

      <div className="space-y-2.5 mt-4">
        <OptionButton
          icon={CreditCard}
          label="Fatura do cartão"
          onClick={openFatura}
        />
        {accounts.length > 0 && (
          <OptionButton
            icon={Landmark}
            label="Extrato da conta"
            onClick={openExtrato}
          />
        )}
      </div>

      {/* Card picker: lista quando >1 cartão, empty state quando 0 cartões */}
      {showCardPicker && (
        <div className="mt-3 space-y-1.5">
          {cards.length === 0 ? (
            <SemCartaoEmptyState projectId={projectId} />
          ) : (
            <>
              <p className="text-[12px] font-medium text-lifeone-ink-2">Qual cartão?</p>
              {cards.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    setSelectedCardId(c.id);
                    setImportType('fatura');
                    setShowCardPicker(false);
                  }}
                  className="flex min-h-11 w-full items-center gap-2 rounded-[8px] border border-lifeone-hairline bg-lifeone-surface px-3 py-2.5 text-[13px] text-lifeone-ink hover:bg-lifeone-hairline/60 transition-colors"
                >
                  {c.nickname || `${c.brand} ••${c.last4}`}
                </button>
              ))}
            </>
          )}
        </div>
      )}

      {/* Account picker when >1 account */}
      {showAccountPicker && (
        <div className="mt-3 space-y-1.5">
          <p className="text-[12px] font-medium text-lifeone-ink-2">Qual conta?</p>
          {accounts.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => {
                setSelectedAccountId(a.id);
                setImportType('extrato');
                setShowAccountPicker(false);
              }}
              className="flex min-h-11 w-full items-center gap-2 rounded-[8px] border border-lifeone-hairline bg-lifeone-surface px-3 py-2.5 text-[13px] text-lifeone-ink hover:bg-lifeone-hairline/60 transition-colors"
            >
              {a.nickname || a.institution}
            </button>
          ))}
        </div>
      )}

      {/* CSV/PDF tip */}
      <p className="text-[11px] text-lifeone-ink-4 mt-3">
        Aceita PDF, CSV, OFX, TXT e imagens. Excel? Exporte como CSV primeiro.
      </p>

      <div className="mt-5">
        <button
          onClick={onSkip}
          className="flex min-h-11 w-full items-center justify-center gap-1.5 text-[13px] text-lifeone-ink-3 hover:text-lifeone-ink"
        >
          <SkipForward className="h-3.5 w-3.5" /> Pular — importar depois
        </button>
      </div>

      {/* Modals */}
      {importType === 'fatura' && activeCard && (
        <ImportStatementModal
          projectId={projectId}
          card={activeCard as unknown as CardRow}
          onClose={closeModal}
          onCommitted={() => {
            closeModal();
            onDone();
          }}
        />
      )}
      {importType === 'extrato' && activeAccount && (
        <ImportBankStatementModal
          projectId={projectId}
          account={activeAccount as unknown as BankAccountRow}
          onClose={closeModal}
          onCommitted={() => {
            closeModal();
            onDone();
          }}
        />
      )}
    </section>
  );
}
