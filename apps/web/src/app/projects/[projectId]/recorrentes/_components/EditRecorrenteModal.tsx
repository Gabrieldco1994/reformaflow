'use client';

import { useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { getExpenseOptions } from '../../expenses/_types';
import type { RecurrenceSerie } from '../_types';

/**
 * Edita a série. Só valor e categoria: são os dois campos que o usuário pediu e
 * os únicos que se aplicam sem ambiguidade a N ocorrências futuras de uma vez.
 *
 * ponytail: sem editar data/frequência aqui. Mudar a cadência é remarcar N
 * despesas já materializadas — excluir e recriar resolve, e evita um segundo
 * motor de agendamento. Fazer de verdade quando alguém pedir.
 */
export function EditRecorrenteModal({
  serie,
  projectType,
  onClose,
  onSave,
  saving,
}: {
  serie: RecurrenceSerie;
  projectType: string;
  onClose: () => void;
  onSave: (dto: { valor?: number; tipoDespesa?: string }) => void;
  saving: boolean;
}) {
  const [valor, setValor] = useState((serie.valorCents / 100).toFixed(2));
  const [tipoDespesa, setTipo] = useState(serie.tipoDespesa);

  const valorNum = Number(valor.replace(/\./g, '').replace(',', '.'));
  const valorValido = Number.isFinite(valorNum) && valorNum > 0;

  return (
    <Modal open onClose={onClose} title={`Editar ${serie.nome}`}>
      <div className="space-y-4">
        <p className="rounded-xl bg-[#FFF6E6] px-3 py-2 text-[12px] leading-snug text-[#8A5A11]">
          A mudança vale só para as <strong>{serie.ocorrenciasFuturas}</strong> ocorrências
          futuras. As {serie.ocorrenciasPagas} já pagas ficam como estão.
        </p>

        <label className="block">
          <span className="mb-1 block text-[12px] font-semibold text-slate-600">Valor</span>
          <input
            inputMode="decimal"
            value={valor}
            onChange={(e) => setValor(e.target.value)}
            className="h-11 w-full rounded-xl border border-slate-200 px-3 text-[15px] tabular-nums outline-none focus:border-lifeone-blue"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-[12px] font-semibold text-slate-600">Categoria</span>
          <select
            value={tipoDespesa}
            onChange={(e) => setTipo(e.target.value)}
            className="h-11 w-full rounded-xl border border-slate-200 px-3 text-[15px] outline-none focus:border-lifeone-blue"
          >
            {getExpenseOptions(projectType).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 rounded-xl px-4 text-[14px] font-semibold text-slate-600"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={!valorValido || saving}
            onClick={() =>
              onSave({
                ...(Math.round(valorNum * 100) !== serie.valorCents ? { valor: valorNum } : {}),
                ...(tipoDespesa !== serie.tipoDespesa ? { tipoDespesa } : {}),
              })
            }
            className="min-h-11 rounded-xl bg-lifeone-blue px-4 text-[14px] font-semibold text-white disabled:opacity-50"
          >
            {saving ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
