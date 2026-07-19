'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { maskCurrencyInput, currencyInputToNumber, centsToReaisInput } from '@/lib/currency-input';
import { BILL_CATEGORIES, BILL_FREQUENCIES, type RecurringBillRow } from '../_display';

interface Props {
  projectId: string;
  projectType: string;
  bill: RecurringBillRow | null;
  onClose: () => void;
  onSaved: () => void;
  /** ponytail: skip the fixed overlay when embedded elsewhere (e.g. onboarding wizard) — same convention as the bank/card form modals. */
  bare?: boolean;
}

export default function RecurringBillFormModal({ projectId, projectType, bill, onClose, onSaved, bare }: Props) {
  const [nome, setNome] = useState(bill?.nome ?? '');
  const [valor, setValor] = useState(bill ? centsToReaisInput(bill.valor) : '');
  const [diaVencimento, setDiaVencimento] = useState(bill?.diaVencimento ?? 10);
  const [categoria, setCategoria] = useState(bill?.categoria ?? 'LUZ');
  const [frequencia, setFrequencia] = useState(bill?.frequencia ?? 'MENSAL');
  const [observacoes, setObservacoes] = useState(bill?.observacoes ?? '');
  const [saving, setSaving] = useState(false);
  const editingId = bill?.id ?? null;

  async function handleSave() {
    setSaving(true);
    try {
      const body = {
        nome,
        valor: Math.round(currencyInputToNumber(valor) * 100),
        categoria,
        frequencia,
        diaVencimento,
        status: bill?.status ?? 'ATIVO',
        observacoes,
      };
      if (editingId) {
        await api.patch(`/projects/${projectId}/recurring-bills/${editingId}`, body);
      } else {
        await api.post(`/projects/${projectId}/recurring-bills`, body);
      }
      onSaved();
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  }

  const content = (
    <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-xl max-h-[90vh] overflow-y-auto">
      <h2 className="text-lg font-bold mb-4">{editingId ? 'Editar Conta' : 'Nova Conta'}</h2>
      <div className="space-y-3">
        <input
          type="text"
          placeholder="Nome da conta"
          value={nome}
          onChange={(e) => setNome(e.target.value)}
          className="w-full border rounded-lg px-3 py-2"
          autoFocus
        />
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="rb-valor" className="text-xs text-gray-500">Valor (R$)</label>
            <input
              id="rb-valor"
              type="text"
              inputMode="numeric"
              value={valor}
              onChange={(e) => setValor(maskCurrencyInput(e.target.value))}
              className="w-full border rounded-lg px-3 py-2"
            />
          </div>
          <div>
            <label htmlFor="rb-dia-vencimento" className="text-xs text-gray-500">Dia Vencimento</label>
            <input
              id="rb-dia-vencimento"
              type="number"
              min={1}
              max={31}
              value={diaVencimento}
              onChange={(e) => setDiaVencimento(parseInt(e.target.value, 10) || 1)}
              className="w-full border rounded-lg px-3 py-2"
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="rb-categoria" className="text-xs text-gray-500">Categoria</label>
            <select
              id="rb-categoria"
              value={categoria}
              onChange={(e) => setCategoria(e.target.value)}
              className="w-full border rounded-lg px-3 py-2"
            >
              {BILL_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="rb-frequencia" className="text-xs text-gray-500">Frequência</label>
            <select
              id="rb-frequencia"
              value={frequencia}
              onChange={(e) => setFrequencia(e.target.value)}
              className="w-full border rounded-lg px-3 py-2"
            >
              {BILL_FREQUENCIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </div>
        </div>
        <textarea
          placeholder="Observações (opcional)"
          value={observacoes}
          onChange={(e) => setObservacoes(e.target.value)}
          className="w-full border rounded-lg px-3 py-2"
          rows={2}
        />
        {/* Hint for CASA/CARRO: recurring bills that hit your bank account belong in PESSOAL */}
        {(projectType === 'CASA' || projectType === 'CARRO') && !editingId && (
          <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2.5">
            <p className="text-[12px] leading-relaxed text-blue-800">
              <strong>Dica:</strong> esta conta é debitada da sua conta pessoal?
              Para ela contar no seu caixa, lance como despesa recorrente no projeto <strong>PESSOAL</strong>.
            </p>
            <p className="mt-1 text-[11px] text-blue-600">
              Contas de CASA/CARRO registram manutenção do bem — débitos da conta bancária entram no PESSOAL.
            </p>
          </div>
        )}
      </div>
      <div className="flex justify-end gap-3 mt-4">
        <button onClick={onClose} className="px-4 py-2 text-gray-600">Cancelar</button>
        <button onClick={handleSave} disabled={!nome || saving} className="px-4 py-2 bg-brand-600 text-white rounded-lg disabled:opacity-50">
          {editingId ? 'Salvar' : 'Criar'}
        </button>
      </div>
    </div>
  );

  if (bare) return content;
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      {content}
    </div>
  );
}
