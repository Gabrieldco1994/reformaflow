'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import type { DreMensal } from '../_types';
import { DreIcon } from './DreIcon';

export type DreEixoMensal = 'competencia' | 'contaCorrente';

function totalGrupo(items: Array<{ valor: number }>) {
  return items.reduce((sum, item) => sum + item.valor, 0);
}

function deltaText(delta: number) {
  const rounded = Math.round(delta * 10) / 10;
  if (rounded === 0) return 'estável vs mês anterior';
  return `${rounded > 0 ? '↑' : '↓'} ${Math.abs(rounded).toLocaleString('pt-BR', {
    maximumFractionDigits: 1,
  })}% vs mês anterior`;
}

export function DreMensalView({
  data,
  eixo,
  onChangeEixo,
}: {
  data: DreMensal;
  eixo: DreEixoMensal;
  onChangeEixo: (next: DreEixoMensal) => void;
}) {
  const groups = eixo === 'competencia' ? data.saidas : data.saidasCaixa;
  const totalSaidas = groups.reduce((sum, group) => sum + totalGrupo(group.items), 0);
  const totalGuardado = data.guardado.reduce((sum, item) => sum + item.valor, 0);
  const resultadoTone =
    data.resultado >= 0
      ? 'bg-[#E1F5EE] text-[#1D9E75] border-[#BFE9DA]'
      : 'bg-[#FCEBEB] text-[#D85A30] border-[#F3D0D0]';

  const receitaBarPct = 100;
  const despesaBarPct =
    data.receitaTotal > 0
      ? Math.min(100, (data.despesaTotal / data.receitaTotal) * 100)
      : 0;
  const margemAbs = data.receitaTotal - data.despesaTotal;
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div className="space-y-4">
      <section className="space-y-3">
        <article className={`rounded-2xl border p-4 ${resultadoTone}`}>
          <p className="text-[11px] uppercase tracking-[0.16em] font-semibold">
            resultado de {data.mes}
          </p>
          <p className="mt-2 text-[22px] font-bold leading-none">
            {formatCurrency(data.resultado / 100)}
          </p>
          <p className="mt-2 text-xs opacity-90">{deltaText(data.deltaVsMesAnterior)}</p>
        </article>

        <div className="grid grid-cols-2 gap-3">
          <article className="rounded-2xl border border-[#BFE9DA] bg-[#E1F5EE] p-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#1D9E75]">
              entrou
            </p>
            <p className="mt-2 text-base font-bold text-[#1D9E75]">
              {formatCurrency(data.totalEntrou / 100)}
            </p>
          </article>
          <article className="rounded-2xl border border-[#F3D0D0] bg-[#FCEBEB] p-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#D85A30]">
              saiu + guardou
            </p>
            <p className="mt-2 text-base font-bold text-[#D85A30]">
              {formatCurrency(data.totalSaiuMaisGuardou / 100)}
            </p>
          </article>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          receita × despesa
        </p>
        <div className="mt-3 space-y-3">
          <div>
            <div className="mb-1 flex items-center justify-between text-xs text-[#1D9E75]">
              <span>receita</span>
              <span className="font-semibold">{formatCurrency(data.receitaTotal / 100)}</span>
            </div>
            <div className="h-2 rounded-full bg-[#E1F5EE]">
              <div className="h-2 rounded-full bg-[#1D9E75]" style={{ width: `${receitaBarPct}%` }} />
            </div>
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between text-xs text-[#D85A30]">
              <span>despesa</span>
              <span className="font-semibold">{formatCurrency(data.despesaTotal / 100)}</span>
            </div>
            <div className="h-2 rounded-full bg-[#FCEBEB]">
              <div className="h-2 rounded-full bg-[#D85A30]" style={{ width: `${despesaBarPct}%` }} />
            </div>
          </div>
        </div>
        <p className="mt-3 text-xs text-slate-600">
          despesa = {data.margemPct.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% da receita · margem{' '}
          {formatCurrency(margemAbs / 100)}
        </p>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
          <button
            type="button"
            onClick={() => onChangeEixo('competencia')}
            className={`h-11 rounded-lg px-4 text-sm font-semibold transition ${
              eixo === 'competencia' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
            }`}
          >
            Competência
          </button>
          <button
            type="button"
            onClick={() => onChangeEixo('contaCorrente')}
            className={`h-11 rounded-lg px-4 text-sm font-semibold transition ${
              eixo === 'contaCorrente' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
            }`}
          >
            Conta Corrente
          </button>
        </div>

        <div className="mt-4 space-y-4">
          <section>
            <h3 className="text-sm font-semibold text-slate-900">O que entrou</h3>
            <div className="mt-2 space-y-2">
              {data.entradas.map((line) => (
                <div key={`in-${line.label}`} className="flex min-h-11 items-center justify-between rounded-xl border border-[#BFE9DA] bg-[#E1F5EE] px-3 py-2">
                  <div className="flex items-center gap-2 text-sm text-slate-700">
                    <DreIcon name="wallet" className="h-4 w-4 text-[#1D9E75]" />
                    <span>{line.label}</span>
                  </div>
                  <span className="text-sm font-semibold text-[#1D9E75]">{formatCurrency(line.valor / 100)}</span>
                </div>
              ))}
            </div>
            <div className="mt-2 rounded-xl border border-[#BFE9DA] bg-[#E1F5EE] px-3 py-2 text-sm font-semibold text-[#1D9E75]">
              total entradas · {formatCurrency(data.totalEntrou / 100)}
            </div>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-slate-900">
              {eixo === 'competencia' ? 'O que você comprou' : 'O que saiu da conta'}
            </h3>
            <div className="mt-2 space-y-2">
              {groups.map((group) => (
                <article key={`${group.group}-${group.icon}`} className="rounded-xl border border-[#F3D0D0] bg-[#FCEBEB] p-3">
                  <button
                    type="button"
                    onClick={() => toggleGroup(`${eixo}-${group.group}`)}
                    className="flex min-h-11 w-full items-center justify-between gap-2"
                    aria-expanded={!!expandedGroups[`${eixo}-${group.group}`]}
                  >
                    <div className="flex items-center gap-2">
                      <DreIcon name={group.icon} className="h-4 w-4 text-[#D85A30]" />
                      <p className="text-left text-sm font-semibold text-slate-800">{group.group}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-[#D85A30]">
                        {formatCurrency(totalGrupo(group.items) / 100)}
                      </p>
                      <ChevronDown
                        className={`h-4 w-4 text-[#D85A30] transition-transform ${
                          expandedGroups[`${eixo}-${group.group}`] ? 'rotate-180' : ''
                        }`}
                      />
                    </div>
                  </button>
                  {expandedGroups[`${eixo}-${group.group}`] && (
                    <div className="mt-2 space-y-1.5">
                      {group.items.map((item) => (
                        <div key={`${group.group}-${item.label}`} className="flex min-h-11 items-center justify-between pl-[18px] text-xs text-slate-700">
                          <span>{item.label}</span>
                          <span className="font-semibold text-[#D85A30]">{formatCurrency(item.valor / 100)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </article>
              ))}
            </div>
            <div className="mt-2 rounded-xl border border-[#F3D0D0] bg-[#FCEBEB] px-3 py-2 text-sm font-semibold text-[#D85A30]">
              total saídas · {formatCurrency(totalSaidas / 100)}
            </div>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-slate-900">O que você guardou</h3>
            <div className="mt-2 space-y-2">
              {data.guardado.map((line) => (
                <div key={`save-${line.label}`} className="flex min-h-11 items-center justify-between rounded-xl border border-[#EFD9B6] bg-[#FAEEDA] px-3 py-2">
                  <div className="flex items-center gap-2 text-sm text-slate-700">
                    <DreIcon name="piggy-bank" className="h-4 w-4 text-[#BA7517]" />
                    <span>{line.label}</span>
                  </div>
                  <span className="text-sm font-semibold text-[#BA7517]">{formatCurrency(line.valor / 100)}</span>
                </div>
              ))}
            </div>
            <div className="mt-2 rounded-xl border border-[#EFD9B6] bg-[#FAEEDA] px-3 py-2 text-sm font-semibold text-[#BA7517]">
              total guardado · {formatCurrency(totalGuardado / 100)}
            </div>
          </section>

          <section className={`rounded-xl border px-3 py-3 ${resultadoTone}`}>
            <p className="text-xs font-semibold uppercase tracking-[0.12em]">resultado do mês</p>
            <p className="mt-1 text-lg font-bold">{formatCurrency(data.resultado / 100)}</p>
            <p className="mt-1 text-xs opacity-90">
              entradas − saídas − guardado = sobra livre
            </p>
          </section>
        </div>
      </section>
    </div>
  );
}
