'use client';

import { useState } from 'react';
import CardFormModal from '../credit-cards/_components/CardFormModal';
import BankAccountFormModal from '../bank-accounts/_components/BankAccountFormModal';

export type AccountKind = 'CARD' | 'BANK';

interface Props {
  projectId: string;
  defaultType: AccountKind;
  onClose: () => void;
  onSaved: (type: AccountKind) => void;
}

// ponytail: cartão e conta bancária continuam modelos/endpoints separados no
// backend (fatura vs. reconciliação de caixa) — só a entrada "Novo" no front
// foi unificada com um toggle, delegando pros modais já existentes.
export default function AccountFormModal({ projectId, defaultType, onClose, onSaved }: Props) {
  const [type, setType] = useState<AccountKind>(defaultType);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="w-full max-w-md space-y-2">
        <div className="flex rounded-lg border bg-white p-1 shadow-sm">
          <button
            type="button"
            onClick={() => setType('CARD')}
            className={`flex-1 rounded-md py-2 text-sm font-medium transition ${
              type === 'CARD' ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            Cartão de crédito
          </button>
          <button
            type="button"
            onClick={() => setType('BANK')}
            className={`flex-1 rounded-md py-2 text-sm font-medium transition ${
              type === 'BANK' ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            Conta bancária
          </button>
        </div>

        {type === 'CARD' ? (
          <CardFormModal projectId={projectId} card={null} bare onClose={onClose} onSaved={() => onSaved('CARD')} />
        ) : (
          <BankAccountFormModal
            projectId={projectId}
            account={null}
            bare
            onClose={onClose}
            onSaved={() => onSaved('BANK')}
          />
        )}
      </div>
    </div>
  );
}
