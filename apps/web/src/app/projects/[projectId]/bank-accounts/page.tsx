'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import { hasNavRoute, type ProjectType } from '@reformaflow/domain';
import { api } from '@/lib/api';
import { useProject } from '@/contexts/project-context';
import { formatCurrency } from '@/lib/utils';
import { Landmark, Plus, Trash2, Link2, ArrowDownLeft, History } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonList } from '@/components/ui/Skeleton';
import BankAccountFormModal from './_components/BankAccountFormModal';
import BankLinkSuggestionsPanel from './_components/BankLinkSuggestionsPanel';
import BankReceiptLinkPanel from './_components/BankReceiptLinkPanel';
import AccountFormModal from '../_components/AccountFormModal';
import ImportHistoryModal from '../_components/ImportHistoryModal';
import type { BankAccountRow } from './_types';

export default function BankAccountsPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const projectId = String(params?.projectId ?? '');
  const { projectType } = useProject();
  const type = projectType as ProjectType;
  const shouldRedirectToHub = !hasNavRoute(type, 'bank-accounts') && hasNavRoute(type, 'conta');

  const [accounts, setAccounts] = useState<BankAccountRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<BankAccountRow | null>(null);
  const [linksFor, setLinksFor] = useState<BankAccountRow | null>(null);
  const [receiptLinksFor, setReceiptLinksFor] = useState<BankAccountRow | null>(null);
  const [historyFor, setHistoryFor] = useState<BankAccountRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<BankAccountRow[]>(`/projects/${projectId}/bank-accounts`);
      setAccounts(data);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (projectId) void load();
  }, [projectId, load]);

  // Deep-link: ?focus=openingBalance opens the first account for editing (or new form)
  useEffect(() => {
    if (loading || searchParams.get('focus') !== 'openingBalance') return;
    if (accounts.length > 0) {
      setEditing(accounts[0]!);
      setFormOpen(true);
    } else {
      setEditing(null);
      setFormOpen(true);
    }
  }, [loading, accounts, searchParams]);

  useEffect(() => {
    if (shouldRedirectToHub) {
      router.replace(`/projects/${projectId}/conta`);
    }
  }, [shouldRedirectToHub, projectId, router]);

  if (shouldRedirectToHub) {
    return null;
  }

  async function handleDelete(acc: BankAccountRow) {
    if (!confirm(`Excluir conta "${acc.nickname ?? acc.last4}"? As despesas importadas serão mantidas.`)) return;
    await api.delete(`/projects/${projectId}/bank-accounts/${acc.id}`);
    void load();
  }

  const isEmpty = !loading && accounts.length === 0;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Landmark className="w-6 h-6" /> Contas Bancárias
        </h1>
        {/* #490 — mesma decisão do `/credit-cards`: no vazio a CTA primária é a
            do `EmptyState` (com título e explicação), e o token de jornada vai
            com ela. Com contas na tela o cabeçalho volta. */}
        {!isEmpty && (
          <button
            onClick={() => { setEditing(null); setFormOpen(true); }}
            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg flex items-center gap-2 min-h-11"
            data-journey-action="bank-account.new"
          >
            <Plus className="w-4 h-4" /> Nova conta
          </button>
        )}
      </div>

      <p className="text-sm text-gray-600 mb-6">
        Importe extratos em <strong>OFX</strong>, <strong>CSV</strong> ou <strong>PDF</strong>.
        Débitos viram despesas, créditos viram recebimentos e pagamentos de fatura de cartão
        são detectados automaticamente para evitar dupla contagem. Contas de luz/água/gás/internet
        e IPVA viram <strong>recorrências</strong> nos seus projetos de Casa/Carro automaticamente.
      </p>
      {loading ? (
        <SkeletonList rows={2} />
      ) : accounts.length === 0 ? (
        <EmptyState
          icon={Landmark}
          title="Nenhuma conta cadastrada"
          description="Comece adicionando uma conta para importar extratos e acompanhar seu saldo."
          action={{
            label: 'Nova conta',
            onClick: () => { setEditing(null); setFormOpen(true); },
            journeyAction: 'bank-account.new',
          }}
        />
      ) : (
        <div className="grid gap-3">
          {accounts.map((a) => {
            const balanceCents = a.balanceCents ?? 0;
            return (
              <div key={a.id} className="rounded-lg border border-darc-linen bg-white p-4 flex items-center justify-between gap-4">
                <div>
                  <div className="font-semibold text-darc-velvet">
                    {a.nickname ?? `${a.institution} ****${a.last4}`}
                  </div>
                  <div className="text-xs text-gray-500">
                    {a.institution} · final {a.last4}
                    {a.agency && <> · ag {a.agency}</>}
                    {a.accountNumber && <> · cc {a.accountNumber}</>}
                  </div>
                  <div className="mt-3">
                    <div className="text-xs uppercase tracking-wide text-darc-velvet/60">Saldo</div>
                    <div className={`text-lg font-bold ${balanceCents >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                      {formatCurrency(balanceCents / 100)}
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <button
                    onClick={() => setLinksFor(a)}
                    className="px-3 py-2 text-sm border rounded-lg flex items-center gap-1 hover:bg-gray-50"
                  >
                    <Link2 className="w-4 h-4" /> Vincular despesas
                  </button>
                  <button
                    onClick={() => setReceiptLinksFor(a)}
                    className="px-3 py-2 text-sm border rounded-lg flex items-center gap-1 hover:bg-gray-50"
                  >
                    <ArrowDownLeft className="w-4 h-4" /> Vincular recebimentos
                  </button>
                  <button
                    onClick={() => setHistoryFor(a)}
                    className="px-3 py-2 text-sm border rounded-lg flex items-center gap-1 hover:bg-gray-50"
                  >
                    <History className="w-4 h-4" /> Importações
                  </button>
                  <button
                    onClick={() => { setEditing(a); setFormOpen(true); }}
                    className="px-3 py-2 text-sm border rounded-lg hover:bg-gray-50"
                  >
                    Editar
                  </button>
                  <button
                    onClick={() => handleDelete(a)}
                    className="px-3 py-2 text-sm border border-red-200 text-red-600 rounded-lg hover:bg-red-50"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {formOpen && (
        editing ? (
          <BankAccountFormModal
            projectId={projectId}
            account={editing}
            onClose={() => { setFormOpen(false); setEditing(null); }}
            onSaved={() => { setFormOpen(false); setEditing(null); void load(); }}
          />
        ) : (
          <AccountFormModal
            projectId={projectId}
            defaultType="BANK"
            onClose={() => setFormOpen(false)}
            onSaved={() => { setFormOpen(false); void load(); }}
          />
        )
      )}
      {linksFor && (
        <BankLinkSuggestionsPanel
          projectId={projectId}
          account={linksFor}
          onClose={() => setLinksFor(null)}
        />
      )}
      {receiptLinksFor && (
        <BankReceiptLinkPanel
          projectId={projectId}
          account={receiptLinksFor}
          onClose={() => setReceiptLinksFor(null)}
        />
      )}
      {historyFor && (
        <ImportHistoryModal
          basePath={`/projects/${projectId}/bank-accounts/${historyFor.id}`}
          title={`Importações · ${historyFor.nickname ?? `final ${historyFor.last4}`}`}
          onClose={() => setHistoryFor(null)}
          onUndone={() => void load()}
        />
      )}
    </div>
  );
}
