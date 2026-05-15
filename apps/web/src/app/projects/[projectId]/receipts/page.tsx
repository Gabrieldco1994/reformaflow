'use client';
import { useProject } from '@/contexts/project-context';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { Plus, Pencil, Trash2, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Modal } from '@/components/ui/modal';
import type { Receipt, ReceiptFormData } from '@/types';

const TIPO_OPTIONS = [
  { value: 'PAGAMENTO', label: 'Pagamento' },
  { value: 'BONUS', label: 'Bônus' },
  { value: 'VENDA_ACAO', label: 'Venda de Ação' },
  { value: 'ORCAMENTO_INICIAL', label: 'Orçamento Inicial' },
];

const STATUS_OPTIONS = [
  { value: 'PREVISTO', label: 'Previsto' },
  { value: 'EM_CAIXA', label: 'Em Caixa' },
];

function StatusBadge({ status }: { status: string }) {
  const styles = status === 'EM_CAIXA'
    ? 'bg-green-100 text-green-800'
    : 'bg-yellow-100 text-yellow-800';
  const label = status === 'EM_CAIXA' ? 'Em Caixa' : 'Previsto';
  return <span className={`${styles} px-2 py-0.5 rounded-full text-xs font-medium`}>{label}</span>;
}

export default function ReceiptsPage() {
  const { projectId: PROJECT_ID } = useProject();
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Receipt | null>(null);
  const [newRow, setNewRow] = useState({ valor: '', data: '', tipo: 'PAGAMENTO', status: 'PREVISTO' });
  const [showNewRow, setShowNewRow] = useState(false);

  const { data: receipts = [], isLoading } = useQuery<Receipt[]>({
    queryKey: ['receipts', PROJECT_ID],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/receipts`),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['receipts', PROJECT_ID] });
    queryClient.invalidateQueries({ queryKey: ['dashboard', PROJECT_ID] });
    queryClient.invalidateQueries({ queryKey: ['cash-flow', PROJECT_ID] });
  };

  const createMutation = useMutation({
    mutationFn: (data: ReceiptFormData) => api.post(`/projects/${PROJECT_ID}/receipts`, data),
    onSuccess: () => { invalidate(); closeModal(); setShowNewRow(false); setNewRow({ valor: '', data: '', tipo: 'PAGAMENTO', status: 'PREVISTO' }); },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: ReceiptFormData }) =>
      api.patch(`/projects/${PROJECT_ID}/receipts/${id}`, data),
    onSuccess: () => { invalidate(); closeModal(); },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${PROJECT_ID}/receipts/${id}`),
    onSuccess: invalidate,
  });

  function closeModal() {
    setModalOpen(false);
    setEditing(null);
  }

  function openCreate() {
    setEditing(null);
    setModalOpen(true);
  }

  function openEdit(receipt: Receipt) {
    setEditing(receipt);
    setModalOpen(true);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const data: ReceiptFormData = {
      valor: Number(form.get('valor')),
      data: form.get('data') as string,
      tipo: form.get('tipo') as ReceiptFormData['tipo'],
      status: form.get('status') as ReceiptFormData['status'],
    };
    if (editing) {
      updateMutation.mutate({ id: editing.id, data });
    } else {
      createMutation.mutate(data);
    }
  }

  function handleNewRowSubmit() {
    if (!newRow.valor || !newRow.data) return;
    createMutation.mutate({
      valor: parseFloat(newRow.valor),
      data: newRow.data,
      tipo: newRow.tipo as ReceiptFormData['tipo'],
      status: newRow.status as ReceiptFormData['status'],
    });
  }

  function handleNewRowKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') handleNewRowSubmit();
    else if (e.key === 'Escape') setShowNewRow(false);
  }

  const tipoLabel = (tipo: string) => TIPO_OPTIONS.find((o) => o.value === tipo)?.label ?? tipo;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-900">Recebimentos</h1>
        <Button onClick={openCreate}><Plus className="w-4 h-4" /> Novo Recebimento</Button>
      </div>

      {isLoading ? (
        <p className="text-gray-500">Carregando...</p>
      ) : (
        <div className="overflow-x-auto border rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Valor</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Data</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Tipo</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Status</th>
                <th className="text-right px-4 py-2 font-medium text-gray-600">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {receipts.map((r) => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2 font-medium">{formatCurrency(r.valor / 100)}</td>
                  <td className="px-4 py-2">{r.data ? new Date(r.data).toLocaleDateString('pt-BR') : '-'}</td>
                  <td className="px-4 py-2">{tipoLabel(r.tipo)}</td>
                  <td className="px-4 py-2"><StatusBadge status={r.status} /></td>
                  <td className="px-4 py-2 text-right space-x-1">
                    <button onClick={() => openEdit(r)} className="p-1 rounded hover:bg-gray-200">
                      <Pencil className="w-4 h-4 text-gray-500" />
                    </button>
                    <button onClick={() => deleteMutation.mutate(r.id)} className="p-1 rounded hover:bg-red-100">
                      <Trash2 className="w-4 h-4 text-red-500" />
                    </button>
                  </td>
                </tr>
              ))}

              {/* Linha de criação rápida inline (estilo Excel) */}
              {showNewRow && (
                <tr className="bg-blue-50/30 border-t-2 border-blue-200">
                  <td className="px-4 py-2">
                    <input type="number" step="0.01" placeholder="Valor" value={newRow.valor}
                      onChange={(e) => setNewRow({ ...newRow, valor: e.target.value })}
                      onKeyDown={handleNewRowKeyDown}
                      className="w-full border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                      autoFocus />
                  </td>
                  <td className="px-4 py-2">
                    <input type="date" value={newRow.data}
                      onChange={(e) => setNewRow({ ...newRow, data: e.target.value })}
                      onKeyDown={handleNewRowKeyDown}
                      className="w-full border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300" />
                  </td>
                  <td className="px-4 py-2">
                    <select value={newRow.tipo}
                      onChange={(e) => setNewRow({ ...newRow, tipo: e.target.value })}
                      onKeyDown={handleNewRowKeyDown}
                      className="w-full border border-gray-300 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-300">
                      {TIPO_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </td>
                  <td className="px-4 py-2">
                    <select value={newRow.status}
                      onChange={(e) => setNewRow({ ...newRow, status: e.target.value })}
                      onKeyDown={handleNewRowKeyDown}
                      className="w-full border border-gray-300 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-300">
                      {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </td>
                  <td className="px-4 py-2 text-right space-x-1">
                    <button onClick={handleNewRowSubmit} className="p-1 rounded hover:bg-green-100" title="Salvar (Enter)">
                      <Check className="w-4 h-4 text-green-600" />
                    </button>
                    <button onClick={() => setShowNewRow(false)} className="p-1 rounded hover:bg-gray-200" title="Cancelar (Esc)">
                      <X className="w-4 h-4 text-gray-500" />
                    </button>
                  </td>
                </tr>
              )}

              {receipts.length === 0 && !showNewRow && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">Nenhum recebimento cadastrado.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Botão de adicionar linha rápida */}
      {!showNewRow && (
        <button onClick={() => setShowNewRow(true)}
          className="w-full border-2 border-dashed border-gray-200 rounded-lg py-2 text-sm text-gray-400 hover:border-blue-300 hover:text-blue-500 transition-colors">
          + Adicionar rápido (linha inline)
        </button>
      )}

      {/* Modal de criação/edição completa */}
      <Modal open={modalOpen} onClose={closeModal} title={editing ? 'Editar Recebimento' : 'Novo Recebimento'}>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input label="Valor (R$)" name="valor" type="number" step="0.01" min="0" required
            defaultValue={editing ? (editing.valor / 100).toFixed(2) : ''} />
          <Input label="Data" name="data" type="date" required
            defaultValue={editing?.data ? editing.data.slice(0, 10) : ''} />
          <Select label="Tipo" name="tipo" options={TIPO_OPTIONS} required
            defaultValue={editing?.tipo ?? ''} />
          <Select label="Status" name="status" options={STATUS_OPTIONS} required
            defaultValue={editing?.status ?? ''} />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={closeModal}>Cancelar</Button>
            <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
              {editing ? 'Salvar' : 'Criar'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
