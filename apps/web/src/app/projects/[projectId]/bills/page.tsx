'use client';

import { useProject } from '@/contexts/project-context';
import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { Plus, Pause, Play, Trash2, Edit2, Check, X } from 'lucide-react';

const CATEGORIAS = [
  { value: 'LUZ', label: 'Luz' },
  { value: 'AGUA', label: 'Água' },
  { value: 'INTERNET', label: 'Internet' },
  { value: 'IPTU', label: 'IPTU' },
  { value: 'CONDOMINIO', label: 'Condomínio' },
  { value: 'SEGURO', label: 'Seguro' },
  { value: 'GAS', label: 'Gás' },
  { value: 'TELEFONE', label: 'Telefone' },
  { value: 'STREAMING', label: 'Streaming' },
  { value: 'OUTRO', label: 'Outro' },
];

const FREQUENCIAS = [
  { value: 'MENSAL', label: 'Mensal' },
  { value: 'BIMESTRAL', label: 'Bimestral' },
  { value: 'TRIMESTRAL', label: 'Trimestral' },
  { value: 'SEMESTRAL', label: 'Semestral' },
  { value: 'ANUAL', label: 'Anual' },
];

interface RecurringBill {
  id: string;
  nome: string;
  valor: number;
  categoria: string;
  frequencia: string;
  diaVencimento: number;
  status: string;
  ultimoPagamento?: string;
  proximoVencimento?: string;
  observacoes?: string;
}

const emptyBill = {
  nome: '',
  valor: 0,
  categoria: 'LUZ',
  frequencia: 'MENSAL',
  diaVencimento: 10,
  status: 'ATIVO',
  observacoes: '',
};

