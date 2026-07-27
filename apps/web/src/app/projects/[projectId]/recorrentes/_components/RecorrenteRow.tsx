'use client';

import { useState } from 'react';
import { Link2, Pencil, Trash2 } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import { getExpenseIcon } from '@/lib/expense-icons';
import type { RecurrenceSerie } from '../_types';

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** "2026-09-15" → "15 set", em UTC (a data é fato do banco, não do fuso do browser). */
function dataCurta(iso: string | null): string | null {
  if (!iso) return null;
  const [, m, d] = iso.slice(0, 10).split('-');
  const mi = parseInt(m ?? '', 10);
  return mi >= 1 && mi <= 12 ? `${d} ${MESES[mi - 1]}` : null;
}

/**
 * Linha de recorrência. Segue o layout canônico de `MovimentacaoRow`:
 * título e metadados separados, valor sempre isolado com `nowrap` à direita e
 * o status textual abaixo dele.
 */
export function RecorrenteRow({
  serie,
  onEdit,
  onDelete,
}: {
  serie: RecurrenceSerie;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const icon = getExpenseIcon(serie.tipoDespesa);
  const Icon = icon.Icon;

  const proxima = dataCurta(serie.proximaData);
  const meta = [
    proxima ? `Próx. ${proxima}` : `Todo dia ${serie.diaVencimento}`,
    serie.tipoDespesaLabel,
    `${serie.ocorrencias}x`,
  ].join(' · ');

  const status =
    serie.ocorrenciasFuturas > 0
      ? { txt: `${serie.ocorrenciasFuturas} a pagar`, cls: 'text-[#B5803A]' }
      : { txt: 'Encerrada', cls: 'text-lifeone-ink-3' };

  const actions = [
    { key: 'edit', label: 'Editar', Icon: Pencil, onClick: onEdit, danger: false },
    { key: 'delete', label: 'Excluir recorrência', Icon: Trash2, onClick: onDelete, danger: true },
  ];

  return (
    <li className="rounded-xl border border-lifeone-hairline bg-lifeone-card transition-colors hover:border-lifeone-blue hover:shadow-lifeone-card md:rounded-2xl">
      <div className="flex items-start gap-2.5 px-2.5 py-2 md:items-center md:gap-3 md:px-4 md:py-3">
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full md:h-10 md:w-10 ${icon.bgColor} ${icon.color}`}
        >
          <Icon className="h-4 w-4 md:h-[18px] md:w-[18px]" />
        </span>

        <div className="min-w-0 flex-1">
          <button type="button" onClick={onEdit} className="w-full text-left" title="Editar recorrência">
            <span className="block line-clamp-2 pr-1 text-[14px] font-semibold leading-tight text-lifeone-ink md:text-[15px]">
              {serie.nome}
            </span>
          </button>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[11px] text-lifeone-ink-3">{meta}</span>
            {serie.temEspelho && (
              <span
                className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-[#E6EFFE] px-1.5 py-0.5 text-[11px] font-semibold text-lifeone-blue"
                title="Espelhada em outro projeto — a edição propaga para lá"
              >
                <Link2 className="h-3 w-3" />
                <span className="hidden sm:inline">Vinculada</span>
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-0">
          <span className="whitespace-nowrap text-[14px] font-semibold tabular-nums font-geist text-lifeone-ink md:text-[15px]">
            − {formatCurrency(serie.valorCents / 100)}
          </span>
          <span className={`inline-flex min-h-6 items-center justify-end text-[11px] font-semibold leading-none md:min-h-[30px] ${status.cls}`}>
            {status.txt}
          </span>
        </div>

        <div className="hidden shrink-0 items-center gap-0.5 md:flex">
          {actions.map((a) => (
            <button
              key={a.key}
              type="button"
              aria-label={a.label}
              title={a.label}
              onClick={a.onClick}
              className={`rounded-lg p-2 transition-colors ${
                a.danger
                  ? 'text-lifeone-ink-4 hover:bg-[#FCEBE9] hover:text-[#D92D20]'
                  : 'text-lifeone-ink-4 hover:bg-[#E6EFFE] hover:text-lifeone-blue'
              }`}
            >
              <a.Icon className="h-4 w-4" />
            </button>
          ))}
        </div>

        <div className="relative shrink-0 md:hidden">
          <button
            type="button"
            aria-label="Ações"
            onClick={() => setMenuOpen((v) => !v)}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-lifeone-ink-4"
          >
            <span className="text-lg leading-none">⋯</span>
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-11 z-20 w-52 overflow-hidden rounded-xl border border-lifeone-hairline bg-white shadow-lg">
                {actions.map((a) => (
                  <button
                    key={a.key}
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      a.onClick();
                    }}
                    className={`flex min-h-11 w-full items-center gap-2 px-3 text-left text-[13px] font-medium ${
                      a.danger ? 'text-[#D92D20]' : 'text-lifeone-ink'
                    }`}
                  >
                    <a.Icon className="h-4 w-4" />
                    {a.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </li>
  );
}
