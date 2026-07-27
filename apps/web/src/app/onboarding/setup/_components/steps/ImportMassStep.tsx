'use client';

import { useEffect, useRef, useState } from 'react';
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
 * Importação reutiliza a fonte preferida do passo funding (issue #320):
 * - só conta: abre extrato diretamente
 * - só cartão: abre fatura diretamente
 * - ambos: pergunta Extrato ou Fatura (usa IDs já escolhidos)
 * - nenhuma: estado vazio com CTA
 * ID stale/removido: descarta e volta ao seletor.
 * Fechar modal não reabre em loop.
 */
export function ImportMassStep({ projectId, onDone, onSkip, subtitle, canSkip = true, funding }: OnboardingStepProps) {
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

  const [importType, setImportType] = useState<'fatura' | 'extrato' | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [showCardPicker, setShowCardPicker] = useState(false);
  const [showAccountPicker, setShowAccountPicker] = useState(false);

  // ponytail: guard — fechar modal não reabre em loop
  const modalClosedByUser = useRef(false);

  // Ao carregar dados, validar IDs preferidos e auto-abrir se preferido é válido
  useEffect(() => {
    if (isLoading || modalClosedByUser.current) return;

    const preferredCardId = funding?.creditCard?.id ?? null;
    const preferredAccountId = funding?.bankAccount?.id ?? null;

    const validCard = preferredCardId ? cards.find((c) => c.id === preferredCardId) : null;
    const validAccount = preferredAccountId ? accounts.find((a) => a.id === preferredAccountId) : null;

    if (validCard && validAccount) {
      // ambos: não auto-abre — usuário escolhe o tipo
      return;
    }
    if (validCard && !validAccount) {
      setSelectedCardId(validCard.id);
      setImportType('fatura');
      return;
    }
    if (validAccount && !validCard) {
      setSelectedAccountId(validAccount.id);
      setImportType('extrato');
      return;
    }
  // ponytail: só re-executa quando os dados chegam — não inclui importType para não reabrir
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, cards, accounts]);

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
    modalClosedByUser.current = true;
    setImportType(null);
    setSelectedCardId(null);
    setSelectedAccountId(null);
  }

  const activeCard = cards.find((c) => c.id === selectedCardId) ?? null;
  const activeAccount = accounts.find((a) => a.id === selectedAccountId) ?? null;

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

      {/* Sem fonte: estado vazio */}
      {noFunding && (
        <div className="mt-4 rounded-[12px] border border-lifeone-hairline bg-lifeone-surface p-4">
          <p className="text-[13px] font-medium text-lifeone-ink-2">Nenhuma fonte configurada</p>
          <p className="text-[12px] text-lifeone-ink-3 mt-1">
            Volte ao passo Contas &amp; cartões para adicionar uma conta ou cartão, ou pule por agora.
          </p>
        </div>
      )}

      {/* Ambos: escolha de tipo */}
      {hasBothFunding && !importType && (
        <div className="space-y-2.5 mt-4">
          <OptionButton icon={CreditCard} label="Fatura do cartão" onClick={openFatura} />
          <OptionButton icon={Landmark} label="Extrato da conta" onClick={openExtrato} />
        </div>
      )}

      {/* Só conta (sem auto-abertura ativa, ou após fechar) */}
      {!hasBothFunding && hasAccountFunding && !importType && !isLoading && (
        <div className="space-y-2.5 mt-4">
          <OptionButton icon={Landmark} label="Extrato da conta" onClick={openExtrato} />
          {hasCardFunding && (
            <OptionButton icon={CreditCard} label="Fatura do cartão" onClick={openFatura} />
          )}
        </div>
      )}

      {/* Só cartão (sem auto-abertura ativa) */}
      {!hasBothFunding && hasCardFunding && !hasAccountFunding && !importType && !isLoading && (
        <div className="space-y-2.5 mt-4">
          <OptionButton icon={CreditCard} label="Fatura do cartão" onClick={openFatura} />
        </div>
      )}

      {/* Fallback manual quando não há funding preferido mas há fontes no sistema */}
      {noFunding && cards.length > 0 && (
        <div className="space-y-2.5 mt-3">
          <OptionButton icon={CreditCard} label="Fatura do cartão" onClick={openFatura} />
        </div>
      )}
      {noFunding && accounts.length > 0 && (
        <div className="space-y-2.5 mt-2">
          <OptionButton icon={Landmark} label="Extrato da conta" onClick={openExtrato} />
        </div>
      )}

      {/* Card picker */}
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

      {/* Account picker */}
      {showAccountPicker && (
        <div className="mt-3 space-y-1.5">
          {accounts.length === 0 ? (
            <div className="rounded-[12px] border border-lifeone-hairline bg-lifeone-surface p-3">
              <p className="text-[12px] font-medium text-lifeone-ink-2">Nenhuma conta cadastrada</p>
              <p className="text-[12px] text-lifeone-ink-3 mt-1">Cadastre uma conta bancária antes de importar o extrato.</p>
            </div>
          ) : (
            <>
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
            </>
          )}
        </div>
      )}

      <p className="text-[11px] text-lifeone-ink-4 mt-3">
        Aceita PDF, CSV, OFX, TXT e imagens. Excel? Exporte como CSV primeiro.
      </p>

      <div className="mt-5">
        {canSkip && (
          <button
            onClick={onSkip}
            className="flex min-h-11 w-full items-center justify-center gap-1.5 text-[13px] text-lifeone-ink-3 hover:text-lifeone-ink"
          >
            <SkipForward className="h-3.5 w-3.5" /> Pular — importar depois
          </button>
        )}
      </div>

      {importType === 'fatura' && activeCard && (
        <ImportStatementModal
          projectId={projectId}
          card={activeCard as unknown as CardRow}
          onClose={closeModal}
          onCommitted={() => { closeModal(); onDone(); }}
        />
      )}
      {importType === 'extrato' && activeAccount && (
        <ImportBankStatementModal
          projectId={projectId}
          account={activeAccount as unknown as BankAccountRow}
          onClose={closeModal}
          onCommitted={() => { closeModal(); onDone(); }}
        />
      )}
    </section>
  );
}
