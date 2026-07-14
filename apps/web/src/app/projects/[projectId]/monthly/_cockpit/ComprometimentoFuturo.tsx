'use client';

import { useEffect, useMemo, useState } from 'react';
import { Card } from './ui';
import { fmtMoney, mesCurto } from './format';
import type { ComprometimentoMes } from './derive';

function labelMes(key: string): string {
  const [y, m] = key.split('-').map((n) => Number.parseInt(n, 10));
  return `${mesCurto((m || 1) - 1)}/${String(y || 0).slice(-2)}`;
}

/**
 * Rótulo curto do eixo: "Jul/26" não cabe sob 12 barras (~32px cada) e os
 * textos colidiam. Só o mês; o ano aparece na 1ª barra e em cada janeiro
 * (vira o marcador de virada de ano). Tooltip/`title` mantém o rótulo cheio.
 */
function labelEixo(key: string, index: number): string {
  const [y, m] = key.split('-').map((n) => Number.parseInt(n, 10));
  const mes = mesCurto((m || 1) - 1);
  return index === 0 || m === 1 ? `${mes}/${String(y || 0).slice(-2)}` : mes;
}

export default function ComprometimentoFuturo({
  rows,
  selectedCardLast4,
  onSelectCard,
}: {
  rows: ComprometimentoMes[];
  selectedCardLast4?: string | null;
  onSelectCard?: (cardLast4: string | null) => void;
}) {
  const cards = useMemo(
    () => Array.from(new Set(rows.flatMap((row) => row.itens.map((item) => item.cardLast4)))).sort(),
    [rows],
  );
  const [internalSelectedCard, setInternalSelectedCard] = useState<string | null>(cards[0] ?? null);
  const selectedCard = selectedCardLast4 !== undefined ? selectedCardLast4 : internalSelectedCard;
  const setSelectedCard = (card: string | null) => {
    if (selectedCardLast4 === undefined) {
      setInternalSelectedCard(card);
    }
    onSelectCard?.(card);
  };
  const filteredRows = useMemo(() => {
    if (!selectedCard) return rows;
    return rows
      .map((row) => {
        const itens = row.itens.filter((item) => item.cardLast4 === selectedCard);
        const total = itens.reduce((sum, item) => sum + item.valor, 0);
        return { ...row, itens, total };
      })
      .filter((row) => row.itens.length > 0);
  }, [rows, selectedCard]);
  const [selectedMes, setSelectedMes] = useState<string | null>(filteredRows[0]?.mes ?? null);

  useEffect(() => {
    if (cards.length > 0 && selectedCard && !cards.includes(selectedCard)) {
      setSelectedCard(cards[0]);
    }
    if (!selectedCard && cards.length > 0) {
      setSelectedCard(cards[0]);
    }
  }, [cards, selectedCard]);

  useEffect(() => {
    if (filteredRows.length === 0) {
      setSelectedMes(null);
      return;
    }
    if (!selectedMes || !filteredRows.some((row) => row.mes === selectedMes)) {
      setSelectedMes(filteredRows[0].mes);
    }
  }, [filteredRows, selectedMes]);

  const max = useMemo(() => filteredRows.reduce((mx, r) => Math.max(mx, r.total), 0), [filteredRows]);
  const selected = filteredRows.find((r) => r.mes === selectedMes) ?? filteredRows[0];

  if (rows.length === 0) return null;

  return (
    <Card
      title="Comprometimento futuro (cartão)"
      hint="parcelas/lançamentos planejados por mês de saída (eixo atual)"
    >
      {cards.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {cards.map((card) => (
            <button
              key={card}
              type="button"
              onClick={() => setSelectedCard(card)}
              className={`min-h-[44px] rounded-full border px-3 text-xs font-semibold transition-colors ${
                selectedCard === card
                  ? 'border-[var(--ck-accent)] bg-[var(--ck-accent)] text-white'
                  : 'border-[var(--ck-border)] bg-[var(--ck-surface-2)] text-[var(--ck-muted)] hover:text-[var(--ck-text)]'
              }`}
            >
              ••{card}
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-6 md:grid-cols-12 gap-2 items-end">
        {filteredRows.map((r, index) => {
          const pct = max > 0 ? r.total / max : 0;
          const active = selected?.mes === r.mes;
          return (
            <button
              key={r.mes}
              type="button"
              onClick={() => setSelectedMes(r.mes)}
              className="group flex flex-col items-center gap-1"
              title={`${labelMes(r.mes)} · ${fmtMoney(r.total)}`}
            >
              <div className="w-full h-24 md:h-28 rounded-md border border-[var(--ck-border)] bg-[var(--ck-surface-2)] relative overflow-hidden">
                <div
                  className={`absolute bottom-0 inset-x-0 transition-all ${
                    active ? 'bg-amber-500' : 'bg-amber-400/90 group-hover:bg-amber-500/95'
                  }`}
                  style={{ height: `${Math.max(4, Math.round(pct * 100))}%` }}
                />
              </div>
              <span className={`whitespace-nowrap text-[10px] ${active ? 'text-[var(--ck-text)] font-semibold' : 'text-[var(--ck-muted)]'}`}>
                {labelEixo(r.mes, index)}
              </span>
            </button>
          );
        })}
      </div>

      {selected && (
        <div className="mt-3 rounded-xl border border-[var(--ck-border)] bg-[var(--ck-surface-2)] p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-[var(--ck-muted)]">
              {labelMes(selected.mes)} · {selected.itens.length} itens{selectedCard ? ` · ••${selectedCard}` : ''}
            </p>
            <p className="text-sm font-semibold text-amber-400">{fmtMoney(selected.total)}</p>
          </div>
          <div className="mt-2 space-y-1.5 max-h-36 overflow-auto pr-1">
            {selected.itens.slice(0, 12).map((it, i) => (
              <div key={`${it.cardLast4}-${i}`} className="text-xs text-[var(--ck-text)] flex items-center justify-between gap-2">
                <span className="truncate">
                  {it.descricao}
                  {it.parcela ? ` · ${it.parcela}` : ''}
                  {` · ••${it.cardLast4}`}
                </span>
                <span className="font-geist tabular-nums text-[var(--ck-muted)]">{fmtMoney(it.valor)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
