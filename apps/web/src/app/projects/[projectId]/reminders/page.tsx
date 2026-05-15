'use client';

import { useProject } from '@/contexts/project-context';
import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { Plus, Trash2, Edit2, Bell, Check, Clock } from 'lucide-react';

interface Reminder {
  id: string;
  titulo: string;
  descricao?: string;
  data: string;
  recorrencia: string;
  status: string;
  prioridade: string;
}

const RECORRENCIAS = [
  { value: 'UNICA', label: 'Única' },
  { value: 'DIARIA', label: 'Diária' },
  { value: 'SEMANAL', label: 'Semanal' },
  { value: 'MENSAL', label: 'Mensal' },
  { value: 'ANUAL', label: 'Anual' },
];

const PRIORIDADES = [
  { value: 'BAIXA', label: 'Baixa', color: 'bg-gray-100 text-gray-600' },
  { value: 'MEDIA', label: 'Média', color: 'bg-blue-100 text-blue-700' },
  { value: 'ALTA', label: 'Alta', color: 'bg-amber-100 text-amber-700' },
  { value: 'URGENTE', label: 'Urgente', color: 'bg-red-100 text-red-700' },
];

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  PENDENTE: { label: 'Pendente', color: 'bg-amber-100 text-amber-700' },
  CONCLUIDO: { label: 'Concluído', color: 'bg-green-100 text-green-700' },
  ADIADO: { label: 'Adiado', color: 'bg-gray-100 text-gray-500' },
};

const emptyForm = {
  titulo: '',
  descricao: '',
  data: new Date().toISOString().split('T')[0],
  recorrencia: 'UNICA',
  status: 'PENDENTE',
  prioridade: 'MEDIA',
};

