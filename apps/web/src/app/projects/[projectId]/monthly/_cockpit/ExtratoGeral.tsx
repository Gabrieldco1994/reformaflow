'use client';

import { useMemo, useState } from 'react';
import { CreditCard, Landmark } from 'lucide-react';
import type { MonthlyEntry } from '../_types';
import { Card } from './ui';
import { fmtMoney, fmtMoneyExact, mesCurto } from './format';
import { buildExtratoDespesas, colorForCategoria, type ExtratoItem } from './derive';

const TYPE_BADGE: Record<string, string> = {
  REFORMA: 'bg-orange-500/10 text-orange-700',
  COMPRA: 'bg-purple-500/10 text-purple-700',
  CASA: 'bg-emerald-500/10 text-emerald-700',
  CARRO: 'bg-sky-500/10 text-sky-700',
  PESSOAL: 'bg-[var(--ck-surface-2)] text-[var(--ck-muted)]',
};

type Scope = 'mes' | 'ano';

function diaSemana(iso: string): string {
  const dias = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  const d = new Date(iso);
  return dias[d.getUTCDay()] ?? '';
}

/** Segmented control leve, no tema cockpit. */
function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <span className="inline-flex items-center rounded-lg border border-[var(--ck-border)] bg-[var(--ck-surface-2)] p-0.5">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
            value === v ? 'bg-[var(--ck-accent)] text-white' : 'text-[var(--ck-muted)] hover:text-[var(--ck-text)]'
          }`}
        >
          {label}
        </button>
      ))}
    </span>
  );
}

/**
 * Extrato de saídas — só a lista (os KPIs de saída viraram a faixa "Movimento do
 * mês" no dashboard, sem duplicar). Toggle Mês/Ano e filtros por tipo de despesa
 * e por mês (no escopo Ano). Regras de consumo: exclui espelho cross-project e
 * neutro-de-consumo (pagamento de fatura / movimentação interna / aporte).
 */
export default function ExtratoGeral({
  entries,
  monthKey,
  year,
}: {
  entries: MonthlyEntry[];
  monthKey: string;
  year: number;
}) {
  const [scope, setScope] = useState<Scope>('mes');
  const [tipo, setTipo] = useState<string>('');
  const [mesFiltro, setMesFiltro] = useState<string>('');

  const monthIndex0 = useMemo(() => {
    const mm = monthKey.split('-')[1];
    return mm ? parseInt(mm, 10) - 1 : 0;
  }, [monthKey]);

  // Base do escopo: mês selecionado ou ano inteiro.
  const scoped = useMemo(() => {
    if (scope === 'mes') return entries.filter((e) => (e.data ?? '').slice(0, 7) === monthKey);
    return entries.filter((e) => (e.data ?? '').slice(0, 4) === String(year));
  }, [entries, scope, monthKey, year]);

  // Opções de tipo de despesa = categorias distintas presentes (após regras de consumo).
  const tipoOptions = useMemo(() => {
    const { itens } = buildExtratoDespesas(scoped);
    return Array.from(new Set(itens.map((i) => i.categoria))).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }, [scoped]);

  // Meses disponíveis no ano (para o filtro de mês no escopo Ano).
  const mesesDoAno = useMemo(() => {
    if (scope !== 'ano') return [] as number[];
    const set = new Set<number>();
    for (const e of scoped) {
      const mm = (e.data ?? '').slice(5, 7);
      if (mm) set.add(parseInt(mm, 10) - 1);
    }
    return Array.from(set).sort((a, b) => a - b);
  }, [scoped, scope]);

  const filtered = useMemo(() => {
    let list = scoped;
    if (tipo) list = list.filter((e) => (e.categoria ?? 'Outros') === tipo);
    if (scope === 'ano' && mesFiltro) list = list.filter((e) => (e.data ?? '').slice(0, 7) === mesFiltro);
    return list;
  }, [scoped, tipo, scope, mesFiltro]);

  const { itens, resumo } = useMemo(() => buildExtratoDespesas(filtered), [filtered]);

  // Agrupa por dia (escopo Mês) ou por mês (escopo Ano).
  const grupos = useMemo(() => {
    const byKey = new Map<string, ExtratoItem[]>();
    for (const it of itens) {
      const key = scope === 'mes' ? String(it.dia).padStart(2, '0') : it.data.slice(0, 7);
      const arr = byKey.get(key) ?? [];
      arr.push(it);
      byKey.set(key, arr);
    }
    return Array.from(byKey.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [itens, scope]);

  const selectCls =
    'bg-[var(--ck-surface-2)] border border-[var(--ck-border)] text-[var(--ck-text)] text-[11px] rounded-lg px-2 py-1 outline-none';

  const scopeLabel =
    scope === 'mes'
      ? `${mesCurto(monthIndex0)} ${year}`
      : mesFiltro
        ? `${mesCurto(parseInt(mesFiltro.slice(5, 7), 10) - 1)} ${year}`
        : `${year}`;

  return (
    <Card
      title="Extrato de saídas"
      hint={`${scopeLabel} · ${resumo.qtd} lanç${resumo.qtd === 1 ? '' : 's'} · ${fmtMoney(resumo.totalSaidas)}`}
      info="Todas as saídas do período, em ordem de data. Sem pagamento de fatura / movimentação interna / aporte (não é consumo) e sem espelhos cross-project (não duplica)."
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Segmented<Scope>
          value={scope}
          options={[['mes', 'Mês'], ['ano', 'Ano']]}
          onChange={(v) => {
            setScope(v);
            setMesFiltro('');
          }}
        />
        <select value={tipo} onChange={(e) => setTipo(e.target.value)} className={selectCls} aria-label="Tipo de despesa">
          <option value="">Todos os tipos</option>
          {tipoOptions.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        {scope === 'ano' && (
          <select value={mesFiltro} onChange={(e) => setMesFiltro(e.target.value)} className={selectCls} aria-label="Mês">
            <option value="">Todos os meses</option>
            {mesesDoAno.map((m0) => {
              const key = `${year}-${String(m0 + 1).padStart(2, '0')}`;
              return (
                <option key={key} value={key}>{mesCurto(m0)}</option>
              );
            })}
          </select>
        )}
        {(tipo || mesFiltro) && (
          <button
            type="button"
            onClick={() => {
              setTipo('');
              setMesFiltro('');
            }}
            className="text-[11px] text-[var(--ck-accent)] hover:underline"
          >
            limpar
          </button>
        )}
      </div>

      {itens.length === 0 ? (
        <p className="text-sm text-[var(--ck-muted)] py-8 text-center">
          Nenhuma saída registrada neste período.
        </p>
      ) : (
        <div className="space-y-4">
          {grupos.map(([key, lst]) => {
            const totalGrupo = lst.reduce((s, i) => s + i.valor, 0);
            const header =
              scope === 'mes'
                ? `Dia ${key} · ${diaSemana(lst[0]!.data)}`
                : `${mesCurto(parseInt(key.slice(5, 7), 10) - 1)} ${key.slice(0, 4)}`;
            return (
              <div key={key}>
                <div className="flex items-baseline justify-between gap-2 mb-1.5 px-1">
                  <span className="text-[11px] uppercase tracking-wider text-[var(--ck-muted)]">{header}</span>
                  <span className="text-[11px] font-geist tabular-nums text-[var(--ck-muted)]">
                    {fmtMoneyExact(totalGrupo)}
                  </span>
                </div>
                <ul className="space-y-1">
                  {lst.map((it, idx) => (
                    <li
                      key={it.id}
                      className="flex items-center gap-3 rounded-xl border border-[var(--ck-border)] bg-[var(--ck-surface-2)] px-3 py-2"
                    >
                      <span
                        className="w-1.5 h-8 rounded-full shrink-0"
                        style={{ background: colorForCategoria(it.categoria, idx) }}
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm text-[var(--ck-text)] truncate">{it.descricao}</span>
                          {it.parcela && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--ck-surface-2)] text-[var(--ck-muted)] font-geist tabular-nums">
                              {it.parcela}
                            </span>
                          )}
                          {it.projectType && it.projectType !== 'PESSOAL' && (
                            <span className={`text-[10px] px-1.5 py-0.5 rounded ${TYPE_BADGE[it.projectType] ?? TYPE_BADGE.PESSOAL}`}>
                              {it.projectName || it.projectType}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-[11px] text-[var(--ck-muted)] mt-0.5">
                          {scope === 'ano' && (
                            <>
                              <span className="font-geist tabular-nums">dia {String(it.dia).padStart(2, '0')}</span>
                              <span aria-hidden>·</span>
                            </>
                          )}
                          <span>{it.categoria}</span>
                          <span aria-hidden>·</span>
                          <span className="inline-flex items-center gap-1">
                            {it.cardLast4 ? (
                              <><CreditCard className="w-3 h-3" /> cartão ••{it.cardLast4}</>
                            ) : (
                              <><Landmark className="w-3 h-3" /> conta/débito</>
                            )}
                          </span>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <p className={`text-sm font-geist tabular-nums font-semibold ${it.realizado ? 'text-[var(--ck-neg)]' : 'text-[var(--ck-muted)]'}`}>
                          − {fmtMoneyExact(it.valor)}
                        </p>
                        <p className="text-[10px] text-[var(--ck-muted)] mt-0.5">
                          {it.realizado ? 'pago' : 'previsto'} · acum {fmtMoney(it.acumulado)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
