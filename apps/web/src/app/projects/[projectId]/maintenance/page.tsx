'use client';

import { useProject } from '@/contexts/project-context';
import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import { Plus, Trash2, Edit2, Wrench } from 'lucide-react';

interface MaintenanceLog {
  id: string;
  tipo: string;
  dataRealizada: string;
  dataProxima?: string;
  quilometragem?: number;
  custo?: number;
  fornecedor?: string;
  observacoes?: string;
}

const HOUSE_TYPES = [
  { value: 'PINTURA', label: 'Pintura' },
  { value: 'IMPERMEABILIZACAO', label: 'Impermeabilização' },
  { value: 'DEDETIZACAO', label: 'Dedetização' },
  { value: 'LIMPEZA_CAIXA', label: "Limpeza de Caixa d'Água" },
  { value: 'REVISAO_ELETRICA', label: 'Revisão Elétrica' },
  { value: 'REVISAO_HIDRAULICA', label: 'Revisão Hidráulica' },
  { value: 'OUTRO', label: 'Outro' },
];

const CAR_TYPES = [
  { value: 'TROCA_OLEO', label: 'Troca de Óleo' },
  { value: 'FILTRO_AR', label: 'Filtro de Ar' },
  { value: 'FILTRO_OLEO', label: 'Filtro de Óleo' },
  { value: 'FILTRO_COMBUSTIVEL', label: 'Filtro de Combustível' },
  { value: 'PNEUS', label: 'Pneus' },
  { value: 'ALINHAMENTO', label: 'Alinhamento' },
  { value: 'BALANCEAMENTO', label: 'Balanceamento' },
  { value: 'REVISAO', label: 'Revisão Completa' },
  { value: 'FREIOS', label: 'Freios' },
  { value: 'CORREIA', label: 'Correia Dentada' },
  { value: 'OUTRO', label: 'Outro' },
];

const emptyForm = {
  tipo: '',
  dataRealizada: new Date().toISOString().split('T')[0],
  dataProxima: '',
  quilometragem: undefined as number | undefined,
  custo: 0,
  fornecedor: '',
  observacoes: '',
};

