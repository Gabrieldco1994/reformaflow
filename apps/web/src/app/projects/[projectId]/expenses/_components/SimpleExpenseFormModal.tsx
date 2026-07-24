'use client';

import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import type { Expense, ExpenseFormData } from '@/types';
import { type InlineNewRow, makeEmptyNewRow } from '../_types';
import { QuickAddCard } from './QuickAddCard';
import { reaisToCents, centsToReais } from '../_lib/money';

interface OptionItem {
  value: string;
  label: string;
}

interface Props {
  open: boolean;
  editing: Expense | null;
  tipoDespesaOptions: OptionItem[];
  defaultTipoDespesa: string;
  onClose: () => void;
  onSave: (data: ExpenseFormData, editingId: string | null) => void;
  onDelete: (id: string) => void;
  saving?: boolean;
}

function expenseToRow(expense: Expense): InlineNewRow {
  return {
    tipoDespesa: expense.tipoDespesa,
    categoriaMaoDeObra: expense.categoriaMaoDeObra ?? '',
    roomId: expense.roomId ?? '',
    valor: centsToReais(expense.valor),
    quantidade: String(expense.quantidade ?? 1),
    titulo: expense.titulo ?? '',
    fornecedor: expense.fornecedor ?? '',
    formaPagamento: expense.formaPagamento,
    status: expense.status,
    dataPagamento: expense.dataPagamento?.slice(0, 10) ?? '',
    quantidadeParcela: expense.quantidadeParcela ? String(expense.quantidadeParcela) : '',
    dataInicioParcela: expense.dataInicioParcela?.slice(0, 10) ?? '',
  };
}

function rowToFormData(row: InlineNewRow): ExpenseFormData {
  return {
    tipoDespesa: row.tipoDespesa,
    categoriaMaoDeObra: row.categoriaMaoDeObra || null,
    roomId: row.roomId || null,
    valor: reaisToCents(row.valor) / 100,
    quantidade: parseInt(row.quantidade, 10) || 1,
    titulo: row.titulo || null,
    fornecedor: row.fornecedor || null,
    formaPagamento: row.formaPagamento,
    dataPagamento: row.dataPagamento || null,
    quantidadeParcela: row.quantidadeParcela ? parseInt(row.quantidadeParcela, 10) : null,
    dataInicioParcela: row.dataInicioParcela || null,
    status: row.status as 'PLANEJADO' | 'PAGO',
  };
}

/**
 * Modal de criação/edição enxuta de despesa para CASA/CARRO (issue #292):
 * reaproveita os campos do QuickAddCard (tipo/título/valor/forma/status —
 * já sem import fatura/extrato nem vínculo cross-project), só que em modal
 * (melhor em telas pequenas do que o card inline usado no PESSOAL/REFORMA).
 */
export function SimpleExpenseFormModal({
  open,
  editing,
  tipoDespesaOptions,
  defaultTipoDespesa,
  onClose,
  onSave,
  onDelete,
  saving = false,
}: Props) {
  const [row, setRow] = useState<InlineNewRow>(() => makeEmptyNewRow(defaultTipoDespesa));

  useEffect(() => {
    if (!open) return;
    setRow(editing ? expenseToRow(editing) : makeEmptyNewRow(defaultTipoDespesa));
  }, [open, editing, defaultTipoDespesa]);

  function handleSubmit() {
    if (!row.valor || reaisToCents(row.valor) <= 0) return;
    onSave(rowToFormData(row), editing?.id ?? null);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') handleSubmit();
    else if (e.key === 'Escape') onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title={editing ? 'Editar despesa' : 'Nova despesa'} variant="sheet" size="md">
      <div className="space-y-3">
        <QuickAddCard
          newRow={row}
          setNewRow={setRow}
          tipoDespesaOptions={tipoDespesaOptions}
          showRooms={false}
          roomOptions={[]}
          onSubmit={handleSubmit}
          onCancel={onClose}
          inlineKeyDown={handleKeyDown}
        />
        {editing?.id && (
          <Button
            type="button"
            variant="ghost"
            className="w-full text-[#D92D20] hover:bg-[#FCEBE9]"
            onClick={() => {
              if (confirm('Excluir despesa?')) onDelete(editing.id!);
            }}
            disabled={saving}
          >
            Excluir despesa
          </Button>
        )}
      </div>
    </Modal>
  );
}
