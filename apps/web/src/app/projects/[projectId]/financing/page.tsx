'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Landmark, Save } from 'lucide-react';
import { useProject } from '@/contexts/project-context';
import { api } from '@/lib/api';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';

interface Installment {
  id: string;
  numeroParcela: number;
  dataVencimento: string;
  valorPrevisto: number;
  saldoDevedorPrevisto: number;
  status: 'PREVISTO' | 'PAGO';
  valorPago: number | null;
  dataPagamento: string | null;
}

interface Financing {
  instituicao: string | null;
  sistema: 'PRICE' | 'SAC';
  valorTotalFinanciado: number;
  taxaJurosMensalBps: number;
  prazoMeses: number;
  dataPrimeiraParcela: string;
  diaVencimento: number;
  observacoes: string | null;
  installments: Installment[];
  summary: {
    valorPago: number;
    saldoDevedor: number;
    progresso: number;
    totalParcelas: number;
    parcelasPagas: number;
    proximaParcela: Installment | null;
  };
}

interface FormState {
  instituicao: string;
  sistema: 'PRICE' | 'SAC';
  valorTotal: string;
  taxaMensal: string;
  prazoMeses: string;
  dataPrimeiraParcela: string;
  diaVencimento: string;
  observacoes: string;
}

const emptyForm: FormState = {
  instituicao: '',
  sistema: 'PRICE',
  valorTotal: '',
  taxaMensal: '',
  prazoMeses: '',
  dataPrimeiraParcela: '',
  diaVencimento: '',
  observacoes: '',
};

function decimal(value: string): number {
  return Number(value.replace(',', '.'));
}

function localDate(): string {
  const today = new Date();
  return [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0'),
  ].join('-');
}

