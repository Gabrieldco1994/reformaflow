'use client';

import { useState, useEffect, useRef } from 'react';
import { api } from '@/lib/api';
import { Upload, CreditCard, Landmark, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import ImportStatementModal from '../../credit-cards/_components/ImportStatementModal';
import ImportBankStatementModal from '../../bank-accounts/_components/ImportBankStatementModal';
import type { CardRow } from '../../credit-cards/_types';
import type { BankAccountRow } from '../../bank-accounts/_types';

type Step = null | 'pick-card' | 'pick-account';

interface Props {
  projectId: string;
  onImported?: () => void;
}

export default function ImportLauncher({ projectId, onImported }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [step, setStep] = useState<Step>(null);
  const [cards, setCards] = useState<CardRow[] | null>(null);
  const [accounts, setAccounts] = useState<BankAccountRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedCard, setSelectedCard] = useState<CardRow | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<BankAccountRow | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  async function openPickCard() {
    setMenuOpen(false);
    setStep('pick-card');
    setError(null);
    if (cards === null) {
      try {
        setLoading(true);
        const data = await api.get<CardRow[]>(`/projects/${projectId}/credit-cards`);
        setCards(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Erro ao carregar cartões');
      } finally {
        setLoading(false);
      }
    }
  }

  async function openPickAccount() {
    setMenuOpen(false);
    setStep('pick-account');
    setError(null);
    if (accounts === null) {
      try {
        setLoading(true);
        const data = await api.get<BankAccountRow[]>(`/projects/${projectId}/bank-accounts`);
        setAccounts(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Erro ao carregar contas');
      } finally {
        setLoading(false);
      }
    }
  }

  function closePicker() {
    setStep(null);
    setError(null);
  }

  function handleImported() {
    setSelectedCard(null);
    setSelectedAccount(null);
    onImported?.();
  }

  const cardLabel = (c: CardRow) =>
    [c.nickname || c.institution, c.brand, c.last4 ? `•••• ${c.last4}` : null]
      .filter(Boolean)
      .join(' · ');

  const accountLabel = (a: BankAccountRow) =>
    [a.nickname || a.institution, a.agency, a.accountNumber || a.last4]
      .filter(Boolean)
      .join(' · ');

  return (
    <div className="relative" ref={wrapperRef}>
      <Button variant="secondary" onClick={() => setMenuOpen((v) => !v)}>
        <Upload className="w-4 h-4" />
        Importar
        <ChevronDown className="w-3 h-3 ml-1" />
      </Button>
      {menuOpen && (
        <div className="absolute right-0 mt-1 w-64 rounded-lg border border-gray-200 bg-white shadow-lg z-30 overflow-hidden">
          <button
            onClick={openPickCard}
            className="w-full flex items-start gap-3 px-3 py-2.5 text-left hover:bg-gray-50 border-b border-gray-100"
          >
            <CreditCard className="w-4 h-4 mt-0.5 text-orange-500 shrink-0" />
            <div>
              <p className="text-sm font-medium text-gray-900">Fatura de cartão</p>
              <p className="text-xs text-gray-500">PDF, CSV/OFX ou 📷 print/foto da fatura</p>
            </div>
          </button>
          <button
            onClick={openPickAccount}
            className="w-full flex items-start gap-3 px-3 py-2.5 text-left hover:bg-gray-50"
          >
            <Landmark className="w-4 h-4 mt-0.5 text-orange-500 shrink-0" />
            <div>
              <p className="text-sm font-medium text-gray-900">Extrato bancário</p>
              <p className="text-xs text-gray-500">OFX/CSV ou 📷 print/foto do extrato</p>
            </div>
          </button>
        </div>
      )}

      {step === 'pick-card' && !selectedCard && (
        <Modal open onClose={closePicker} title="Para qual cartão é essa fatura?">
          {loading && <p className="text-sm text-gray-500">Carregando cartões…</p>}
          {error && <p className="text-sm text-red-600">{error}</p>}
          {!loading && cards && cards.length === 0 && (
            <p className="text-sm text-gray-600">
              Nenhum cartão cadastrado ainda. Cadastre um cartão em <strong>Cartões de Crédito</strong> antes de importar a fatura.
            </p>
          )}
          {!loading && cards && cards.length > 0 && (
            <div className="space-y-2">
              {cards.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSelectedCard(c)}
                  className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-gray-200 hover:border-orange-300 hover:bg-orange-50 text-left"
                >
                  <span className="flex items-center gap-2">
                    <CreditCard className="w-4 h-4 text-orange-500" />
                    <span className="text-sm font-medium text-gray-900">{cardLabel(c)}</span>
                  </span>
                  <ChevronDown className="w-4 h-4 -rotate-90 text-gray-400" />
                </button>
              ))}
            </div>
          )}
        </Modal>
      )}

      {step === 'pick-account' && !selectedAccount && (
        <Modal open onClose={closePicker} title="Para qual conta é esse extrato?">
          {loading && <p className="text-sm text-gray-500">Carregando contas…</p>}
          {error && <p className="text-sm text-red-600">{error}</p>}
          {!loading && accounts && accounts.length === 0 && (
            <p className="text-sm text-gray-600">
              Nenhuma conta bancária cadastrada ainda. Cadastre uma conta em <strong>Contas Bancárias</strong> antes de importar o extrato.
            </p>
          )}
          {!loading && accounts && accounts.length > 0 && (
            <div className="space-y-2">
              {accounts.map((a) => (
                <button
                  key={a.id}
                  onClick={() => setSelectedAccount(a)}
                  className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-gray-200 hover:border-orange-300 hover:bg-orange-50 text-left"
                >
                  <span className="flex items-center gap-2">
                    <Landmark className="w-4 h-4 text-orange-500" />
                    <span className="text-sm font-medium text-gray-900">{accountLabel(a)}</span>
                  </span>
                  <ChevronDown className="w-4 h-4 -rotate-90 text-gray-400" />
                </button>
              ))}
            </div>
          )}
        </Modal>
      )}

      {selectedCard && (
        <ImportStatementModal
          projectId={projectId}
          card={selectedCard}
          onClose={() => { setSelectedCard(null); setStep(null); }}
          onCommitted={() => { setStep(null); handleImported(); }}
        />
      )}

      {selectedAccount && (
        <ImportBankStatementModal
          projectId={projectId}
          account={selectedAccount}
          onClose={() => { setSelectedAccount(null); setStep(null); }}
          onCommitted={() => { setStep(null); handleImported(); }}
        />
      )}
    </div>
  );
}