export default function RemindersPage() {
  const { projectId } = useProject();
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [filter, setFilter] = useState<string>('PENDENTE');

  useEffect(() => { loadReminders(); }, [projectId]);

  async function loadReminders() {
    try {
      const data = await api.get<Reminder[]>(`/projects/${projectId}/reminders`);
      setReminders(data);
    } catch { /* empty */ } finally { setLoading(false); }
  }

  async function handleSave() {
    try {
      const body = { ...form, data: new Date(form.data).toISOString() };
      if (editingId) {
        await api.patch(`/projects/${projectId}/reminders/${editingId}`, body);
      } else {
        await api.post(`/projects/${projectId}/reminders`, body);
      }
      setShowForm(false);
      setEditingId(null);
      setForm(emptyForm);
      loadReminders();
    } catch (err) { console.error(err); }
  }

  async function handleDelete(id: string) {
    if (!confirm('Excluir este lembrete?')) return;
    try {
      await api.delete(`/projects/${projectId}/reminders/${id}`);
      setReminders((prev) => prev.filter((r) => r.id !== id));
    } catch (err) { console.error(err); }
  }

  async function markDone(id: string) {
    try {
      await api.patch(`/projects/${projectId}/reminders/${id}`, { status: 'CONCLUIDO' });
      loadReminders();
    } catch (err) { console.error(err); }
  }

  async function postpone(id: string) {
    try {
      await api.patch(`/projects/${projectId}/reminders/${id}`, { status: 'ADIADO' });
      loadReminders();
    } catch (err) { console.error(err); }
  }

  function startEdit(r: Reminder) {
    setForm({
      titulo: r.titulo,
      descricao: r.descricao ?? '',
      data: r.data.split('T')[0],
      recorrencia: r.recorrencia,
      status: r.status,
      prioridade: r.prioridade,
    });
    setEditingId(r.id);
    setShowForm(true);
  }

  function formatDate(d: string) {
    return new Date(d).toLocaleDateString('pt-BR');
  }

  if (loading) {
    return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600"></div></div>;
  }

  const filtered = reminders.filter((r) => filter === 'TODOS' || r.status === filter);
  const pendingCount = reminders.filter((r) => r.status === 'PENDENTE').length;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Lembretes</h1>
          <p className="text-sm text-gray-500 mt-1">
            {pendingCount} pendente{pendingCount !== 1 ? 's' : ''}
          </p>
        </div>
        <button
          onClick={() => { setForm(emptyForm); setEditingId(null); setShowForm(true); }}
          className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700"
        >
          <Plus className="w-4 h-4" /> Novo Lembrete
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-2 mb-4">
        {['PENDENTE', 'CONCLUIDO', 'ADIADO', 'TODOS'].map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              filter === s ? 'bg-brand-100 text-brand-700' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {s === 'TODOS' ? 'Todos' : STATUS_CONFIG[s]?.label ?? s}
          </button>
        ))}
      </div>

      {/* Form modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-xl">
            <h2 className="text-lg font-bold mb-4">{editingId ? 'Editar Lembrete' : 'Novo Lembrete'}</h2>
            <div className="space-y-3">
              <input type="text" placeholder="Título" value={form.titulo}
                onChange={(e) => setForm((f) => ({ ...f, titulo: e.target.value }))}
                className="w-full border rounded-lg px-3 py-2" autoFocus />
              <textarea placeholder="Descrição (opcional)" value={form.descricao}
                onChange={(e) => setForm((f) => ({ ...f, descricao: e.target.value }))}
                className="w-full border rounded-lg px-3 py-2" rows={2} />
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-500">Data</label>
                  <input type="date" value={form.data}
                    onChange={(e) => setForm((f) => ({ ...f, data: e.target.value }))}
                    className="w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="text-xs text-gray-500">Recorrência</label>
                  <select value={form.recorrencia} onChange={(e) => setForm((f) => ({ ...f, recorrencia: e.target.value }))}
                    className="w-full border rounded-lg px-3 py-2">
                    {RECORRENCIAS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Prioridade</label>
                <div className="flex gap-2">
                  {PRIORIDADES.map((p) => (
                    <button key={p.value}
                      onClick={() => setForm((f) => ({ ...f, prioridade: p.value }))}
                      className={`px-3 py-1.5 rounded-lg text-sm font-medium border-2 transition-all ${
                        form.prioridade === p.value ? `${p.color} border-current` : 'border-transparent bg-gray-100 text-gray-500'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-4">
              <button onClick={() => { setShowForm(false); setEditingId(null); }} className="px-4 py-2 text-gray-600">Cancelar</button>
              <button onClick={handleSave} disabled={!form.titulo} className="px-4 py-2 bg-brand-600 text-white rounded-lg disabled:opacity-50">
                {editingId ? 'Salvar' : 'Criar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* List */}
      {filtered.length === 0 ? (
        <div className="text-center py-16 bg-gray-50 rounded-xl border-2 border-dashed">
          <p className="text-4xl mb-4">🔔</p>
          <p className="text-gray-600">Nenhum lembrete {filter !== 'TODOS' ? STATUS_CONFIG[filter]?.label.toLowerCase() : ''}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered
            .sort((a, b) => {
              const priorityOrder: Record<string, number> = { URGENTE: 0, ALTA: 1, MEDIA: 2, BAIXA: 3 };
              return (priorityOrder[a.prioridade] ?? 2) - (priorityOrder[b.prioridade] ?? 2) || new Date(a.data).getTime() - new Date(b.data).getTime();
            })
            .map((r) => {
              const prio = PRIORIDADES.find((p) => p.value === r.prioridade);
              const statusCfg = STATUS_CONFIG[r.status];
              const recLabel = RECORRENCIAS.find((rc) => rc.value === r.recorrencia)?.label;
              return (
                <div key={r.id} className={`bg-white border rounded-lg p-4 flex items-start gap-4 ${r.status === 'CONCLUIDO' ? 'opacity-60' : ''}`}>
                  {/* Quick action */}
                  {r.status === 'PENDENTE' && (
                    <button onClick={() => markDone(r.id)} className="mt-0.5 p-1 rounded-full border-2 border-gray-300 hover:border-green-500 hover:bg-green-50 transition-colors" title="Concluir">
                      <Check className="w-4 h-4 text-gray-300 hover:text-green-600" />
                    </button>
                  )}
                  {r.status === 'CONCLUIDO' && (
                    <div className="mt-0.5 p-1 rounded-full bg-green-100">
                      <Check className="w-4 h-4 text-green-600" />
                    </div>
                  )}
                  {r.status === 'ADIADO' && (
                    <div className="mt-0.5 p-1 rounded-full bg-gray-100">
                      <Clock className="w-4 h-4 text-gray-400" />
                    </div>
                  )}

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`font-medium ${r.status === 'CONCLUIDO' ? 'line-through text-gray-400' : 'text-gray-900'}`}>
                        {r.titulo}
                      </span>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${prio?.color ?? ''}`}>
                        {prio?.label}
                      </span>
                    </div>
                    {r.descricao && <p className="text-sm text-gray-500 mb-1">{r.descricao}</p>}
                    <div className="flex items-center gap-3 text-xs text-gray-400">
                      <span>{formatDate(r.data)}</span>
                      {r.recorrencia !== 'UNICA' && <span className="bg-gray-100 px-1.5 py-0.5 rounded">{recLabel}</span>}
                      <span className={`px-1.5 py-0.5 rounded ${statusCfg?.color ?? ''}`}>{statusCfg?.label}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1">
                    {r.status === 'PENDENTE' && (
                      <button onClick={() => postpone(r.id)} className="p-1 text-gray-400 hover:text-amber-600" title="Adiar">
                        <Clock className="w-4 h-4" />
                      </button>
                    )}
                    <button onClick={() => startEdit(r)} className="p-1 text-gray-400 hover:text-brand-600" title="Editar">
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button onClick={() => handleDelete(r.id)} className="p-1 text-gray-400 hover:text-red-500" title="Excluir">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
