'use client';

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, CreditCard, Sparkles, Wallet, X } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import { moneyGlance } from '@/lib/money';
import { tipoLabel } from '@/lib/expense-options';
import { getExpenseIcon } from '@/lib/expense-icons';
import { useCategorySuggestion } from '../../expenses/_hooks/useCategorySuggestion';
import { getExpenseOptions } from '../../expenses/_types';
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
  projectType: string;
  projectedBalanceCents?: number | null;
  mode?: 'PAGA' | 'PLANEJAR';
}

// ponytail: atalho de categorias PESSOAL do dia a dia no lançamento rápido;
// ajustar aqui se o mix mudar. O resto das categorias fica atrás de "ver todas".
const COMMON_TIPOS = [
  'SUPERMERCADO', 'ALIMENTACAO', 'TRANSPORTE', 'SAUDE',
  'LAZER', 'CONTAS_UTILIDADES', 'ASSINATURAS', 'MORADIA',
  'BELEZA', 'PETS', 'EDUCACAO', 'ACADEMIA',
];

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
  projectType,
  projectedBalanceCents,
  mode = 'PAGA',
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
  const [tipoOverride, setTipoOverride] = useState<string | null>(null);
  const [showAllTipos, setShowAllTipos] = useState(false);

  const typeOptions = useMemo(() => getExpenseOptions(projectType), [projectType]);
  const commonOptions = useMemo(
    () =>
      COMMON_TIPOS.map((v) => typeOptions.find((o) => o.value === v)).filter(
        (o): o is (typeof typeOptions)[number] => Boolean(o),
      ),
    [typeOptions],
  );

  const cents = Number.parseInt(digits || '0', 10);
  const selectedOrigin = origins.find((origin) => origin.key === originKey) ?? null;
  const { suggestion } = useCategorySuggestion(description, description);

  // Tipo efetivo que SERÁ lançado — sempre visível ao usuário. Sem sugestão da
  // Maria e sem escolha → "OUTROS", mas o título é preenchido pela categoria por trás.
  const effectiveTipo = tipoOverride ?? suggestion?.suggestedTipoDespesa ?? 'OUTROS';
  const isSuggested = !tipoOverride && !!suggestion?.suggestedTipoDespesa;
  const selectedTipo = tipoOverride ?? suggestion?.suggestedTipoDespesa ?? null;
  const tituloPreview = description.trim() || (selectedTipo ? tipoLabel(effectiveTipo) : '');

  useEffect(() => {
    if (!open) return;
    setDigits('');
    setDescription('');
    setParcelas(1);
    setTipoOverride(null);
    setShowAllTipos(false);
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
      tipoDespesa: effectiveTipo,
      valor: cents / 100,
      quantidade: 1,
      titulo: description.trim() || (selectedTipo ? tipoLabel(effectiveTipo) : 'Despesa'),
      fornecedor: description.trim() || null,
      formaPagamento: selectedOrigin.kind === 'card' && parcelas > 1 ? 'PARCELADO' : 'A_VISTA',
      quantidadeParcela: selectedOrigin.kind === 'card' && parcelas > 1 ? parcelas : null,
      dataInicioParcela: selectedOrigin.kind === 'card' && parcelas > 1 ? today : null,
      dataPagamento: today,
      status: mode === 'PLANEJAR' ? 'PLANEJADO' : 'PAGO',
      creditCardId: selectedOrigin.kind === 'card' ? selectedOrigin.id : null,
      bankAccountId: selectedOrigin.kind === 'account' ? selectedOrigin.id : null,
    };

    await onLaunch(payload);
    onClose();
  };

  return (
    <>
      <div className="pessoal-minimal-backdrop fixed inset-0 z-40 bg-darc-velvet/60 backdrop-blur-sm lg:hidden" onClick={onClose} aria-hidden />
      <section data-mobile-sheet="launch" className="pessoal-minimal-launch-sheet fixed inset-x-0 bottom-0 z-50 max-h-[96dvh] overflow-y-auto rounded-t-[28px] border border-darc-linen bg-lifeone-surface px-4 pb-6 pt-3 lg:hidden">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-xl font-bold text-lifeone-ink">{mode === 'PLANEJAR' ? 'Planejar' : 'Lançar'}</h2>
          <button type="button" onClick={onClose} aria-label="Fechar lançar" className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-darc-velvet/70 hover:bg-darc-linen/60">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="pessoal-minimal-balance rounded-2xl bg-darc-velvet px-4 py-3 text-sm text-white/85">
          <p>
            {mode === 'PLANEJAR' ? 'Impacto previsto:' : 'Fechamento previsto:'}{' '}
            <strong className="text-white">{moneyGlance(projected)}</strong>
          </p>
        </div>

        <div className="pt-4 text-center">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-darc-velvet/55">Quanto?</p>
          <p className="pt-1 font-geist text-5xl font-bold tracking-tight text-lifeone-ink">{formatCurrency(cents / 100)}</p>
        </div>

        <p className="pt-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-darc-velvet/55">De onde sai</p>
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
          {origins.map((origin) => {
            const active = origin.key === originKey;
            const isCard = origin.kind === 'card';
            const OriginIcon = isCard ? CreditCard : Wallet;
            return (
              <button
                key={origin.key}
                type="button"
                aria-label={`Origem ${origin.label}`}
                aria-pressed={active}
                onClick={() => {
                  setOriginKey(origin.key);
                  if (!isCard) setParcelas(1);
                }}
                className={`flex min-h-[56px] shrink-0 items-center gap-2.5 rounded-2xl border px-3 py-2 text-left transition ${
                  active
                    ? 'border-darc-velvet bg-darc-velvet text-white'
                    : 'border-darc-linen bg-white text-darc-velvet'
                }`}
              >
                <span
                  aria-hidden
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${
                    active
                      ? 'bg-white/15 text-white'
                      : isCard
                        ? 'bg-[#FEF0DC] text-[#D97706]'
                        : 'bg-[#E4F3EC] text-[#0F6B4D]'
                  }`}
                >
                  <OriginIcon className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block whitespace-nowrap text-sm font-semibold">{origin.label}</span>
                  <span className={`block text-xs ${active ? 'text-white/70' : 'text-darc-velvet/55'}`}>{origin.hint}</span>
                </span>
              </button>
            );
          })}
        </div>

        {selectedOrigin?.kind === 'card' && (
          <div className="minimal-soft-card mt-4 rounded-2xl border border-darc-linen bg-white p-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-darc-velvet/55">Parcelas</p>
            <div className="relative mt-2">
              <select
                value={parcelas}
                onChange={(event) => setParcelas(Number(event.target.value))}
                aria-label="Parcelas"
                className="h-12 w-full appearance-none rounded-xl border border-darc-linen bg-white pl-3 pr-9 text-sm font-semibold text-darc-velvet"
              >
                {Array.from({ length: 18 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n === 1 ? 'À vista' : `${n}x`}
                  </option>
                ))}
              </select>
              <ChevronDown
                aria-hidden
                className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-darc-velvet/50"
              />
            </div>
            <p className="mt-2 text-xs text-darc-velvet/70">
              {invoiceHint
                ? `Cai na fatura: fecha ${invoiceHint.fecha} · vence ${invoiceHint.vence}`
                : 'Configure o dia de fechamento do cartão para ver a fatura de destino.'}
            </p>
          </div>
        )}

        <div className="flex items-center justify-between pt-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-darc-velvet/55">O que foi</p>
          {isSuggested && (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#0C5A40]">
              <Sparkles className="h-3 w-3" /> Maria sugeriu
            </span>
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {(showAllTipos ? typeOptions : commonOptions).map((option) => {
            const { Icon, color, bgColor } = getExpenseIcon(option.value);
            const active = selectedTipo === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-label={`Categoria ${option.label}`}
                aria-pressed={active}
                onClick={() => setTipoOverride(active ? null : option.value)}
                className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-semibold transition ${
                  active
                    ? 'border-darc-velvet bg-darc-velvet text-white'
                    : 'border-darc-linen bg-white text-darc-velvet'
                }`}
              >
                <span
                  aria-hidden
                  className={`flex h-5 w-5 items-center justify-center rounded-md ${active ? '' : `${bgColor} ${color}`}`}
                >
                  <Icon className="h-3.5 w-3.5" />
                </span>
                {option.label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setShowAllTipos((value) => !value)}
            aria-expanded={showAllTipos}
            className="inline-flex min-h-[44px] items-center rounded-full border border-dashed border-darc-linen px-3 text-[13px] font-semibold text-darc-velvet/60"
          >
            {showAllTipos ? 'ver menos' : 'ver todas'}
          </button>
        </div>

        <input
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={mode === 'PLANEJAR' ? 'Detalhe (opcional): ex. internet de agosto' : 'Detalhe (opcional): ex. mercado da esquina'}
          className="pessoal-minimal-input mt-3 h-12 w-full rounded-xl border border-darc-linen bg-white px-3 text-sm"
        />
        {recentDescriptions.length > 0 && (
          <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
            {recentDescriptions.slice(0, 6).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setDescription(item)}
                className="inline-flex min-h-[42px] shrink-0 items-center rounded-full border border-darc-linen bg-white px-4 text-xs font-semibold text-darc-velvet/75"
              >
                <span className="block max-w-[150px] truncate">{item}</span>
              </button>
            ))}
          </div>
        )}
        {tituloPreview && (
          <p className="mt-2 text-xs text-darc-velvet/60">
            Lança como <strong className="font-semibold text-darc-velvet/80">{tituloPreview}</strong>
          </p>
        )}

        <div className="mt-4 grid grid-cols-3 gap-2">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setDigits((current) => normalizeDigits(current + key))}
              className="pessoal-minimal-key min-h-[54px] rounded-xl bg-white text-xl font-semibold text-lifeone-ink shadow-lifeone-card"
            >
              {key}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setDigits('')}
            className="pessoal-minimal-key min-h-[54px] rounded-xl bg-lifeone-surface text-sm font-semibold text-darc-velvet/70"
          >
            limpar
          </button>
          <button
            type="button"
            onClick={() => setDigits((current) => normalizeDigits(current + '0'))}
            className="pessoal-minimal-key min-h-[54px] rounded-xl bg-white text-xl font-semibold text-lifeone-ink shadow-lifeone-card"
          >
            0
          </button>
          <button
            type="button"
            onClick={() => setDigits((current) => current.slice(0, -1))}
            className="pessoal-minimal-key min-h-[54px] rounded-xl bg-lifeone-surface text-sm font-semibold text-darc-velvet/70"
          >
            ⌫
          </button>
        </div>

        <button
          type="button"
          disabled={launchDisabled}
          onClick={handleLaunch}
          className="pessoal-minimal-launch-submit mt-4 flex min-h-[52px] w-full items-center justify-center rounded-2xl bg-[#0F6B4D] text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-darc-linen"
        >
          {launching ? (mode === 'PLANEJAR' ? 'Planejando...' : 'Lançando...') : mode === 'PLANEJAR' ? 'Planejar despesa' : 'Lançar despesa'}
        </button>
      </section>
    </>
  );
}