export default function MaintenancePage() {
  const { projectId, projectType } = useProject();
  const types = projectType === 'CARRO' ? CAR_TYPES : HOUSE_TYPES;
  const [logs, setLogs] = useState<MaintenanceLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...emptyForm, tipo: types[0]?.value ?? '' });

  useEffect(() => { loadLogs(); }, [projectId]);

  async function loadLogs() {
    try {
      const data = await api.get<MaintenanceLog[]>(`/projects/${projectId}/maintenance-logs`);
      setLogs(data);
    } catch { /* empty */ } finally { setLoading(false); }
  }

  async function handleSave() {
    try {
      const body = {
        ...form,
        custo: form.custo ? Math.round(form.custo * 100) : undefined,
        dataRealizada: new Date(form.dataRealizada).toISOString(),
        dataProxima: form.dataProxima ? new Date(form.dataProxima).toISOString() : undefined,
        quilometragem: form.quilometragem || undefined,
      };
      if (editingId) {
        await api.patch(`/projects/${projectId}/maintenance-logs/${editingId}`, body);
      } else {
        await api.post(`/projects/${projectId}/maintenance-logs`, body);
      }
      setShowForm(false);
      setEditingId(null);
      setForm({ ...emptyForm, tipo: types[0]?.value ?? '' });
      loadLogs();
    } catch (err) { console.error(err); }
  }

  async function handleDelete(id: string) {
    if (!confirm('Excluir este registro?')) return;
    try {
      await api.delete(`/projects/${projectId}/maintenance-logs/${id}`);
      setLogs((prev) => prev.filter((l) => l.id !== id));
    } catch (err) { console.error(err); }
  }

  function startEdit(log: MaintenanceLog) {
    setForm({
      tipo: log.tipo,
      dataRealizada: log.dataRealizada.split('T')[0],
      dataProxima: log.dataProxima?.split('T')[0] ?? '',
      quilometragem: log.quilometragem,
      custo: log.custo ? log.custo / 100 : 0,
      fornecedor: log.fornecedor ?? '',
      observacoes: log.observacoes ?? '',
    });
    setEditingId(log.id);
    setShowForm(true);
  }

  function formatDate(d: string) {
    return formatDateBR(d);
  }

  function daysUntil(d: string) {
    const diff = Math.ceil((new Date(d).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    if (diff < 0) return { text: `${Math.abs(diff)}d atrasado`, color: 'text-red-600' };
    if (diff <= 30) return { text: `em ${diff}d`, color: 'text-amber-600' };
    return { text: `em ${diff}d`, color: 'text-green-600' };
  }

  if (loading) {
    return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600"></div></div>;
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Manutenções</h1>
          <p className="text-sm text-gray-500 mt-1">Histórico e próximas manutenções</p>
        </div>
        <button
          onClick={() => { setForm({ ...emptyForm, tipo: types[0]?.value ?? '' }); setEditingId(null); setShowForm(true); }}
          className="self-start sm:self-auto flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700"
        >
          <Plus className="w-4 h-4" /> Nova Manutenção
        </button>
      </div>

      {/* Próximas manutenções */}
      {(() => {
        const upcoming = logs
          .filter((l) => l.dataProxima)
          .sort((a, b) => new Date(a.dataProxima!).getTime() - new Date(b.dataProxima!).getTime())
          .slice(0, 5);
        if (!upcoming.length) return null;
        return (
          <div className="mb-6">
            <h2 className="text-sm font-semibold text-gray-600 mb-3 uppercase tracking-wider">Próximas Manutenções</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {upcoming.map((log) => {
                const typeLabel = types.find((t) => t.value === log.tipo)?.label ?? log.tipo;
                const info = daysUntil(log.dataProxima!);
                return (
                  <div key={log.id} className="bg-white border rounded-lg p-4 flex items-start gap-3">
                    <Wrench className="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0" />
                    <div>
                      <div className="font-medium text-gray-900">{typeLabel}</div>
                      <div className={`text-sm font-medium ${info.color}`}>{info.text}</div>
                      <div className="text-xs text-gray-400">{formatDate(log.dataProxima!)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Form modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-xl max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-bold mb-4">{editingId ? 'Editar Manutenção' : 'Nova Manutenção'}</h2>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500">Tipo</label>
                <select value={form.tipo} onChange={(e) => setForm((f) => ({ ...f, tipo: e.target.value }))}
                  className="w-full border rounded-lg px-3 py-2">
                  {types.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-500">Data Realizada</label>
                  <input type="date" value={form.dataRealizada}
                    onChange={(e) => setForm((f) => ({ ...f, dataRealizada: e.target.value }))}
                    className="w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="text-xs text-gray-500">Próxima (opcional)</label>
                  <input type="date" value={form.dataProxima}
                    onChange={(e) => setForm((f) => ({ ...f, dataProxima: e.target.value }))}
                    className="w-full border rounded-lg px-3 py-2" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-500">Custo (R$)</label>
                  <input type="number" step="0.01" value={form.custo || ''}
                    onChange={(e) => setForm((f) => ({ ...f, custo: parseFloat(e.target.value) || 0 }))}
                    className="w-full border rounded-lg px-3 py-2" />
                </div>
                {projectType === 'CARRO' && (
                  <div>
                    <label className="text-xs text-gray-500">Km</label>
                    <input type="number" value={form.quilometragem ?? ''}
                      onChange={(e) => setForm((f) => ({ ...f, quilometragem: parseInt(e.target.value) || undefined }))}
                      className="w-full border rounded-lg px-3 py-2" />
                  </div>
                )}
              </div>
              <input type="text" placeholder="Fornecedor (opcional)" value={form.fornecedor}
                onChange={(e) => setForm((f) => ({ ...f, fornecedor: e.target.value }))}
                className="w-full border rounded-lg px-3 py-2" />
              <textarea placeholder="Observações (opcional)" value={form.observacoes}
                onChange={(e) => setForm((f) => ({ ...f, observacoes: e.target.value }))}
                className="w-full border rounded-lg px-3 py-2" rows={2} />
            </div>
            <div className="flex justify-end gap-3 mt-4">
              <button onClick={() => { setShowForm(false); setEditingId(null); }} className="px-4 py-2 text-gray-600">Cancelar</button>
              <button onClick={handleSave} className="px-4 py-2 bg-brand-600 text-white rounded-lg">
                {editingId ? 'Salvar' : 'Criar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      {logs.length === 0 ? (
        <div className="text-center py-16 bg-gray-50 rounded-xl border-2 border-dashed">
          <p className="text-4xl mb-4">🔧</p>
          <p className="text-gray-600">Nenhuma manutenção registrada</p>
          <p className="text-gray-400 text-sm mt-1">Registre suas manutenções para acompanhar prazos</p>
        </div>
      ) : (
        <>
        {/* Desktop: tabela */}
        <div className="hidden md:block bg-white rounded-xl border overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Tipo</th>
                <th className="text-center px-4 py-3 font-medium text-gray-600">Realizada</th>
                <th className="text-center px-4 py-3 font-medium text-gray-600">Próxima</th>
                {projectType === 'CARRO' && <th className="text-right px-4 py-3 font-medium text-gray-600">Km</th>}
                <th className="text-right px-4 py-3 font-medium text-gray-600">Custo</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Fornecedor</th>
                <th className="text-center px-4 py-3 font-medium text-gray-600">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {logs.map((log) => {
                const typeLabel = types.find((t) => t.value === log.tipo)?.label ?? log.tipo;
                return (
                  <tr key={log.id}>
                    <td className="px-4 py-3 font-medium">{typeLabel}</td>
                    <td className="px-4 py-3 text-center">{formatDate(log.dataRealizada)}</td>
                    <td className="px-4 py-3 text-center">
                      {log.dataProxima ? (
                        <span className={daysUntil(log.dataProxima).color}>
                          {formatDate(log.dataProxima)} ({daysUntil(log.dataProxima).text})
                        </span>
                      ) : '—'}
                    </td>
                    {projectType === 'CARRO' && <td className="px-4 py-3 text-right font-mono">{log.quilometragem?.toLocaleString() ?? '—'}</td>}
                    <td className="px-4 py-3 text-right font-mono">{log.custo ? formatCurrency(log.custo / 100) : '—'}</td>
                    <td className="px-4 py-3">{log.fornecedor ?? '—'}</td>
                    <td className="px-4 py-3 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <button onClick={() => startEdit(log)} className="p-1 text-gray-400 hover:text-brand-600"><Edit2 className="w-4 h-4" /></button>
                        <button onClick={() => handleDelete(log.id)} className="p-1 text-gray-400 hover:text-red-500"><Trash2 className="w-4 h-4" /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Mobile: cards */}
        <div className="md:hidden space-y-2.5">
          {logs.map((log) => {
            const typeLabel = types.find((t) => t.value === log.tipo)?.label ?? log.tipo;
            return (
              <div key={log.id} className="rounded-2xl border bg-white p-3.5 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-[15px] truncate">{typeLabel}</p>
                    <p className="text-[12.5px] text-gray-500 mt-0.5">Realizada {formatDate(log.dataRealizada)}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => startEdit(log)} aria-label="Editar" className="p-2 text-gray-400 hover:text-brand-600"><Edit2 className="w-4 h-4" /></button>
                    <button onClick={() => handleDelete(log.id)} aria-label="Excluir" className="p-2 text-gray-400 hover:text-red-500"><Trash2 className="w-4 h-4" /></button>
                  </div>
                </div>
                <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
                  {log.dataProxima && (
                    <span className={daysUntil(log.dataProxima).color}>
                      Próxima {formatDate(log.dataProxima)} ({daysUntil(log.dataProxima).text})
                    </span>
                  )}
                  {projectType === 'CARRO' && log.quilometragem != null && (
                    <span className="text-gray-500 font-mono">{log.quilometragem.toLocaleString()} km</span>
                  )}
                  {log.fornecedor && <span className="text-gray-500">{log.fornecedor}</span>}
                </div>
                {log.custo ? (
                  <p className="mt-2 text-[15px] font-bold font-mono">{formatCurrency(log.custo / 100)}</p>
                ) : null}
              </div>
            );
          })}
        </div>
        </>
      )}
    </div>
  );
}
