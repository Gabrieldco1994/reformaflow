'use client';

import { useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SkipForward, CreditCard, Landmark, Wallet, ArrowRight, ChevronLeft } from 'lucide-react';
import { api } from '@/lib/api';
import ImportWithoutAccountModal, {
  type DocumentType,
} from '@/app/projects/[projectId]/bank-accounts/_components/ImportWithoutAccountModal';
import type { OnboardingStepProps } from '../_types';

interface TenantCard {
  id: string;
  nickname?: string | null;
  brand: string;
  last4: string;
}

interface TenantAccount {
  id: string;
  nickname?: string | null;
  institution: string;
  last4?: string | null;
}

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

type ImportMode = DocumentType | 'chooser' | null;

export function ImportMassStep({
  projectId,
  onDone,
  onSkip,
  onBack,
  subtitle,
  canSkip = true,
  funding,
}: OnboardingStepProps) {
  const { data: cards = [], isLoading: cardsLoading } = useQuery<TenantCard[]>({
    queryKey: ['tenant', 'credit-cards'],
    queryFn: () => api.get('/tenant/credit-cards'),
    staleTime: 60_000,
  });
  const { data: accounts = [], isLoading: accountsLoading } = useQuery<TenantAccount[]>({
    queryKey: ['tenant', 'bank-accounts'],
    queryFn: () => api.get('/tenant/bank-accounts'),
    staleTime: 60_000,
  });

  const isLoading = cardsLoading || accountsLoading;
  const [importMode, setImportMode] = useState<ImportMode>(null);

  // ponytail: guard — fechar modal não reabre em loop
  const modalClosedByUser = useRef(false);

  useEffect(() => {
    if (isLoading || modalClosedByUser.current) return;

    const preferredCardId = funding?.creditCard?.id ?? null;
    const preferredAccountId = funding?.bankAccount?.id ?? null;

    const validCard = preferredCardId ? cards.find((c) => c.id === preferredCardId) : null;
    const validAccount = preferredAccountId ? accounts.find((a) => a.id === preferredAccountId) : null;

    if (validCard && validAccount) return;
    if (validCard && !validAccount) {
      setImportMode('card');
      return;
    }
    if (validAccount && !validCard) {
      setImportMode('bank');
    }
    // ponytail: só re-executa quando os dados chegam — não inclui importMode para não reabrir
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, cards, accounts]);

  function openImport(mode: ImportMode) {
    setImportMode(mode);
  }

  function closeModal() {
    modalClosedByUser.current = true;
    setImportMode(null);
  }

  const hasBothFunding = !!(funding?.creditCard && funding?.bankAccount);
  const hasCardFunding = !!funding?.creditCard;
  const hasAccountFunding = !!funding?.bankAccount;
  const noFunding = !hasCardFunding && !hasAccountFunding;

  return (
    <section className="rounded-[18px] border border-lifeone-hairline bg-lifeone-card p-6 shadow-lifeone-card">
      <h2 className="text-[18px] font-bold text-lifeone-ink">Importe seus lançamentos de uma vez</h2>
      <p className="text-[13px] text-lifeone-ink-3">
        {subtitle || 'Use o extrato ou fatura que já tem — detectamos os valores automaticamente'}
      </p>

      {noFunding && (
        <div className="space-y-2.5 mt-4">
          {cards.length > 0 && (
            <OptionButton
              icon={CreditCard}
              label="Fatura do cartão"
              onClick={() => openImport('card')}
            />
          )}
          {accounts.length > 0 && (
            <OptionButton
              icon={Landmark}
              label="Extrato da conta"
              onClick={() => openImport('bank')}
            />
          )}
          <div className="rounded-[12px] border border-lifeone-hairline bg-lifeone-surface p-4">
            <button
              type="button"
              onClick={() => openImport('chooser')}
              className="flex min-h-11 w-full items-center gap-3 rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-4 py-3 text-[14px] font-medium text-lifeone-ink hover:bg-lifeone-hairline/60 active:scale-[0.99] transition-colors"
            >
              <Wallet className="h-4 w-4 shrink-0 text-lifeone-ink-3" />
              <span className="flex-1 text-left">PDF, CSV, OFX, TXT</span>
              <ArrowRight className="h-4 w-4 shrink-0 text-lifeone-ink-4" />
            </button>
          </div>
        </div>
      )}

      {hasBothFunding && !importMode && (
        <div className="space-y-2.5 mt-4">
          <OptionButton
            icon={CreditCard}
            label="Fatura do cartão"
            onClick={() => openImport('card')}
          />
          <OptionButton
            icon={Landmark}
            label="Extrato da conta"
            onClick={() => openImport('bank')}
          />
        </div>
      )}

      {!hasBothFunding && hasAccountFunding && !importMode && !isLoading && (
        <div className="space-y-2.5 mt-4">
          <OptionButton
            icon={Landmark}
            label="Extrato da conta"
            onClick={() => openImport('bank')}
          />
          {hasCardFunding && (
            <OptionButton
              icon={CreditCard}
              label="Fatura do cartão"
              onClick={() => openImport('card')}
            />
          )}
        </div>
      )}

      {!hasBothFunding && hasCardFunding && !hasAccountFunding && !importMode && !isLoading && (
        <div className="space-y-2.5 mt-4">
          <OptionButton
            icon={CreditCard}
            label="Fatura do cartão"
            onClick={() => openImport('card')}
          />
        </div>
      )}

      {noFunding && cards.length > 0 && (
        <div className="space-y-2.5 mt-3">
          <OptionButton
            icon={CreditCard}
            label="Fatura do cartão"
            onClick={() => openImport('card')}
          />
        </div>
      )}
      {noFunding && accounts.length > 0 && (
        <div className="space-y-2.5 mt-2">
          <OptionButton
            icon={Landmark}
            label="Extrato da conta"
            onClick={() => openImport('bank')}
          />
        </div>
      )}

      <div className="mt-5 space-y-2">
        {canSkip && (
          <button
            onClick={onSkip}
            className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-4 py-3 text-[13px] font-medium text-lifeone-ink-2 hover:bg-lifeone-hairline/60 transition-colors"
          >
            <SkipForward className="h-3.5 w-3.5" /> Pular — importar depois
          </button>
        )}
        {onBack && (
          <button
            onClick={onBack}
            className="flex min-h-11 w-full items-center justify-center gap-1.5 text-[13px] font-medium text-lifeone-ink-3 hover:text-lifeone-ink transition-colors"
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Voltar
          </button>
        )}
      </div>

      {importMode && (
        <ImportWithoutAccountModal
          projectId={projectId}
          fixedDocumentType={importMode === 'chooser' ? undefined : importMode}
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
