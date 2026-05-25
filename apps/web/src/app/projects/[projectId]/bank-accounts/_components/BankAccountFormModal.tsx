'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { X } from 'lucide-react';
import type { BankAccountRow } from '../_types';

interface Props {
  projectId: string;
  account: BankAccountRow | null;
  onClose: () => void;
  onSaved: () => void;
}

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

export default function BankAccountFormModal({ projectId, account, onClose, onSaved }: Props) {
  const [institution, setInstitution] = useState(account?.institution ?? 'ITAU');
  const [nickname, setNickname] = useState(account?.nickname ?? '');
  const [last4, setLast4] = useState(account?.last4 ?? '');
  const [agency, setAgency] = useState(account?.agency ?? '');
  const [accountNumber, setAccountNumber] = useState(account?.accountNumber ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setError(null);
    if (!/^\d{4}$/.test(last4)) {
      setError('Últimos 4 dígitos devem ser exatamente 4 números');
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = { institution, last4 };
      const t = nickname.trim();
      if (t) body.nickname = t;
      if (agency.trim()) body.agency = agency.trim();
      if (accountNumber.trim()) body.accountNumber = accountNumber.trim();
      if (account) {
        await api.patch(`/projects/${projectId}/bank-accounts/${account.id}`, body);
      } else {
        await api.post(`/projects/${projectId}/bank-accounts`, body);
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg w-full max-w-md p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-bold">{account ? 'Editar conta' : 'Nova conta bancária'}</h2>
          <button onClick={onClose}><X className="w-5 h-5" /></button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-sm text-gray-600">Instituição</label>
            <select value={institution} onChange={(e) => setInstitution(e.target.value)} className="w-full border rounded-lg p-2">
              {INSTITUTIONS.map((i) => <option key={i.value} value={i.value}>{i.label}</option>)}
            </select>
          </div>
          <div>
            <label className="text-sm text-gray-600">Apelido (opcional)</label>
            <input value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="Ex: Itaú Conta Corrente" className="w-full border rounded-lg p-2" />
          </div>
          <div>
            <label className="text-sm text-gray-600">Últimos 4 dígitos da conta</label>
            <input value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="1234" maxLength={4} className="w-full border rounded-lg p-2 font-mono" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm text-gray-600">Agência (opcional)</label>
              <input value={agency} onChange={(e) => setAgency(e.target.value)} placeholder="1234" className="w-full border rounded-lg p-2" />
            </div>
            <div>
              <label className="text-sm text-gray-600">Conta (opcional)</label>
              <input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} placeholder="56789-0" className="w-full border rounded-lg p-2" />
            </div>
          </div>

          {error && <div className="text-sm text-red-600">{error}</div>}

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="px-4 py-2 border rounded-lg">Cancelar</button>
            <button onClick={handleSave} disabled={saving} className="px-4 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-50">
              {saving ? 'Salvando…' : 'Salvar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