export default function BillsPage() {
  const { projectId } = useProject();
  const [bills, setBills] = useState<RecurringBill[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyBill);

  useEffect(() => { loadBills(); }, [projectId]);

  async function loadBills() {
    try {
      const data = await api.get<RecurringBill[]>(`/projects/${projectId}/recurring-bills`);
      setBills(data);
    } catch { /* empty */ } finally { setLoading(false); }
  }

  async function handleSave() {
    try {
      const body = { ...form, valor: Math.round(form.valor * 100) };
      if (editingId) {
        await api.patch(`/projects/${projectId}/recurring-bills/${editingId}`, body);
      } else {
        await api.post(`/projects/${projectId}/recurring-bills`, body);
      }
      setShowForm(false);
      setEditingId(null);
      setForm(emptyBill);
      loadBills();
    } catch (err) { console.error(err); }
  }

  async function handleDelete(id: string) {
    if (!confirm('Excluir esta conta?')) return;
    try {
      await api.delete(`/projects/${projectId}/recurring-bills/${id}`);
      setBills((prev) => prev.filter((b) => b.id !== id));
    } catch (err) { console.error(err); }
  }

  async function toggleStatus(bill: RecurringBill) {
    const newStatus = bill.status === 'ATIVO' ? 'PAUSADO' : 'ATIVO';
    try {
      await api.patch(`/projects/${projectId}/recurring-bills/${bill.id}`, { status: newStatus });
      loadBills();
    } catch (err) { console.error(err); }
  }

  function startEdit(bill: RecurringBill) {
    setForm({
      nome: bill.nome,
      valor: bill.valor / 100,
      categoria: bill.categoria,
      frequencia: bill.frequencia,
      diaVencimento: bill.diaVencimento,
      status: bill.status,
      observacoes: bill.observacoes ?? '',
    });
    setEditingId(bill.id);
    setShowForm(true);
  }

  if (loading) {
    return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600"></div></div>;
  }

  const totalMensal = bills
    .filter((b) => b.status === 'ATIVO')
    .reduce((sum, b) => {
      const multiplier: Record<string, number> = { MENSAL: 1, BIMESTRAL: 0.5, TRIMESTRAL: 1/3, SEMESTRAL: 1/6, ANUAL: 1/12 };
      return sum + b.valor * (multiplier[b.frequencia] ?? 1);
    }, 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Contas Recorrentes</h1>
          <p className="text-sm text-gray-500 mt-1">
            Total mensal estimado: <span className="font-semibold text-brand-700">{formatCurrency(totalMensal / 100)}</span>
          </p>
        </div>
        <button
          onClick={() => { setForm(emptyBill); setEditingId(null); setShowForm(true); }}
          className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700"
        >
          <Plus className="w-4 h-4" /> Nova Conta
        </button>
      </div>

      {/* Form modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-xl">
            <h2 className="text-lg font-bold mb-4">{editingId ? 'Editar Conta' : 'Nova Conta'}</h2>
            <div className="space-y-3">
              <input
                type="text" placeholder="Nome da conta" value={form.nome}
                onChange={(e) => setForm((f) => ({ ...f, nome: e.target.value }))}
                className="w-full border rounded-lg px-3 py-2" autoFocus
              />
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-500">Valor (R$)</label>
                  <input
                    type="number" step="0.01" value={form.valor || ''}
                    onChange={(e) => setForm((f) => ({ ...f, valor: parseFloat(e.target.value) || 0 }))}
                    className="w-full border rounded-lg px-3 py-2"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500">Dia Vencimento</label>
                  <input
                    type="number" min={1} max={31} value={form.diaVencimento}
                    onChange={(e) => setForm((f) => ({ ...f, diaVencimento: parseInt(e.target.value) || 1 }))}
                    className="w-full border rounded-lg px-3 py-2"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-500">Categoria</label>
                  <select value={form.categoria} onChange={(e) => setForm((f) => ({ ...f, categoria: e.target.value }))}
                    className="w-full border rounded-lg px-3 py-2">
                    {CATEGORIAS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-500">Frequência</label>
                  <select value={form.frequencia} onChange={(e) => setForm((f) => ({ ...f, frequencia: e.target.value }))}
                    className="w-full border rounded-lg px-3 py-2">
                    {FREQUENCIAS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                </div>
              </div>
              <textarea
                placeholder="Observações (opcional)" value={form.observacoes}
                onChange={(e) => setForm((f) => ({ ...f, observacoes: e.target.value }))}
                className="w-full border rounded-lg px-3 py-2" rows={2}
              />
            </div>
            <div className="flex justify-end gap-3 mt-4">
              <button onClick={() => { setShowForm(false); setEditingId(null); }} className="px-4 py-2 text-gray-600">Cancelar</button>
              <button onClick={handleSave} disabled={!form.nome} className="px-4 py-2 bg-brand-600 text-white rounded-lg disabled:opacity-50">
                {editingId ? 'Salvar' : 'Criar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      {bills.length === 0 ? (
        <div className="text-center py-16 bg-gray-50 rounded-xl border-2 border-dashed">
          <p className="text-4xl mb-4">💡</p>
          <p className="text-gray-600">Nenhuma conta cadastrada</p>
          <p className="text-gray-400 text-sm mt-1">Adicione suas contas recorrentes (luz, água, internet...)</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Conta</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Categoria</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Valor</th>
                <th className="text-center px-4 py-3 font-medium text-gray-600">Frequência</th>
                <th className="text-center px-4 py-3 font-medium text-gray-600">Vencimento</th>
                <th className="text-center px-4 py-3 font-medium text-gray-600">Status</th>
                <th className="text-center px-4 py-3 font-medium text-gray-600">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {bills.map((bill) => {
                const cat = CATEGORIAS.find((c) => c.value === bill.categoria);
                const freq = FREQUENCIAS.find((f) => f.value === bill.frequencia);
                return (
                  <tr key={bill.id} className={bill.status === 'PAUSADO' ? 'opacity-50' : ''}>
                    <td className="px-4 py-3 font-medium">{bill.nome}</td>
                    <td className="px-4 py-3 text-gray-600">{cat?.label ?? bill.categoria}</td>
                    <td className="px-4 py-3 text-right font-mono">{formatCurrency(bill.valor / 100)}</td>
                    <td className="px-4 py-3 text-center">{freq?.label ?? bill.frequencia}</td>
                    <td className="px-4 py-3 text-center">Dia {bill.diaVencimento}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                        bill.status === 'ATIVO' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                      }`}>
                        {bill.status === 'ATIVO' ? 'Ativo' : 'Pausado'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <button onClick={() => toggleStatus(bill)} className="p-1 text-gray-400 hover:text-brand-600" title={bill.status === 'ATIVO' ? 'Pausar' : 'Ativar'}>
                          {bill.status === 'ATIVO' ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                        </button>
                        <button onClick={() => startEdit(bill)} className="p-1 text-gray-400 hover:text-brand-600" title="Editar">
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button onClick={() => handleDelete(bill.id)} className="p-1 text-gray-400 hover:text-red-500" title="Excluir">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
