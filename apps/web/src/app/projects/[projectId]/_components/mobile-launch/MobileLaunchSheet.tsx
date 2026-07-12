'use client';

import { useEffect, useMemo, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import { useCategorySuggestion } from '../../expenses/_hooks/useCategorySuggestion';
import { faturaDestino } from '../../_lib/fatura-destino';
import type { LaunchAccountOption, LaunchCardOption, LaunchPayload } from './types';

type OriginOption =
  | { key: string; kind: 'account'; id: string; label: string; hint: string }
  | {
      key: string;
      kind: 'card';
      id: string;
      label: string;
      hint: string;
      closingDay: number | null;
      dueDay: number | null;
    };

interface Props {
  open: boolean;
  onClose: () => void;
  onLaunch: (payload: LaunchPayload) => Promise<void>;
  launching: boolean;
  accounts: LaunchAccountOption[];
  cards: LaunchCardOption[];
  recentDescriptions: string[];
  projectedBalanceCents?: number | null;
}

const PARCELAS = [1, 3, 6, 12] as const;

function normalizeDigits(value: string): string {
  return value.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
}

export function MobileLaunchSheet({
  open,
  onClose,
  onLaunch,
  launching,
  accounts,
  cards,
  recentDescriptions,
  projectedBalanceCents,
}: Props) {
  const origins = useMemo<OriginOption[]>(() => {
    const accountOrigins: OriginOption[] = accounts.map((account) => ({
      key: `account:${account.id}`,
      kind: 'account',
      id: account.id,
      label: account.nickname || account.institution || 'Conta',
      hint: account.last4 ? `conta •${account.last4}` : 'conta',
    }));
    const cardOrigins: OriginOption[] = cards.map((card) => ({
      key: `card:${card.id}`,
      kind: 'card',
      id: card.id,
      label: `${card.nickname || card.brand || 'Cartão'} •${card.last4}`,
      hint: card.closingDay ? `fecha dia ${card.closingDay}` : 'sem fechamento',
      closingDay: card.closingDay ?? null,
      dueDay: card.dueDay ?? null,
    }));
    return [...accountOrigins, ...cardOrigins];
  }, [accounts, cards]);

  const [digits, setDigits] = useState('');
  const [description, setDescription] = useState('');
  const [originKey, setOriginKey] = useState('');
  const [parcelas, setParcelas] = useState(1);

  const cents = Number.parseInt(digits || '0', 10);
  const selectedOrigin = origins.find((origin) => origin.key === originKey) ?? null;
  const { suggestion } = useCategorySuggestion(description, description);

  useEffect(() => {
    if (!open) return;
    setDigits('');
    setDescription('');
    setParcelas(1);
    setOriginKey(origins[0]?.key ?? '');
  }, [open, origins]);

  if (!open) return null;

  const today = new Date().toISOString().slice(0, 10);
  const invoiceHint =
    selectedOrigin?.kind === 'card'
      ? faturaDestino(new Date(today), selectedOrigin.closingDay, selectedOrigin.dueDay)
      : null;

  const launchDisabled = !selectedOrigin || cents <= 0 || launching;
  const projected = (projectedBalanceCents ?? 0) - cents;

  const handleLaunch = async () => {
    if (!selectedOrigin || launchDisabled) return;

    const payload: LaunchPayload = {
      tipoDespesa: suggestion?.suggestedTipoDespesa ?? 'OUTROS',
      valor: cents / 100,
      quantidade: 1,
      titulo: description.trim() || 'Despesa',
      fornecedor: description.trim() || null,
      formaPagamento: selectedOrigin.kind === 'card' && parcelas > 1 ? 'PARCELADO' : 'A_VISTA',
      quantidadeParcela: selectedOrigin.kind === 'card' && parcelas > 1 ? parcelas : null,
      dataInicioParcela: selectedOrigin.kind === 'card' && parcelas > 1 ? today : null,
      dataPagamento: today,
      status: 'PAGO',
      creditCardId: selectedOrigin.kind === 'card' ? selectedOrigin.id : null,
      bankAccountId: selectedOrigin.kind === 'account' ? selectedOrigin.id : null,
    };

    await onLaunch(payload);
    onClose();
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-darc-velvet/60 backdrop-blur-sm lg:hidden" onClick={onClose} aria-hidden />
      <section className="fixed inset-x-0 bottom-0 z-50 max-h-[96dvh] overflow-y-auto rounded-t-[28px] border border-darc-linen bg-lifeone-surface px-4 pb-6 pt-3 lg:hidden">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-xl font-bold text-lifeone-ink">Lançar</h2>
          <button type="button" onClick={onClose} aria-label="Fechar lançar" className="rounded-full p-2 text-darc-velvet/70 hover:bg-darc-linen/60">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="rounded-2xl bg-darc-velvet px-4 py-3 text-sm text-white/85">
          <p>
            Fechamento previsto: <strong className="text-white">{formatCurrency(projected / 100)}</strong>
          </p>
        </div>

        <div className="pt-4 text-center">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-darc-velvet/55">Quanto?</p>
          <p className="pt-1 font-geist text-5xl font-bold tracking-tight text-lifeone-ink">{formatCurrency(cents / 100)}</p>
        </div>

        <p className="pt-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-darc-velvet/55">De onde sai</p>
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
          {origins.map((origin) => (
            <button
              key={origin.key}
              type="button"
              aria-label={`Origem ${origin.label}`}
              onClick={() => {
                setOriginKey(origin.key);
                if (origin.kind !== 'card') setParcelas(1);
              }}
              className={`min-h-[64px] min-w-[132px] rounded-2xl border px-3 py-2 text-left transition ${
                origin.key === originKey
                  ? 'border-darc-velvet bg-darc-velvet text-white'
                  : 'border-darc-linen bg-white text-darc-velvet'
              }`}
            >
              <p className="text-[13px] font-semibold">{origin.label}</p>
              <p className={`text-[11px] ${origin.key === originKey ? 'text-white/70' : 'text-darc-velvet/60'}`}>{origin.hint}</p>
            </button>
          ))}
        </div>

        {selectedOrigin?.kind === 'card' && (
          <div className="mt-4 rounded-2xl border border-darc-linen bg-white p-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-darc-velvet/55">Parcelas</p>
            <div className="mt-2 grid grid-cols-4 gap-2">
              {PARCELAS.map((n) => (
                <button
                  key={n}
                  type="button"
                  aria-label={n === 1 ? 'à vista' : `${n}x`}
                  onClick={() => setParcelas(n)}
                  className={`min-h-[44px] rounded-xl border text-sm font-semibold ${
                    parcelas === n ? 'border-darc-velvet bg-darc-velvet text-white' : 'border-darc-linen text-darc-velvet/70'
                  }`}
                >
                  {n === 1 ? 'à vista' : `${n}x`}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-darc-velvet/70">
              {invoiceHint
                ? `Cai na fatura: fecha ${invoiceHint.fecha} · vence ${invoiceHint.vence}`
                : 'Configure o dia de fechamento do cartão para ver a fatura de destino.'}
            </p>
          </div>
        )}

        <p className="pt-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-darc-velvet/55">O que foi</p>
        <input
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="ex.: mercado, uber, farmácia"
          className="mt-2 h-12 w-full rounded-xl border border-darc-linen bg-white px-3 text-sm"
        />
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
          {recentDescriptions.slice(0, 6).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setDescription(item)}
              className="min-h-[42px] rounded-full border border-darc-linen bg-white px-4 text-xs font-semibold text-darc-velvet/75"
            >
              {item}
            </button>
          ))}
        </div>
        {suggestion?.category && (
          <div className="mt-2 inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800">
            <Sparkles className="h-3.5 w-3.5" /> Maria sugeriu: {suggestion.category}
          </div>
        )}

        <div className="mt-4 grid grid-cols-3 gap-2">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setDigits((current) => normalizeDigits(current + key))}
              className="min-h-[54px] rounded-xl bg-white text-xl font-semibold text-lifeone-ink shadow-lifeone-card"
            >
              {key}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setDigits('')}
            className="min-h-[54px] rounded-xl bg-lifeone-surface text-sm font-semibold text-darc-velvet/70"
          >
            limpar
          </button>
          <button
            type="button"
            onClick={() => setDigits((current) => normalizeDigits(current + '0'))}
            className="min-h-[54px] rounded-xl bg-white text-xl font-semibold text-lifeone-ink shadow-lifeone-card"
          >
            0
          </button>
          <button
            type="button"
            onClick={() => setDigits((current) => current.slice(0, -1))}
            className="min-h-[54px] rounded-xl bg-lifeone-surface text-sm font-semibold text-darc-velvet/70"
          >
            ⌫
          </button>
        </div>

        <button
          type="button"
          disabled={launchDisabled}
          onClick={handleLaunch}
          className="mt-4 flex min-h-[52px] w-full items-center justify-center rounded-2xl bg-emerald-700 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-darc-linen"
        >
          {launching ? 'Lançando...' : 'Lançar despesa'}
        </button>
      </section>
    </>
  );
}
