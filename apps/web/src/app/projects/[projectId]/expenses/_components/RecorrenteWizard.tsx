'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarRange } from 'lucide-react';
import { buildRecurrenceDates, hasFeature, type ProjectType, type RecurrenceFrequency } from '@reformaflow/domain';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Modal } from '@/components/ui/modal';
import { fmtMoneyExact } from '../../monthly/_cockpit/format';

interface Option {
  value: string;
  label: string;
}

interface TenantCard {
  id: string;
  nickname?: string | null;
  brand: string;
  last4: string;
  project?: { id: string; name: string; type: string } | null;
}

interface TenantAccount {
  id: string;
  nickname?: string | null;
  institution: string;
  last4?: string | null;
  project?: { id: string; name: string; type: string } | null;
}

interface ProjectLite {
  id: string;
  name: string;
  type: string;
}

interface Props {
  open: boolean;
  projectId: string;
  tipoOptions: Option[];
  onClose: () => void;
  onCreated?: () => void;
}

const FREQ_OPTIONS: Option[] = [
  { value: 'MENSAL', label: 'Mensal (todo mês)' },
  { value: 'QUINZENAL', label: 'Quinzenal (a cada 15 dias)' },
];

/**
 * Jornada de DESPESA RECORRENTE: reúne os dados-base da despesa + o período
 * (início, fim) e a frequência (mensal/quinzenal), e gera N despesas planejadas
 * via `POST /expenses/recorrente`. Cada ocorrência é uma despesa normal, então
 * entra em todos os KPIs / Visão Conta / cockpit. Editar o valor de uma delas é
 * um PATCH normal na lista de despesas.
 */
