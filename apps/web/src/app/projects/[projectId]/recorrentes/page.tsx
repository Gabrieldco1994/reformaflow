'use client';

import { useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Repeat } from 'lucide-react';
import { useProject } from '@/contexts/project-context';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import type { RecurrenceSerie } from './_types';
import { RecorrenteRow } from './_components/RecorrenteRow';
import { EditRecorrenteModal } from './_components/EditRecorrenteModal';

export default function RecorrentesPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const { projectType } = useProject();
  const qc = useQueryClient();

  const [editando, setEditando] = useState<RecurrenceSerie | null>(null);

  const { data, isLoading, error } = useQuery<RecurrenceSerie[]>({
    queryKey: ['recurrences', projectId],
    queryFn: () => api.get(`/projects/${projectId}/recurrences`),
    enabled: !!projectId,
  });

  // A edição mexe em despesas reais → invalida tudo que deriva de despesa
  // (cockpit, visão conta, cashflow), não só esta lista.
  const invalidate = () => {
    qc.invalidateQueries();
    setEditando(null);
  };

  const update = useMutation({
    mutationFn: ({ key, dto }: { key: string; dto: { valor?: number; tipoDespesa?: string } }) =>
      api.patch(`/projects/${projectId}/recurrences/${key}`, dto),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (key: string) => api.delete(`/projects/${projectId}/recurrences/${key}`),
    onSuccess: invalidate,
  });

  const series = useMemo(
    () => [...(data ?? [])].sort((a, b) => b.valorCents - a.valorCents),
    [data],
  );
  const totalMes = series
    .filter((s) => s.ocorrenciasFuturas > 0)
    .reduce((acc, s) => acc + s.valorCents, 0);

  if (projectType && projectType !== 'PESSOAL') {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-600 shadow-sm">
        As <strong>despesas recorrentes</strong> estão disponíveis apenas para projetos do tipo{' '}
        <strong>Pessoal</strong>.
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4">
      <header className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
            <Repeat className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0 leading-tight">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
              Contas que se repetem
            </p>
            <h1 className="truncate text-base font-bold tracking-tight text-slate-950 xl:text-lg">
              Recorrentes
            </h1>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-slate-500">
          Tudo que você criou como despesa recorrente. Editar o valor ou a categoria vale apenas
          para as ocorrências <strong>futuras</strong> — o histórico já pago não muda. Excluir apaga
          só o que ainda está por vir.
        </p>
      </header>

      <section className="grid grid-cols-2 gap-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Ativas</p>
          <p className="mt-1 text-lg font-bold tabular-nums text-slate-900">
            {series.filter((s) => s.ocorrenciasFuturas > 0).length}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Por mês
          </p>
          <p className="mt-1 text-lg font-bold tabular-nums text-slate-900">
            {formatCurrency(totalMes / 100)}
          </p>
        </div>
      </section>

      {error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Não foi possível carregar as recorrentes: {(error as Error).message}
        </div>
      ) : isLoading ? (
        <p className="py-8 text-center text-sm text-slate-500">Carregando…</p>
      ) : series.length === 0 ? (
        <p className="py-10 text-center text-sm text-slate-500">
          Nenhuma despesa recorrente ainda. Crie uma marcando <strong>&quot;repetir&quot;</strong> ao
          lançar uma despesa.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {series.map((s) => (
            <RecorrenteRow
              key={s.key}
              serie={s}
              onEdit={() => setEditando(s)}
              onDelete={() => {
                if (s.ocorrenciasFuturas === 0) {
                  alert('Esta recorrência não tem ocorrências futuras — nada a excluir.');
                  return;
                }
                if (
                  confirm(
                    `Excluir as ${s.ocorrenciasFuturas} ocorrências futuras de "${s.nome}"? As já pagas continuam no histórico.`,
                  )
                ) {
                  remove.mutate(s.key);
                }
              }}
            />
          ))}
        </ul>
      )}

      {editando && (
        <EditRecorrenteModal
          serie={editando}
          projectType={projectType ?? 'PESSOAL'}
          saving={update.isPending}
          onClose={() => setEditando(null)}
          onSave={(dto) => update.mutate({ key: editando.key, dto })}
        />
      )}
    </div>
  );
}
