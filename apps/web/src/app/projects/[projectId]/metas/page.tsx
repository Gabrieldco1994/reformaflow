'use client';
import { useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Target, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { tipoLabel } from '@/lib/expense-options';
import { getExpenseOptions } from '../expenses/_types';
import { currentPeriod, periodLabel } from '../expenses/_lib/personal-hierarchy';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonList } from '@/components/ui/Skeleton';
import { MetaCategoriaCard, type MetaProgress } from './_components/MetaCategoriaCard';
import { MetaFormModal } from './_components/MetaFormModal';

interface Project { id: string; type: string; name: string }
interface BudgetRow { id: string; tipoDespesa: string; mes: string | null; valorLimiteCents: number }

export default function MetasPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const queryClient = useQueryClient();
  const [mes] = useState<string>(() => currentPeriod());
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<{ tipo: string; valor: number } | null>(null);

  const { data: project } = useQuery<Project>({
    queryKey: ['project', projectId],
    queryFn: () => api.get(`/projects/${projectId}`),
  });

  const { data: progress = [], isLoading } = useQuery<MetaProgress[]>({
    queryKey: ['category-budgets', 'progress', projectId, mes],
    queryFn: () => api.get(`/projects/${projectId}/category-budgets/progress?mes=${mes}`),
    enabled: project?.type === 'PESSOAL',
  });

  const { data: budgets = [] } = useQuery<BudgetRow[]>({
    queryKey: ['category-budgets', projectId, mes],
    queryFn: () => api.get(`/projects/${projectId}/category-budgets?mes=${mes}`),
    enabled: project?.type === 'PESSOAL',
  });

  const tipoOptions = useMemo(() => getExpenseOptions('PESSOAL'), []);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['category-budgets'] });
  }

  const upsert = useMutation({
    mutationFn: (vars: { tipoDespesa: string; valorReais: number }) =>
      api.post(`/projects/${projectId}/category-budgets`, {
        tipoDespesa: vars.tipoDespesa,
        mes,
        valorLimiteCents: Math.round(vars.valorReais * 100),
      }),
    onSuccess: () => { toast.success('Meta salva'); invalidate(); setModalOpen(false); setEditing(null); },
    onError: (e: Error) => toast.error(`Erro ao salvar meta: ${e.message}`),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${projectId}/category-budgets/${id}`),
    onSuccess: () => { toast.success('Meta removida'); invalidate(); },
    onError: (e: Error) => toast.error(`Erro ao remover: ${e.message}`),
  });

  function budgetIdOf(tipo: string): string | undefined {
    return budgets.find((b) => b.tipoDespesa === tipo)?.id;
  }

  if (project && project.type !== 'PESSOAL') {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <EmptyState icon={Target} title="Metas indisponíveis" description="Metas por categoria só estão disponíveis em projetos do tipo PESSOAL." />
      </div>
    );
  }

  const totalLimite = progress.reduce((s, p) => s + p.limiteCents, 0);
  const totalGasto = progress.reduce((s, p) => s + p.gastoCents, 0);

  return (
    <div className="mx-auto w-full max-w-3xl lg:max-w-5xl space-y-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-[13px] font-medium text-darc-velvet/50">Análise · {periodLabel(mes)}</p>
          <h1 className="text-2xl font-bold tracking-tight text-darc-velvet">Metas</h1>
        </div>
        <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
          <Plus className="h-4 w-4" /> Nova meta
        </Button>
      </div>

      {/* Hero resumo */}
      {progress.length > 0 && (
        <div className="rounded-3xl bg-darc-gradient-dark p-5 text-darc-linen shadow-darc-hero">
          <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-darc-linen/60">Gasto do mês</p>
          <p className="mt-1 text-3xl font-bold tabular-nums">{(totalGasto / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</p>
          <p className="mt-0.5 text-[12px] text-darc-linen/60">
            de {(totalLimite / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} em metas
          </p>
        </div>
      )}

      {isLoading ? (
        <SkeletonList rows={3} />
      ) : progress.length === 0 ? (
        <EmptyState
          icon={Target}
          title="Nenhuma meta definida"
          description="Crie metas de gasto por categoria para acompanhar seu orçamento no mês."
          action={{ label: 'Criar primeira meta', onClick: () => { setEditing(null); setModalOpen(true); } }}
        />
      ) : (
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-2 lg:gap-3">
          {progress.map((item) => (
            <MetaCategoriaCard
              key={item.tipoDespesa}
              item={item}
              label={tipoLabel(item.tipoDespesa)}
              onEdit={() => { setEditing({ tipo: item.tipoDespesa, valor: item.limiteCents / 100 }); setModalOpen(true); }}
              onDelete={() => { const id = budgetIdOf(item.tipoDespesa); if (id && confirm('Remover meta?')) remove.mutate(id); }}
            />
          ))}
        </div>
      )}

      <MetaFormModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditing(null); }}
        onSave={(tipoDespesa, valorReais) => upsert.mutate({ tipoDespesa, valorReais })}
        tipoOptions={tipoOptions}
        fixedTipo={editing?.tipo ?? null}
        initialValor={editing?.valor}
        isPending={upsert.isPending}
      />
    </div>
  );
}