export default function FinancingPage() {
  const { projectId } = useProject();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [message, setMessage] = useState('');

  const financingQuery = useQuery<Financing | null>({
    queryKey: ['financing', projectId],
    queryFn: () => api.get(`/projects/${projectId}/financing`),
  });

  useEffect(() => {
    const financing = financingQuery.data;
    if (!financing) return;
    setForm({
      instituicao: financing.instituicao ?? '',
      sistema: financing.sistema,
      valorTotal: (financing.valorTotalFinanciado / 100).toFixed(2),
      taxaMensal: (financing.taxaJurosMensalBps / 100).toFixed(2),
      prazoMeses: String(financing.prazoMeses),
      dataPrimeiraParcela: financing.dataPrimeiraParcela.slice(0, 10),
      diaVencimento: String(financing.diaVencimento),
      observacoes: financing.observacoes ?? '',
    });
  }, [financingQuery.data]);

  const save = useMutation({
    mutationFn: () =>
      api.put(`/projects/${projectId}/financing`, {
        instituicao: form.instituicao.trim() || undefined,
        sistema: form.sistema,
        valorTotalFinanciado: Math.round(decimal(form.valorTotal) * 100),
        taxaJurosMensalBps: Math.round(decimal(form.taxaMensal) * 100),
        prazoMeses: Number(form.prazoMeses),
        dataPrimeiraParcela: form.dataPrimeiraParcela,
        diaVencimento: Number(form.diaVencimento),
        observacoes: form.observacoes.trim() || undefined,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['financing', projectId] });
      setMessage('Financiamento salvo.');
    },
  });

  const pay = useMutation({
    mutationFn: (installment: Installment) =>
      api.patch(`/projects/${projectId}/financing/installments/${installment.id}/pay`, {
        valorPago: installment.valorPrevisto,
        dataPagamento: localDate(),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['financing', projectId] });
      setMessage('Parcela marcada como paga.');
    },
  });

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  if (financingQuery.isLoading) return <p className="text-darc-velvet/60">Carregando financiamento...</p>;
  if (financingQuery.isError) return <p className="text-darc-red">Erro ao carregar o financiamento.</p>;

  const financing = financingQuery.data;
  const mutationError = save.error ?? pay.error;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <header className="flex items-center gap-3">
        <Landmark className="h-7 w-7 text-darc-red" />
        <div>
          <h1 className="font-editorial text-2xl italic text-darc-velvet">Financiamento</h1>
          <p className="text-sm text-darc-velvet/60">Projeção PRICE ou SAC e histórico de parcelas.</p>
        </div>
      </header>

      {financing && (
        <section className="rounded-2xl border border-darc-linen bg-white p-4 shadow-darc-soft">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <div><p className="text-xs text-darc-velvet/60">Financiado</p><p className="font-bold">{formatCurrency(financing.valorTotalFinanciado / 100)}</p></div>
            <div><p className="text-xs text-darc-velvet/60">Pago</p><p className="font-bold">{formatCurrency(financing.summary.valorPago / 100)}</p></div>
            <div><p className="text-xs text-darc-velvet/60">Saldo devedor</p><p className="font-bold">{formatCurrency(financing.summary.saldoDevedor / 100)}</p></div>
            <div><p className="text-xs text-darc-velvet/60">Próxima parcela</p><p className="font-bold">{financing.summary.proximaParcela ? formatCurrency(financing.summary.proximaParcela.valorPrevisto / 100) : 'Quitado'}</p></div>
          </div>
          <div
            role="progressbar"
            aria-label="Progresso do financiamento"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={financing.summary.progresso}
            className="mt-4 h-3 overflow-hidden rounded-full bg-darc-linen"
          >
            <div className="h-full bg-darc-red" style={{ width: `${financing.summary.progresso}%` }} />
          </div>
          <p className="mt-1 text-xs text-darc-velvet/60">
            {financing.summary.parcelasPagas} de {financing.summary.totalParcelas} parcelas pagas
          </p>
        </section>
      )}

      <form
        className="space-y-4 rounded-2xl border border-darc-linen bg-white p-4 shadow-darc-soft"
        onSubmit={(event) => {
          event.preventDefault();
          setMessage('');
          save.mutate();
        }}
      >
        <h2 className="font-semibold text-darc-velvet">Dados do contrato</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <label className="text-sm text-darc-velvet">Instituição
            <Input value={form.instituicao} onChange={(event) => setField('instituicao', event.target.value)} />
          </label>
          <Select
            id="financing-system"
            label="Sistema"
            value={form.sistema}
            options={[{ value: 'PRICE', label: 'PRICE' }, { value: 'SAC', label: 'SAC' }]}
            onChange={(event) => setField('sistema', event.target.value as FormState['sistema'])}
            required
          />
          <label className="text-sm text-darc-velvet">Valor financiado (R$)
            <Input type="number" min="0.01" step="0.01" value={form.valorTotal} onChange={(event) => setField('valorTotal', event.target.value)} required />
          </label>
          <label className="text-sm text-darc-velvet">Taxa mensal (%)
            <Input type="number" min="0" step="0.01" value={form.taxaMensal} onChange={(event) => setField('taxaMensal', event.target.value)} required />
          </label>
          <label className="text-sm text-darc-velvet">Prazo (meses)
            <Input type="number" min="1" max="600" value={form.prazoMeses} onChange={(event) => setField('prazoMeses', event.target.value)} required />
          </label>
          <label className="text-sm text-darc-velvet">Primeira parcela
            <Input type="date" value={form.dataPrimeiraParcela} onChange={(event) => setField('dataPrimeiraParcela', event.target.value)} required />
          </label>
          <label className="text-sm text-darc-velvet">Dia do vencimento
            <Input type="number" min="1" max="31" value={form.diaVencimento} onChange={(event) => setField('diaVencimento', event.target.value)} required />
          </label>
          <label className="text-sm text-darc-velvet sm:col-span-2">Observações
            <Input value={form.observacoes} onChange={(event) => setField('observacoes', event.target.value)} />
          </label>
        </div>
        <Button type="submit" className="min-h-[44px]" disabled={save.isPending}>
          <Save className="h-4 w-4" />
          {save.isPending ? 'Salvando...' : 'Salvar financiamento'}
        </Button>
        {message && <p role="status" className="text-sm text-green-700">{message}</p>}
        {mutationError && <p role="alert" className="text-sm text-darc-red">{mutationError.message}</p>}
      </form>

      {financing && (
        <section className="overflow-hidden rounded-2xl border border-darc-linen bg-white shadow-darc-soft">
          <h2 className="p-4 font-semibold text-darc-velvet">Parcelas</h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-sm">
              <thead className="bg-darc-linen/50 text-left text-xs uppercase tracking-wider text-darc-velvet/60">
                <tr><th className="p-3">Parcela</th><th className="p-3">Vencimento</th><th className="p-3 text-right">Previsto</th><th className="p-3 text-right">Saldo</th><th className="p-3">Status</th><th className="p-3"><span className="sr-only">Ação</span></th></tr>
              </thead>
              <tbody className="divide-y divide-darc-linen">
                {financing.installments.map((installment) => (
                  <tr key={installment.id}>
                    <td className="p-3">{installment.numeroParcela}/{financing.summary.totalParcelas}</td>
                    <td className="p-3">{formatDateBR(installment.dataVencimento)}</td>
                    <td className="p-3 text-right">{formatCurrency(installment.valorPrevisto / 100)}</td>
                    <td className="p-3 text-right">{formatCurrency(installment.saldoDevedorPrevisto / 100)}</td>
                    <td className="p-3">{installment.status === 'PAGO' ? 'Pago' : 'Previsto'}</td>
                    <td className="p-3 text-right">
                      {installment.status === 'PREVISTO' && (
                        <Button type="button" variant="ghost" className="min-h-[44px]" disabled={pay.isPending} onClick={() => pay.mutate(installment)}>
                          Marcar como paga
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
