'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, SkipForward } from 'lucide-react';
import { hasFeature } from '@reformaflow/domain';
import { api } from '@/lib/api';
import { maskCurrencyInput, currencyInputToNumber } from '@/lib/currency-input';
import { getExpenseOptions } from '@/app/projects/[projectId]/expenses/_types';
import type { OnboardingStepProps } from '../../_types';

interface TenantCard { id: string; nickname?: string | null; brand: string; last4: string }
interface TenantAccount { id: string; nickname?: string | null; institution: string; last4?: string | null }

/**
 * Purpose-built quick-add expense step — own local state, own POST call.
 * Used by PESSOAL and REFORMA/COMPRA via `getExpenseOptions(projectType)`
 * for the tipo dropdown (already project-type-aware, never a hardcoded list).
 * Vínculo com conta/cartão só aparece para tipos com essas features (hoje só
 * PESSOAL) — replica o mesmo par de selects de `VinculosFields`, mas sem o
 * cross-project linking (fora de escopo pro "criar rápido" do wizard).
 */
export function QuickExpenseStep({ projectId, projectType, onDone, onSkip }: OnboardingStepProps) {
  const options = getExpenseOptions(projectType);
  const showVinculos = hasFeature(projectType, 'bankAccounts') || hasFeature(projectType, 'creditCards');
  const [tipoDespesa, setTipoDespesa] = useState<string>(options[0]?.value ?? '');
  const [valor, setValor] = useState('');
  const [titulo, setTitulo] = useState('');
  const [dataPagamento, setDataPagamento] = useState(() => new Date().toISOString().slice(0, 10));
  const [creditCardId, setCreditCardId] = useState('');
  const [bankAccountId, setBankAccountId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: cards = [] } = useQuery<TenantCard[]>({
    queryKey: ['tenant', 'credit-cards'],
    queryFn: () => api.get('/tenant/credit-cards'),
    staleTime: 60_000,
    enabled: showVinculos,
  });
  const { data: accounts = [] } = useQuery<TenantAccount[]>({
    queryKey: ['tenant', 'bank-accounts'],
    queryFn: () => api.get('/tenant/bank-accounts'),
    staleTime: 60_000,
    enabled: showVinculos,
  });

  const canSubmit = valor.trim().length > 0;

  async function handleSave() {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      await api.post(`/projects/${projectId}/expenses`, {
        tipoDespesa,
        valor: currencyInputToNumber(valor),
        quantidade: 1,
        formaPagamento: 'A_VISTA',
        status: 'PAGO',
        dataPagamento,
        titulo,
        creditCardId: creditCardId || null,
        bankAccountId: bankAccountId || null,
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao salvar despesa');
    } finally {
      setSaving(false);
    }
  }


  return (
    <section className="rounded-[18px] border border-lifeone-hairline bg-lifeone-card p-6 shadow-lifeone-card">
      <h2 className="text-[18px] font-bold text-lifeone-ink">Sua primeira despesa</h2>
      <p className="text-[13px] text-lifeone-ink-3">Registre um gasto recente para começar a acompanhar o caixa</p>

      <div className="mt-4 space-y-3">
        <div>
          <label htmlFor="qe-tipo" className="mb-1 block text-[12px] font-medium text-lifeone-ink-2">Tipo</label>
          <select
            id="qe-tipo"
            value={tipoDespesa}
            onChange={(e) => setTipoDespesa(e.target.value)}
            className="min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3 py-2.5 text-[14px]"
          >
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="qe-titulo" className="mb-1 block text-[12px] font-medium text-lifeone-ink-2">Descrição (opcional)</label>
          <input
            id="qe-titulo"
            value={titulo}
            onChange={(e) => setTitulo(e.target.value)}
            placeholder="Ex: Mercado do mês"
            className="min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3.5 py-2.5 text-[14px] placeholder:text-lifeone-ink-4 focus:border-lifeone-blue focus:outline-none focus:ring-2 focus:ring-lifeone-blue/25"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="qe-valor" className="mb-1 block text-[12px] font-medium text-lifeone-ink-2">Valor (R$)</label>
            <input
              id="qe-valor"
              value={valor}
              onChange={(e) => setValor(maskCurrencyInput(e.target.value))}
              placeholder="150,00"
              inputMode="numeric"
              className="min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3.5 py-2.5 text-[14px] font-mono placeholder:text-lifeone-ink-4 focus:border-lifeone-blue focus:outline-none focus:ring-2 focus:ring-lifeone-blue/25"
            />
          </div>
          <div>
            <label htmlFor="qe-data" className="mb-1 block text-[12px] font-medium text-lifeone-ink-2">Data</label>
            <input
              id="qe-data"
              type="date"
              value={dataPagamento}
              onChange={(e) => setDataPagamento(e.target.value)}
              className="min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3.5 py-2.5 text-[14px]"
            />
          </div>
        </div>

        {showVinculos && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="qe-conta" className="mb-1 block text-[12px] font-medium text-lifeone-ink-2">Conta bancária</label>
              <select
                id="qe-conta"
                value={bankAccountId}
                onChange={(e) => setBankAccountId(e.target.value)}
                className="min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3 py-2.5 text-[14px]"
              >
                <option value="">Nenhuma</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.nickname || a.institution}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="qe-cartao" className="mb-1 block text-[12px] font-medium text-lifeone-ink-2">Cartão</label>
              <select
                id="qe-cartao"
                value={creditCardId}
                onChange={(e) => setCreditCardId(e.target.value)}
                className="min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3 py-2.5 text-[14px]"
              >
                <option value="">Nenhum</option>
                {cards.map((c) => (
                  <option key={c.id} value={c.id}>{c.nickname || `${c.brand} ••${c.last4}`}</option>
                ))}
              </select>
            </div>
          </div>
        )}
      </div>

      {error && <p className="mt-3 text-[13px] text-[#B42318]">{error}</p>}

      <div className="mt-5 flex flex-col gap-2">
        <button
          onClick={handleSave}
          disabled={!canSubmit || saving}
          className="flex min-h-11 w-full items-center justify-center gap-2 rounded-[10px] bg-lifeone-blue px-4 py-3 text-[14px] font-semibold text-white hover:brightness-95 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? 'Salvando…' : 'Criar e continuar'}
          {!saving && <ArrowRight className="h-4 w-4" />}
        </button>
        <button
          onClick={onSkip}
          className="flex min-h-11 w-full items-center justify-center gap-1.5 text-[13px] text-lifeone-ink-3 hover:text-lifeone-ink"
        >
          <SkipForward className="h-3.5 w-3.5" /> Pular por agora
        </button>
      </div>
    </section>
  );
}
