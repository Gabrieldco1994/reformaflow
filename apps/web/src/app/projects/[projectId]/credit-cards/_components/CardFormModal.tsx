'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { X } from 'lucide-react';
import type { CardRow } from '../_types';

interface Props {
  projectId: string;
  card: CardRow | null;
  onClose: () => void;
  onSaved: () => void;
  /** ponytail: skip the fixed overlay when embedded inside AccountFormModal's own overlay */
  bare?: boolean;
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
  { value: 'OUTRO', label: 'Outro' },
];

const BRANDS = ['Visa', 'Mastercard', 'Elo', 'Amex', 'Hipercard'];

export default function CardFormModal({ projectId, card, onClose, onSaved, bare }: Props) {
  const [institution, setInstitution] = useState(card?.institution ?? 'ITAU');
  const [brand, setBrand] = useState(card?.brand ?? 'Visa');
  const [nickname, setNickname] = useState(card?.nickname ?? '');
  const [last4, setLast4] = useState(card?.last4 ?? '');
  const [limitReais, setLimitReais] = useState(
    card?.limitTotalCents != null ? String(card.limitTotalCents / 100) : '',
  );
  const [closingDay, setClosingDay] = useState(card?.closingDay?.toString() ?? '');
  const [dueDay, setDueDay] = useState(card?.dueDay?.toString() ?? '');
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
      const body: Record<string, unknown> = {
        institution,
        brand,
        last4,
      };
      const trimmedNickname = nickname.trim();
      if (trimmedNickname) body.nickname = trimmedNickname;
      if (limitReais) body.limitTotalCents = Math.round(parseFloat(limitReais) * 100);
      if (closingDay) body.closingDay = parseInt(closingDay, 10);
      if (dueDay) body.dueDay = parseInt(dueDay, 10);

      if (card) {
        await api.patch(`/projects/${projectId}/credit-cards/${card.id}`, body);
      } else {
        await api.post(`/projects/${projectId}/credit-cards`, body);
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  }

  const content = (
      <div className="bg-white rounded-lg w-full max-w-md p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-bold">{card ? 'Editar cartão' : 'Novo cartão'}</h2>
          <button onClick={onClose}><X className="w-5 h-5" /></button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-sm text-gray-600">Instituição</label>
            <select
              value={institution}
              onChange={(e) => setInstitution(e.target.value)}
              className="w-full border rounded-lg p-2"
            >
              {INSTITUTIONS.map((i) => <option key={i.value} value={i.value}>{i.label}</option>)}
            </select>
          </div>
          <div>
            <label className="text-sm text-gray-600">Bandeira</label>
            <select
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              className="w-full border rounded-lg p-2"
            >
              {BRANDS.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div>
            <label className="text-sm text-gray-600">Apelido (opcional)</label>
            <input
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="Ex: Itaú Click Visa"
              className="w-full border rounded-lg p-2"
            />
          </div>
          <div>
            <label className="text-sm text-gray-600">Últimos 4 dígitos</label>
            <input
              value={last4}
              onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
              placeholder="1234"
              maxLength={4}
              className="w-full border rounded-lg p-2 font-mono"
            />
          </div>
          <div>
            <label className="text-sm text-gray-600">Limite total (R$, opcional)</label>
            <input
              type="number"
              value={limitReais}
              onChange={(e) => setLimitReais(e.target.value)}
              placeholder="10000"
              className="w-full border rounded-lg p-2"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm text-gray-600">Dia fechamento</label>
              <input
                type="number"
                value={closingDay}
                onChange={(e) => setClosingDay(e.target.value)}
                placeholder="25"
                min={1}
                max={31}
                className="w-full border rounded-lg p-2"
              />
            </div>
            <div>
              <label className="text-sm text-gray-600">Dia vencimento</label>
              <input
                type="number"
                value={dueDay}
                onChange={(e) => setDueDay(e.target.value)}
                placeholder="10"
                min={1}
                max={31}
                className="w-full border rounded-lg p-2"
              />
            </div>
          </div>

          {error && <div className="text-sm text-red-600">{error}</div>}

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="px-4 py-2 border rounded-lg">Cancelar</button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-50"
            >
              {saving ? 'Salvando…' : 'Salvar'}
            </button>
          </div>
        </div>
      </div>
  );
  if (bare) return content;
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      {content}
    </div>
  );
}
