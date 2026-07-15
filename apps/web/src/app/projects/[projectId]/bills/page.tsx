'use client';

import { useProject } from '@/contexts/project-context';
import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { Plus } from 'lucide-react';
import type { ProjectType } from '@reformaflow/domain';
import { BILL_CATEGORIES, BILL_FREQUENCIES, type RecurringBillRow } from './_display';
import { RecurringBillsView } from './_components/RecurringBillsView';
import { AvulsasTab } from './_components/AvulsasTab';
import { BillsKpiHeader } from './_components/BillsKpiHeader';
import { computeBillsKpis } from './_lib/kpis';
import { centsToReaisInput, currencyInputToNumber, maskCurrencyInput } from '@/lib/currency-input';

type RecurringBill = RecurringBillRow;

const emptyBill = {
  nome: '',
  valor: '',
  categoria: 'LUZ',
  frequencia: 'MENSAL',
  diaVencimento: 10,
  status: 'ATIVO',
  observacoes: '',
};

export default function BillsPage() {
  const { projectId, projectType } = useProject();
  const [activeTab, setActiveTab] = useState<'recorrentes' | 'avulsas'>('recorrentes');
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
      const body = { ...form, valor: Math.round(currencyInputToNumber(form.valor) * 100) };
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
      valor: centsToReaisInput(bill.valor),
      categoria: bill.categoria,
      frequencia: bill.frequencia,
      diaVencimento: bill.diaVencimento,
      status: bill.status,
      observacoes: bill.observacoes ?? '',
    });
    setEditingId(bill.id);
    setShowForm(true);
  }

  const billsKpis = computeBillsKpis(bills, new Date());

  return (
    <div className="space-y-4">
      {/* Header com tabs */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-gray-900">Contas</h1>
          <div className="inline-flex rounded-lg border border-gray-200 text-sm overflow-hidden">
            <button
              onClick={() => setActiveTab('recorrentes')}
              className={`px-4 py-1.5 transition-colors font-medium ${
                activeTab === 'recorrentes'
                  ? 'bg-brand-600 text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              Recorrentes
            </button>
            <button
              onClick={() => setActiveTab('avulsas')}
              className={`px-4 py-1.5 transition-colors font-medium border-l border-gray-200 ${
                activeTab === 'avulsas'
                  ? 'bg-brand-600 text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              Avulsas
            </button>
          </div>
        </div>
      </div>

      {activeTab === 'recorrentes' && <BillsKpiHeader {...billsKpis} />}

      {activeTab === 'avulsas' ? (
        <AvulsasTab projectId={projectId} projectType={projectType as ProjectType} />
      ) : (
        <RecorrentesContent
          loading={loading}
          bills={bills}
          form={form}
          setForm={setForm}
          showForm={showForm}
          setShowForm={setShowForm}
          editingId={editingId}
          setEditingId={setEditingId}
          handleSave={handleSave}
          handleDelete={handleDelete}
          toggleStatus={toggleStatus}
          startEdit={startEdit}
          projectType={projectType}
        />
      )}
    </div>
  );
}

interface RecorrentesContentProps {
  loading: boolean;
  bills: RecurringBill[];
  form: typeof emptyBill;
  setForm: React.Dispatch<React.SetStateAction<typeof emptyBill>>;
  showForm: boolean;
  setShowForm: React.Dispatch<React.SetStateAction<boolean>>;
  editingId: string | null;
  setEditingId: React.Dispatch<React.SetStateAction<string | null>>;
  handleSave: () => Promise<void>;
  handleDelete: (id: string) => Promise<void>;
  toggleStatus: (bill: RecurringBill) => Promise<void>;
  startEdit: (bill: RecurringBill) => void;
  projectType: string;
}

function RecorrentesContent({
  loading,
  bills,
  form,
  setForm,
  showForm,
  setShowForm,
  editingId,
  setEditingId,
  handleSave,
  handleDelete,
  toggleStatus,
  startEdit,
  projectType,
}: RecorrentesContentProps) {
  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-end mb-4">
        <button
          onClick={() => {
            setForm(emptyBill);
            setEditingId(null);
            setShowForm(true);
          }}
          className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700"
        >
          <Plus className="w-4 h-4" /> Nova conta recorrente
        </button>
      </div>

      {/* Form modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-xl max-h-[90vh] overflow-y-auto">
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
                    type="text" inputMode="numeric" value={form.valor || ''}
                    onChange={(e) => setForm((f) => ({ ...f, valor: maskCurrencyInput(e.target.value) }))}
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
                    {BILL_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-500">Frequência</label>
                  <select value={form.frequencia} onChange={(e) => setForm((f) => ({ ...f, frequencia: e.target.value }))}
                    className="w-full border rounded-lg px-3 py-2">
                    {BILL_FREQUENCIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                </div>
              </div>
              <textarea
                placeholder="Observações (opcional)" value={form.observacoes}
                onChange={(e) => setForm((f) => ({ ...f, observacoes: e.target.value }))}
                className="w-full border rounded-lg px-3 py-2" rows={2}
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
        <RecurringBillsView
          bills={bills}
          onToggleStatus={toggleStatus}
          onEdit={startEdit}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}
