'use client';
import { useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { currencyInputToNumber, maskCurrencyInput } from '@/lib/currency-input';

/**
 * Modal para definir/editar a meta (limite mensal) de uma categoria.
 * Quando `fixedTipo` é passado (edição), o tipo fica travado.
 */
export function MetaFormModal({
  open,
  onClose,
  onSave,
  tipoOptions,
  fixedTipo,
  initialValor,
  isPending,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (tipoDespesa: string, valorReais: number) => void;
  tipoOptions: { value: string; label: string }[];
  fixedTipo?: string | null;
  initialValor?: number;
  isPending?: boolean;
}) {
  const [tipo, setTipo] = useState(fixedTipo ?? tipoOptions[0]?.value ?? '');
  const [valor, setValor] = useState(initialValor != null ? String(initialValor) : '');

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const v = currencyInputToNumber(valor);
    if (!tipo || !Number.isFinite(v) || v <= 0) return;
    onSave(tipo, v);
  }

  return (
    <Modal open={open} onClose={onClose} title={fixedTipo ? 'Editar meta' : 'Nova meta por categoria'}>
      <form onSubmit={submit} className="space-y-4">
        <Select
          label="Categoria"
          options={tipoOptions}
          value={tipo}
          onChange={(e) => setTipo(e.target.value)}
          disabled={!!fixedTipo}
          required
        />
        <Input
          label="Limite mensal (R$)"
          type="text"
          inputMode="numeric"
          value={valor}
          onChange={(e) => setValor(maskCurrencyInput(e.target.value))}
          required
        />
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={isPending}>Salvar</Button>
        </div>
      </form>
    </Modal>
  );
}
