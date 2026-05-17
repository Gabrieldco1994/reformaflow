'use client';
import { useProject } from '@/contexts/project-context';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { Plus, Pencil, Trash2, Check, X, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Modal } from '@/components/ui/modal';
import React from 'react';
import type { Receipt, ReceiptFormData } from '@/types';
import { MobileReceiptList } from './_components/MobileReceiptList';

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
  const [collapsedTipos, setCollapsedTipos] = useState<Set<string>>(new Set());

  const toggleTipo = (tipo: string) => {
    setCollapsedTipos((prev) => {
      const next = new Set(prev);
      if (next.has(tipo)) next.delete(tipo);
      else next.add(tipo);
      return next;
    });
  };

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

  const grouped = useMemo(() => {
    const byTipo = new Map<string, Receipt[]>();
    for (const r of receipts) {
      const arr = byTipo.get(r.tipo) ?? [];
      arr.push(r);
      byTipo.set(r.tipo, arr);
    }
    return TIPO_OPTIONS
      .map((o) => ({
        tipo: o.value,
        label: o.label,
        items: (byTipo.get(o.value) ?? []).slice().sort((a, b) => (a.data > b.data ? -1 : 1)),
      }))
      .filter((g) => g.items.length > 0)
      .map((g) => ({
        ...g,
        total: g.items.reduce((s, r) => s + r.valor, 0),
        totalEmCaixa: g.items.filter((r) => r.status === 'EM_CAIXA').reduce((s, r) => s + r.valor, 0),
        totalPrevisto: g.items.filter((r) => r.status === 'PREVISTO').reduce((s, r) => s + r.valor, 0),
      }));
  }, [receipts]);

  const totalGeral = grouped.reduce((s, g) => s + g.total, 0);
  const totalEmCaixa = grouped.reduce((s, g) => s + g.totalEmCaixa, 0);
  const totalPrevisto = grouped.reduce((s, g) => s + g.totalPrevisto, 0);

  return (
    <div className="space-y-6">
      {/* Header desktop */}
      <div className="hidden md:flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-900">Recebimentos</h1>
        <Button onClick={openCreate}><Plus className="w-4 h-4" /> Novo Recebimento</Button>
      </div>

      {/* Header mobile editorial */}
      <div className="md:hidden -mt-2">
        <p className="text-[11px] uppercase tracking-[0.2em] text-darc-raspberry/70">Financeiro</p>
        <h1 className="font-editorial italic text-3xl text-darc-velvet leading-tight">
          Recebimentos
        </h1>
      </div>

      {/* KPIs mobile (scroll horizontal) */}
      <div className="md:hidden -mx-4 px-4 overflow-x-auto scrollbar-hide">
        <div className="flex gap-3 min-w-min pb-2">
          <div className="min-w-[140px] rounded-2xl bg-white shadow-darc-soft border border-darc-linen px-4 py-3">
            <p className="text-[10px] uppercase tracking-wider text-darc-velvet/60">Total</p>
            <p className="font-bold text-darc-velvet tabular-nums mt-1">{formatCurrency(totalGeral / 100)}</p>
          </div>
          <div className="min-w-[140px] rounded-2xl bg-darc-mist/30 shadow-darc-soft border border-darc-mist/50 px-4 py-3">
            <p className="text-[10px] uppercase tracking-wider text-darc-velvet/70">Em caixa</p>
            <p className="font-bold text-darc-velvet tabular-nums mt-1">{formatCurrency(totalEmCaixa / 100)}</p>
          </div>
          <div className="min-w-[140px] rounded-2xl bg-darc-sunfire/15 shadow-darc-soft border border-darc-sunfire/40 px-4 py-3">
            <p className="text-[10px] uppercase tracking-wider text-darc-raspberry/80">Previsto</p>
            <p className="font-bold text-darc-raspberry tabular-nums mt-1">{formatCurrency(totalPrevisto / 100)}</p>
          </div>
        </div>
      </div>

      {isLoading ? (
        <p className="text-gray-500">Carregando...</p>
      ) : (
        <>
          {/* Lista mobile */}
          <MobileReceiptList
            grouped={grouped}
            collapsedTipos={collapsedTipos}
            toggleTipo={toggleTipo}
            openEdit={openEdit}
            onDelete={(id) => deleteMutation.mutate(id)}
            emptyMsg="Nenhum recebimento cadastrado."
          />

          {/* Tabela desktop */}
          <div className="hidden md:block overflow-x-auto border border-darc-linen rounded-lg bg-white shadow-darc-soft">
          <table className="w-full text-sm">
            <thead className="bg-darc-cream/60 border-b border-darc-linen">
              <tr>
                <th className="w-8 px-2 py-2" />
                <th className="text-left px-4 py-2 font-medium text-darc-velvet">Valor</th>
                <th className="text-left px-4 py-2 font-medium text-darc-velvet">Data</th>
                <th className="text-left px-4 py-2 font-medium text-darc-velvet">Tipo</th>
                <th className="text-left px-4 py-2 font-medium text-darc-velvet">Status</th>
                <th className="text-right px-4 py-2 font-medium text-darc-velvet">Ações</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map((g) => {
                const isCollapsed = collapsedTipos.has(g.tipo);
                return (
                  <React.Fragment key={g.tipo}>
                    {/* Faixa de tipo (mesmo padrão do cronograma/despesas) */}
                    <tr
                      className="bg-darc-pink-logo/60 border-y border-darc-pink-logo cursor-pointer hover:bg-darc-pink-logo"
                      onClick={() => toggleTipo(g.tipo)}
                    >
                      <td className="px-2 py-2 text-center text-darc-raspberry">
                        {isCollapsed ? <ChevronRight className="w-3.5 h-3.5 inline" /> : <ChevronDown className="w-3.5 h-3.5 inline" />}
                      </td>
                      <td colSpan={2} className="px-4 py-2 font-bold uppercase tracking-wider text-darc-velvet text-xs">
                        {g.label}
                        <span className="ml-2 text-[10px] font-normal normal-case tracking-normal text-darc-raspberry/70">({g.items.length} itens)</span>
                      </td>
                      <td colSpan={2} className="px-2 py-2 text-right text-[10px] text-darc-raspberry">
                        <span className="inline-flex items-center gap-2">
                          {g.totalPrevisto > 0 && (
                            <span className="bg-darc-sunfire/20 text-darc-raspberry px-1.5 py-0.5 rounded">Previsto: {formatCurrency(g.totalPrevisto / 100)}</span>
                          )}
                          {g.totalEmCaixa > 0 && (
                            <span className="bg-darc-mist/30 text-darc-velvet px-1.5 py-0.5 rounded">Em caixa: {formatCurrency(g.totalEmCaixa / 100)}</span>
                          )}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right font-bold text-darc-velvet text-xs tabular-nums">
                        {formatCurrency(g.total / 100)}
                      </td>
                    </tr>

                    {!isCollapsed && g.items.map((r) => (
                      <tr key={r.id} className="hover:bg-darc-cream/40 border-b border-darc-linen/60">
                        <td />
                        <td className="px-4 py-2 font-medium text-darc-velvet tabular-nums">{formatCurrency(r.valor / 100)}</td>
                        <td className="px-4 py-2 text-darc-velvet/80 tabular-nums">{r.data ? new Date(r.data).toLocaleDateString('pt-BR') : '-'}</td>
                        <td className="px-4 py-2 text-darc-velvet/80">{tipoLabel(r.tipo)}</td>
                        <td className="px-4 py-2"><StatusBadge status={r.status} /></td>
                        <td className="px-4 py-2 text-right space-x-1">
                          <button onClick={() => openEdit(r)} className="p-1 rounded hover:bg-darc-pink-logo" title="Editar">
                            <Pencil className="w-4 h-4 text-darc-raspberry" />
                          </button>
                          <button onClick={() => deleteMutation.mutate(r.id)} className="p-1 rounded hover:bg-darc-red-pastel/30" title="Excluir">
                            <Trash2 className="w-4 h-4 text-darc-red" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </React.Fragment>
                );
              })}

              {/* Linha de criação rápida inline (estilo Excel) */}
              {showNewRow && (
                <tr className="bg-darc-mist/15 border-t-2 border-darc-mist">
                  <td />
                  <td className="px-4 py-2">
                    <input type="number" step="0.01" placeholder="Valor" value={newRow.valor}
                      onChange={(e) => setNewRow({ ...newRow, valor: e.target.value })}
                      onKeyDown={handleNewRowKeyDown}
                      className="w-full border border-darc-linen rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-darc-mist"
                      autoFocus />
                  </td>
                  <td className="px-4 py-2">
                    <input type="date" value={newRow.data}
                      onChange={(e) => setNewRow({ ...newRow, data: e.target.value })}
                      onKeyDown={handleNewRowKeyDown}
                      className="w-full border border-darc-linen rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-darc-mist" />
                  </td>
                  <td className="px-4 py-2">
                    <select value={newRow.tipo}
                      onChange={(e) => setNewRow({ ...newRow, tipo: e.target.value })}
                      onKeyDown={handleNewRowKeyDown}
                      className="w-full border border-darc-linen rounded px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-darc-mist">
                      {TIPO_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </td>
                  <td className="px-4 py-2">
                    <select value={newRow.status}
                      onChange={(e) => setNewRow({ ...newRow, status: e.target.value })}
                      onKeyDown={handleNewRowKeyDown}
                      className="w-full border border-darc-linen rounded px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-darc-mist">
                      {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </td>
                  <td className="px-4 py-2 text-right space-x-1">
                    <button onClick={handleNewRowSubmit} className="p-1 rounded hover:bg-darc-mist/30" title="Salvar (Enter)">
                      <Check className="w-4 h-4 text-darc-raspberry" />
                    </button>
                    <button onClick={() => setShowNewRow(false)} className="p-1 rounded hover:bg-darc-pink-logo" title="Cancelar (Esc)">
                      <X className="w-4 h-4 text-darc-velvet/60" />
                    </button>
                  </td>
                </tr>
              )}

              {grouped.length === 0 && !showNewRow && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-darc-velvet/50 italic">Nenhum recebimento cadastrado.</td></tr>
              )}
            </tbody>
            {grouped.length > 0 && (
              <tfoot className="bg-darc-cream/60 border-t border-darc-linen">
                <tr className="font-semibold text-xs">
                  <td />
                  <td colSpan={4} className="px-4 py-2 text-darc-velvet uppercase tracking-wider">Total</td>
                  <td className="px-4 py-2 text-right font-bold text-darc-velvet tabular-nums">{formatCurrency(totalGeral / 100)}</td>
                </tr>
              </tfoot>
            )}
          </table>
          </div>
        </>
      )}

      {/* Botão de adicionar linha rápida — só desktop */}
      {!showNewRow && (
        <button onClick={() => setShowNewRow(true)}
          className="hidden md:block w-full border-2 border-dashed border-darc-linen rounded-lg py-2 text-sm text-darc-velvet/50 hover:border-darc-red-pastel hover:text-darc-red hover:bg-darc-red-pastel/10 transition-colors">
          + Adicionar rápido (linha inline)
        </button>
      )}

      {/* FAB mobile */}
      <button
        type="button"
        onClick={openCreate}
        aria-label="Novo recebimento"
        className="md:hidden fixed bottom-20 right-4 z-40 w-14 h-14 rounded-full bg-darc-red-bright text-white shadow-darc-med flex items-center justify-center hover:bg-darc-red-pastel active:scale-95 transition-all"
      >
        <Plus className="w-6 h-6" />
      </button>

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
