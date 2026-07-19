'use client';

import { useProject } from '@/contexts/project-context';
import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { Plus } from 'lucide-react';
import type { ProjectType } from '@reformaflow/domain';
import type { RecurringBillRow } from './_display';
import { RecurringBillsView } from './_components/RecurringBillsView';
import { AvulsasTab } from './_components/AvulsasTab';
import { BillsKpiHeader } from './_components/BillsKpiHeader';
import { computeBillsKpis } from './_lib/kpis';
import RecurringBillFormModal from './_components/RecurringBillFormModal';

type RecurringBill = RecurringBillRow;

export default function BillsPage() {
  const { projectId, projectType } = useProject();
  const [activeTab, setActiveTab] = useState<'recorrentes' | 'avulsas'>('recorrentes');
  const [bills, setBills] = useState<RecurringBill[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingBill, setEditingBill] = useState<RecurringBillRow | null>(null);

  useEffect(() => { loadBills(); }, [projectId]);

  async function loadBills() {
    try {
      const data = await api.get<RecurringBill[]>(`/projects/${projectId}/recurring-bills`);
      setBills(data);
    } catch { /* empty */ } finally { setLoading(false); }
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
    setEditingBill(bill);
    setShowForm(true);
  }

  function openCreate() {
    setEditingBill(null);
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditingBill(null);
  }

  function handleSaved() {
    closeForm();
    loadBills();
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
          onToggleStatus={toggleStatus}
          onEdit={startEdit}
          onDelete={handleDelete}
          onCreateClick={openCreate}
        />
      )}

      {showForm && (
        <RecurringBillFormModal
          projectId={projectId}
          projectType={projectType}
          bill={editingBill}
          onClose={closeForm}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}

interface RecorrentesContentProps {
  loading: boolean;
  bills: RecurringBill[];
  onToggleStatus: (bill: RecurringBill) => Promise<void>;
  onEdit: (bill: RecurringBill) => void;
  onDelete: (id: string) => Promise<void>;
  onCreateClick: () => void;
}

function RecorrentesContent({
  loading,
  bills,
  onToggleStatus,
  onEdit,
  onDelete,
  onCreateClick,
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
          onClick={onCreateClick}
          className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700"
        >
          <Plus className="w-4 h-4" /> Nova conta recorrente
        </button>
      </div>

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
          onToggleStatus={onToggleStatus}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      )}
    </div>
  );
}