export function RecorrenteWizard({ open, projectId, tipoOptions, onClose, onCreated }: Props) {
  const queryClient = useQueryClient();

  const [tipoDespesa, setTipoDespesa] = useState('');
  const [valor, setValor] = useState('');
  const [titulo, setTitulo] = useState('');
  const [fornecedor, setFornecedor] = useState('');
  const [frequencia, setFrequencia] = useState<RecurrenceFrequency>('MENSAL');
  const [dataInicio, setDataInicio] = useState('');
  const [dataFim, setDataFim] = useState('');
  const [creditCardId, setCreditCardId] = useState('');
  const [bankAccountId, setBankAccountId] = useState('');
  const [obraProjectId, setObraProjectId] = useState('');

  const { data: cards = [] } = useQuery<TenantCard[]>({
    queryKey: ['tenant', 'credit-cards'],
    queryFn: () => api.get('/tenant/credit-cards'),
    staleTime: 60_000,
    enabled: open,
  });
  const { data: accounts = [] } = useQuery<TenantAccount[]>({
    queryKey: ['tenant', 'bank-accounts'],
    queryFn: () => api.get('/tenant/bank-accounts'),
    staleTime: 60_000,
    enabled: open,
  });
  const { data: projects = [] } = useQuery<ProjectLite[]>({
    queryKey: ['tenant', 'projects'],
    queryFn: () => api.get('/projects'),
    staleTime: 60_000,
    enabled: open,
  });

  // Projetos de OBRA (não-PESSOAL, com módulo de despesas) — alvo do par cross-project.
  const obraOptions = useMemo(() => {
    const opts = [{ value: '', label: 'Só pessoal (sem obra)' }];
    for (const p of projects) {
      if (p.id === projectId) continue;
      if (p.type === 'PESSOAL') continue;
      if (!hasFeature(p.type as ProjectType, 'expenses')) continue;
      opts.push({ value: p.id, label: `${p.name} · ${p.type}` });
    }
    return opts;
  }, [projects, projectId]);

  const cardOptions = useMemo(() => {
    const opts = [{ value: '', label: 'Nenhum' }];
    for (const c of cards) {
      const proj = c.project?.name ? ` · ${c.project.name}` : '';
      opts.push({ value: c.id, label: `${c.nickname || c.brand} ****${c.last4}${proj}` });
    }
    return opts;
  }, [cards]);

  const accountOptions = useMemo(() => {
    const opts = [{ value: '', label: 'Nenhuma' }];
    for (const a of accounts) {
      const proj = a.project?.name ? ` · ${a.project.name}` : '';
      const tail = a.last4 ? ` ****${a.last4}` : '';
      opts.push({ value: a.id, label: `${a.nickname || a.institution}${tail}${proj}` });
    }
    return opts;
  }, [accounts]);

  // Preview client-side das ocorrências (mesma lógica do backend, via domain).
  const preview = useMemo(() => {
    if (!dataInicio || !dataFim) return null;
    const inicio = new Date(`${dataInicio}T00:00:00.000Z`);
    const fim = new Date(`${dataFim}T00:00:00.000Z`);
    if (Number.isNaN(inicio.getTime()) || Number.isNaN(fim.getTime())) return null;
    const dates = buildRecurrenceDates({ inicio, fim, frequencia });
    const valorCents = Math.round(Number(valor) * 100) || 0;
    return { count: dates.length, totalCents: dates.length * valorCents };
  }, [dataInicio, dataFim, frequencia, valor]);

  const valido =
    tipoDespesa !== '' &&
    Number(valor) > 0 &&
    dataInicio !== '' &&
    dataFim !== '' &&
    (preview?.count ?? 0) > 0;

  const mutation = useMutation({
    mutationFn: () =>
      api.post<{ count: number }>(`/projects/${projectId}/expenses/recorrente`, {
        tipoDespesa,
        valor: Number(valor),
        titulo: titulo.trim() || undefined,
        fornecedor: fornecedor.trim() || undefined,
        frequencia,
        dataInicio,
        dataFim,
        creditCardId: creditCardId || undefined,
        bankAccountId: bankAccountId || undefined,
        obraProjectId: obraProjectId || undefined,
      }),
    onSuccess: (res) => {
      toast.success(`${res.count} despesa(s) recorrente(s) criada(s)`);
      for (const key of ['expenses', 'cash-flow', 'account-view', 'monthly-overview', 'dashboard']) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
      reset();
      onCreated?.();
      onClose();
    },
    onError: (e: Error) => toast.error(`Erro ao criar recorrência: ${e.message}`),
  });

  function reset() {
    setTipoDespesa('');
    setValor('');
    setTitulo('');
    setFornecedor('');
    setFrequencia('MENSAL');
    setDataInicio('');
    setDataFim('');
    setCreditCardId('');
    setBankAccountId('');
    setObraProjectId('');
  }

  return (
    <Modal open={open} onClose={onClose} title="Despesa recorrente" size="lg">
      <div className="space-y-4">
        <p className="flex items-center gap-2 rounded-xl bg-[#EFE6FA] px-3 py-2 text-xs text-[#7A3FC2]">
          <CalendarRange className="h-4 w-4 shrink-0" />
          Gera uma despesa planejada por ocorrência no período. Cada uma é editável e conta nos seus KPIs.
        </p>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select
            label="Tipo de despesa"
            options={tipoOptions}
            value={tipoDespesa}
            onChange={(e) => setTipoDespesa(e.target.value)}
          />
          <Input
            label="Valor de cada ocorrência (R$)"
            type="number"
            min={0}
            step="0.01"
            value={valor}
            onChange={(e) => setValor(e.target.value)}
            placeholder="500,00"
          />
          <Input
            label="Título"
            value={titulo}
            onChange={(e) => setTitulo(e.target.value)}
            placeholder="Ex.: Aluguel"
          />
          <Input
            label="Fornecedor (opcional)"
            value={fornecedor}
            onChange={(e) => setFornecedor(e.target.value)}
            placeholder="Ex.: Imobiliária X"
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Select
            label="Frequência"
            options={FREQ_OPTIONS}
            value={frequencia}
            onChange={(e) => setFrequencia(e.target.value as RecurrenceFrequency)}
          />
          <Input
            label="Início"
            type="date"
            value={dataInicio}
            onChange={(e) => setDataInicio(e.target.value)}
          />
          <Input
            label="Fim"
            type="date"
            value={dataFim}
            onChange={(e) => setDataFim(e.target.value)}
          />
        </div>

        <div className="border-t pt-3">
          <Select
            label="Projeto de obra (opcional — cria par obra + espelho pessoal)"
            options={obraOptions}
            value={obraProjectId}
            onChange={(e) => setObraProjectId(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 border-t pt-3">
          <Select
            label="Pago no cartão (opcional)"
            options={cardOptions}
            value={creditCardId}
            onChange={(e) => setCreditCardId(e.target.value)}
          />
          <Select
            label="Paga pela conta (opcional)"
            options={accountOptions}
            value={bankAccountId}
            onChange={(e) => setBankAccountId(e.target.value)}
          />
        </div>

        {preview && preview.count > 0 && (
          <div className="rounded-xl border border-darc-linen bg-slate-50 px-3 py-2.5 text-sm text-darc-velvet">
            Vai gerar <strong>{preview.count}</strong> despesa{preview.count === 1 ? '' : 's'} planejada
            {preview.count === 1 ? '' : 's'}
            {obraProjectId && (
              <> (par obra + espelho pessoal por ocorrência = <strong>{preview.count * 2}</strong> lançamentos)</>
            )}
            {preview.totalCents > 0 && (
              <> — total de <strong>{fmtMoneyExact(preview.totalCents)}</strong></>
            )}
            .
          </div>
        )}
        {preview && preview.count === 0 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
            A data final está antes da inicial — ajuste o período.
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={!valido || mutation.isPending}
          >
            {mutation.isPending ? 'Gerando…' : 'Gerar despesas'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
