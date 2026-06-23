'use client';

import { formatCurrency, formatDateBR } from '@/lib/utils';
import { entryMeta, movementMeta } from '../_lib';
import type { AccountViewEntrada, AccountViewSaida } from '../_types';

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-5 text-sm text-slate-500 xl:p-6">
      {text}
    </div>
  );
}

export function SaidasSection({ items }: { items: AccountViewSaida[] }) {
  const total = items.reduce((sum, item) => sum + item.valor, 0);

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm xl:p-5">
      <div className="mb-4 flex items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Saídas do mês
          </p>
          <h2 className="mt-1 text-lg font-bold text-slate-950">O que já saiu e ainda sai da conta</h2>
          <p className="mt-1 hidden text-sm text-slate-600 xl:block">
            Fatura aparece em uma linha só; débitos diretos ficam logo abaixo.
          </p>
        </div>
        <p className="text-base font-bold text-slate-950 xl:text-xl">{formatCurrency(total / 100)}</p>
      </div>

      {items.length === 0 ? (
        <EmptyState text="Nenhuma saída para este mês." />
      ) : (
        <div className="space-y-2">
          {items.map((item) => {
            const meta = movementMeta(item.forma);
            const Icon = meta.icon;
            return (
              <div
                key={`${item.descricao}-${item.data}-${item.valor}`}
                className="flex min-h-11 items-center gap-3 rounded-2xl border border-slate-100 px-3 py-3 xl:grid xl:grid-cols-[2rem_minmax(0,1fr)_auto] xl:items-center xl:gap-4 xl:px-4"
              >
                <span
                  className={`flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-xl ${meta.iconClass}`}
                >
                  <Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-900">{item.descricao}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                    <span>{formatDateBR(item.data)}</span>
                    <span className={`rounded-full px-2 py-0.5 font-semibold ${meta.badgeClass}`}>
                      {meta.label}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 font-semibold ${
                        item.realizado
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-amber-100 text-amber-800'
                      }`}
                    >
                      {item.realizado ? 'pago' : 'a pagar'}
                    </span>
                  </div>
                </div>
                <p className="shrink-0 text-right text-base font-bold text-slate-950 xl:text-lg">
                  {formatCurrency(item.valor / 100)}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function EntradasSection({ items }: { items: AccountViewEntrada[] }) {
  const total = items.reduce((sum, item) => sum + item.valor, 0);

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm xl:p-5">
      <div className="mb-4 flex items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Entradas do mês
          </p>
          <h2 className="mt-1 text-lg font-bold text-slate-950">O que já entrou na conta</h2>
          <p className="mt-1 hidden text-sm text-slate-600 xl:block">
            Salário, reembolso e outros créditos realizados no mês selecionado.
          </p>
        </div>
        <p className="text-base font-bold text-emerald-700 xl:text-xl">{formatCurrency(total / 100)}</p>
      </div>

      {items.length === 0 ? (
        <EmptyState text="Nenhuma entrada realizada neste mês." />
      ) : (
        <div className="space-y-2">
          {items.map((item) => {
            const meta = entryMeta(item.tipo);
            const Icon = meta.icon;
            return (
              <div
                key={`${item.descricao}-${item.data}-${item.valor}`}
                className="flex min-h-11 items-center gap-3 rounded-2xl border border-slate-100 px-3 py-3 xl:grid xl:grid-cols-[2rem_minmax(0,1fr)_auto] xl:items-center xl:gap-4 xl:px-4"
              >
                <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
                  <Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-900">{item.descricao}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                    <span>{formatDateBR(item.data)}</span>
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-700">
                      {meta.label}
                    </span>
                  </div>
                </div>
                <p className="shrink-0 text-right text-base font-bold text-emerald-700 xl:text-lg">
                  {formatCurrency(item.valor / 100)}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
