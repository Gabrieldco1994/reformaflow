'use client';

import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine } from 'recharts';
import { useProject } from '@/contexts/project-context';
import { api } from '@/lib/api';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import type { CashFlowEntry } from '@/types';
import { CATEGORIA_MAO_DE_OBRA_OPTIONS, tipoLabel } from '@/lib/expense-options';
import { projectMonthlyExpenses } from '@reformaflow/domain';
import { getExpenseOptions } from '../../expenses/_types';
import type { MonthlyRow, SimRow, SimTipoCard, PayConfig } from '../_types';

/* ═══════════════════════════════════════════════════════════
   MONTHLY PROJECTION
   ═══════════════════════════════════════════════════════════ */

export function MonthlyProjection({
  projecaoMensal, recebimentosPorTipo, porTipo, tipoOverrides, excludes, payConfigs, recDist,
  onToggleExclude, onPayConfigChange, onRecDistChange, onTipoOverrideChange, onResetDespesas, onRemovePayConfig,
}: {
  projecaoMensal: MonthlyRow[];
  recebimentosPorTipo: SimRow[];
  porTipo: SimTipoCard[];
  tipoOverrides: Record<string, string>;
  excludes: Set<string>;
  payConfigs: Record<string, PayConfig>;
  recDist: Record<string, string>;
  onToggleExclude: (id: string) => void;
  onPayConfigChange: (id: string, cfg: PayConfig) => void;
  onRecDistChange: (month: string, val: string) => void;
  onTipoOverrideChange: (tipoKey: string, val: string) => void;
  onResetDespesas: () => void;
  onRemovePayConfig: (id: string) => void;
}) {
  const { projectId: PROJECT_ID, projectType } = useProject();
  const TIPO_DESPESA_OPTIONS = useMemo(() => getExpenseOptions(projectType), [projectType]);
  // Fetch cash flow entries (read-only — never modifies real data)
  const { data: cfEntries = [] } = useQuery<CashFlowEntry[]>({
    queryKey: ['cash-flow', PROJECT_ID],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/cash-flow`),
  });

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [showSummary, setShowSummary] = useState(false);
  const [expandedTipos, setExpandedTipos] = useState<Set<string>>(new Set());


  const formatMonth = (m: string) => {
    const [y, mo] = m.split('-');
    const months = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
    return `${months[parseInt(mo) - 1]}/${y.slice(2)}`;
  };

  const toMonth = (dateStr: string) => dateStr.slice(0, 7); // YYYY-MM

  // Month list from projecaoMensal or generate 12 months
  const monthList = useMemo(() => {
    if (projecaoMensal.length > 0) return projecaoMensal.map((r) => r.month);
    const ms: string[] = [];
    const now = new Date();
    for (let i = 0; i < 12; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      ms.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    return ms;
  }, [projecaoMensal]);

  // Separate recebimentos and despesas
  const recEntries = useMemo(() => cfEntries.filter((e) => e.tipo === 'RECEBIMENTO'), [cfEntries]);
  const despEntries = useMemo(() => cfEntries.filter((e) => e.tipo === 'DESPESA'), [cfEntries]);

  // Group despesas by expenseId (or by entry id if no expenseId)
  interface DespGroup {
    groupId: string;
    titulo?: string;
    categoria: string;
    subcategoria?: string;
    ambiente?: string;
    fornecedor?: string;
    formaPagamento?: string;
    totalValor: number;
    entries: CashFlowEntry[];
    isMulti: boolean;
  }

  const despGroups = useMemo((): DespGroup[] => {
    const byExpense = new Map<string, CashFlowEntry[]>();
    const solos: CashFlowEntry[] = [];

    for (const e of despEntries) {
      if (e.expenseId) {
        const existing = byExpense.get(e.expenseId);
        if (existing) existing.push(e);
        else byExpense.set(e.expenseId, [e]);
      } else {
        solos.push(e);
      }
    }

    const groups: DespGroup[] = [];

    for (const [expId, entries] of byExpense) {
      const sorted = entries.sort((a, b) => a.data.localeCompare(b.data));
      const first = sorted[0];
      groups.push({
        groupId: expId,
        titulo: first.titulo || undefined,
        categoria: first.categoria || '',
        subcategoria: first.subcategoria || undefined,
        ambiente: first.ambiente || undefined,
        fornecedor: first.fornecedor || undefined,
        formaPagamento: first.formaPagamento || undefined,
        totalValor: sorted.reduce((s, e) => s + e.valor, 0),
        entries: sorted,
        isMulti: sorted.length > 1,
      });
    }

    for (const e of solos) {
      groups.push({
        groupId: e.id,
        titulo: e.titulo || undefined,
        categoria: e.categoria || '',
        subcategoria: e.subcategoria || undefined,
        ambiente: e.ambiente || undefined,
        fornecedor: e.fornecedor || undefined,
        formaPagamento: e.formaPagamento || undefined,
        totalValor: e.valor,
        entries: [e],
        isMulti: false,
      });
    }

    return groups.sort((a, b) => b.totalValor - a.totalValor);
  }, [despEntries]);

  // Extra projected-only rows from payConfigs (IDs starting with 'extra_')
  const extraRows = useMemo(() => {
    return Object.entries(payConfigs)
      .filter(([id]) => id.startsWith('extra_'))
      .map(([id, cfg]) => ({
        id,
        titulo: cfg.titulo || 'Despesa Extra',
        valor: parseFloat(cfg.valor || '0'),
        mode: cfg.mode || 'avista',
        parcelas: cfg.parcelas || '1',
        inicio: cfg.inicio || monthList[0] || '',
        categoria: cfg.categoria || '',
        subcategoria: cfg.subcategoria || '',
        ambiente: cfg.ambiente || '',
      }));
  }, [payConfigs, monthList]);

  // Group despesas by categoria for organized display
  const categorias = useMemo(() => {
    const catMap = new Map<string, DespGroup[]>();
    for (const g of despGroups) {
      const cat = g.categoria ? tipoLabel(g.categoria) : 'Outros';
      const arr = catMap.get(cat);
      if (arr) arr.push({ ...g, categoria: cat });
      else catMap.set(cat, [{ ...g, categoria: cat }]);
    }
    // Include extra rows as pseudo-groups in their respective categories
    for (const extra of extraRows) {
      const cat = extra.categoria ? tipoLabel(extra.categoria) : 'Extras (Projeção)';
      const pseudoGroup: DespGroup = {
        groupId: extra.id,
        titulo: extra.titulo,
        categoria: cat,
        subcategoria: extra.subcategoria || undefined,
        ambiente: extra.ambiente || undefined,
        fornecedor: undefined,
        formaPagamento: extra.mode === 'parcelado' ? 'PARCELADO' : 'A_VISTA',
        totalValor: Math.round(extra.valor * 100),
        entries: [],
        isMulti: false,
      };
      const arr = catMap.get(cat);
      if (arr) arr.push(pseudoGroup);
      else catMap.set(cat, [pseudoGroup]);
    }
    return Array.from(catMap.entries())
      .map(([cat, groups]) => ({
        categoria: cat,
        groups,
        total: groups.reduce((s, g) => s + g.totalValor, 0),
      }))
      .sort((a, b) => b.total - a.total);
  }, [despGroups, extraRows]);

  // State for inline add form
  const [showAddExtra, setShowAddExtra] = useState(false);
  const [newExtra, setNewExtra] = useState({ titulo: '', valor: '', mode: 'avista', parcelas: '1', inicio: '', categoria: '', subcategoria: '', ambiente: '', link: '', imageUrl: '' });

  const hasDespChanges = excludes.size > 0 || Object.keys(payConfigs).length > 0;

  // Total recebimentos from real data
  const totalRecReal = useMemo(() => recEntries.reduce((s, e) => s + e.valor, 0), [recEntries]);

  // Recebimentos distribution
  const totalRecDistributed = useMemo(() => {
    return Object.values(recDist).reduce((s, v) => {
      const n = parseFloat(v || '');
      return s + (isNaN(n) ? 0 : Math.round(n * 100));
    }, 0);
  }, [recDist]);
  const recRemaining = totalRecReal - totalRecDistributed;

  // Compute projected monthly despesas based on active groups + payment configs + edited values
  const monthlyDespProjected = useMemo(() => projectMonthlyExpenses({
    monthList,
    groups: despGroups.map((g) => ({
      groupId: g.groupId,
      totalValor: g.totalValor,
      entries: g.entries.map((e) => ({ data: e.data, valor: e.valor })),
      isMulti: g.isMulti,
    })),
    excludes,
    payConfigs: Object.fromEntries(
      Object.entries(payConfigs).map(([k, v]) => [k, {
        mode: v.mode === 'parcelado' ? 'parcelado' : v.mode === 'avista' ? 'avista' : undefined,
        inicio: v.inicio,
        parcelas: v.parcelas,
        valor: v.valor,
      }]),
    ),
    extras: extraRows.map((r) => ({
      valor: r.valor,
      mode: r.mode === 'parcelado' ? 'parcelado' : 'avista',
      parcelas: r.parcelas,
      inicio: r.inicio || undefined,
    })),
  }), [despGroups, excludes, payConfigs, monthList, extraRows]);

  // Total active despesas projected (using edited values)
  const totalDespActive = useMemo(() => {
    const realTotal = despGroups.filter((g) => !excludes.has(g.groupId)).reduce((s, g) => {
      const cfg = payConfigs[g.groupId];
      const v = cfg?.valor ? parseFloat(cfg.valor) : NaN;
      return s + (!isNaN(v) ? Math.round(v * 100) : g.totalValor);
    }, 0);
    const extraTotal = extraRows.reduce((s, r) => s + Math.round(r.valor * 100), 0);
    return realTotal + extraTotal;
  }, [despGroups, excludes, payConfigs, extraRows]);

  // Total active despesas real (original values, no edits)
  const totalDespRealActive = useMemo(() => {
    return despGroups.filter((g) => !excludes.has(g.groupId)).reduce((s, g) => s + g.totalValor, 0);
  }, [despGroups, excludes]);

  // Summary by ambiente — projected totals (derived from despGroups + payConfigs + extras)
  const summaryByAmbiente = useMemo(() => {
    const map = new Map<string, { real: number; proj: number }>();
    for (const g of despGroups) {
      const amb = g.ambiente || 'Sem Ambiente';
      if (!map.has(amb)) map.set(amb, { real: 0, proj: 0 });
      const entry = map.get(amb)!;
      entry.real += g.totalValor;
      if (!excludes.has(g.groupId)) {
        const cfg = payConfigs[g.groupId];
        const v = cfg?.valor ? parseFloat(cfg.valor) : NaN;
        entry.proj += !isNaN(v) ? Math.round(v * 100) : g.totalValor;
      }
    }
    for (const extra of extraRows) {
      const amb = extra.ambiente || 'Sem Ambiente';
      if (!map.has(amb)) map.set(amb, { real: 0, proj: 0 });
      map.get(amb)!.proj += Math.round(extra.valor * 100);
    }
    return Array.from(map.entries())
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.proj - a.proj);
  }, [despGroups, excludes, payConfigs, extraRows]);

  // Summary by tipo — projected totals
  const summaryByTipo = useMemo(() => {
    const map = new Map<string, { real: number; proj: number }>();
    for (const g of despGroups) {
      const tipo = g.categoria ? tipoLabel(g.categoria) : 'Outros';
      if (!map.has(tipo)) map.set(tipo, { real: 0, proj: 0 });
      const entry = map.get(tipo)!;
      entry.real += g.totalValor;
      if (!excludes.has(g.groupId)) {
        const cfg = payConfigs[g.groupId];
        const v = cfg?.valor ? parseFloat(cfg.valor) : NaN;
        entry.proj += !isNaN(v) ? Math.round(v * 100) : g.totalValor;
      }
    }
    for (const extra of extraRows) {
      const tipo = extra.categoria ? tipoLabel(extra.categoria) : 'Extras';
      if (!map.has(tipo)) map.set(tipo, { real: 0, proj: 0 });
      map.get(tipo)!.proj += Math.round(extra.valor * 100);
    }
    return Array.from(map.entries())
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.proj - a.proj);
  }, [despGroups, excludes, payConfigs, extraRows]);

  // Recebimentos summary
  const recSummary = useMemo(() => {
    return recebimentosPorTipo.map((r) => ({
      label: r.label,
      total: r.total,
    }));
  }, [recebimentosPorTipo]);

  // Compute tipo adjustments from tipoOverrides
  // Maps porTipo key → projected total from monthly groups (by matching labels)
  const labelToKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const o of TIPO_DESPESA_OPTIONS) map.set(o.label, o.value);
    return map;
  }, [TIPO_DESPESA_OPTIONS]);

  // Projected total per tipo key (from monthly groups + extras)
  const projByTipoKey = useMemo(() => {
    const result: Record<string, number> = {};
    for (const item of summaryByTipo) {
      const key = labelToKey.get(item.name) || item.name;
      result[key] = item.proj;
    }
    return result;
  }, [summaryByTipo, labelToKey]);

  // Total tipo adjustment = sum of (override - projected) for each tipo with override
  const tipoAdjustment = useMemo(() => {
    let total = 0;
    for (const [tipoKey, valStr] of Object.entries(tipoOverrides)) {
      if (!valStr) continue;
      const overrideVal = parseFloat(valStr);
      if (isNaN(overrideVal)) continue;
      const currentProj = projByTipoKey[tipoKey] ?? 0;
      total += Math.round(overrideVal * 100) - currentProj;
    }
    return total;
  }, [tipoOverrides, projByTipoKey]);

  const hasTipoOverrides = Object.values(tipoOverrides).some((v) => v !== '');

  // Real despesas distribution by month (original entry dates).
  // Despesas excluídas na simulação são removidas também da linha/barra "Real",
  // para que o gráfico não contabilize o que o usuário marcou como excluído.
  const monthlyDespReal = useMemo(() => {
    const result: Record<string, number> = {};
    for (const m of monthList) result[m] = 0;
    for (const e of despEntries) {
      const groupId = e.expenseId || e.id;
      if (excludes.has(groupId)) continue;
      const m = toMonth(e.data);
      if (result[m] !== undefined) result[m] += e.valor;
    }
    return result;
  }, [despEntries, monthList, excludes]);

  // Real recebimentos distribution by month (original entry dates)
  const monthlyRecReal = useMemo(() => {
    const result: Record<string, number> = {};
    for (const m of monthList) result[m] = 0;
    for (const e of recEntries) {
      const m = toMonth(e.data);
      if (result[m] !== undefined) result[m] += e.valor;
    }
    return result;
  }, [recEntries, monthList]);

  // Build projection rows
  const rows = useMemo(() => {
    let saldoRealAcum = 0;
    let saldoProjAcum = 0;

    return monthList.map((month) => {
      const recReal = monthlyRecReal[month] ?? 0;
      const despReal = monthlyDespReal[month] ?? 0;

      const recProjStr = recDist[month] || '';
      const recProjVal = parseFloat(recProjStr);
      const recProj = isNaN(recProjVal) ? 0 : Math.round(recProjVal * 100);
      const despProj = monthlyDespProjected[month] ?? 0;

      saldoRealAcum += recReal - despReal;
      saldoProjAcum += recProj - despProj;

      return { month, recReal, recProj, despReal, despProj, saldoReal: saldoRealAcum, saldoProj: saldoProjAcum };
    });
  }, [monthList, monthlyRecReal, monthlyDespReal, recDist, monthlyDespProjected]);

  const totalRecProj = rows.reduce((s, r) => s + r.recProj, 0);
  const totalDespProj = rows.reduce((s, r) => s + r.despProj, 0);
  const saldoFinal = rows.length > 0 ? rows[rows.length - 1].saldoProj : 0;

  // Adjusted values incorporating tipo overrides
  const totalDespAdjusted = totalDespActive + tipoAdjustment;
  const saldoAdjusted = totalRecProj - totalDespAdjusted;

  // Distribute tipo adjustment proportionally across months for chart
  const rowsAdjusted = useMemo(() => {
    const totalProj = rows.reduce((s, r) => s + r.despProj, 0);
    let saldoAdj = 0;
    return rows.map((r) => {
      const share = totalProj > 0 ? r.despProj / totalProj : 1 / (rows.length || 1);
      const adjustedDesp = r.despProj + Math.round(tipoAdjustment * share);
      saldoAdj += r.recProj - adjustedDesp;
      return { ...r, despProjAdj: adjustedDesp, saldoProjAdj: saldoAdj };
    });
  }, [rows, tipoAdjustment]);

  const kpis = [
    { label: 'Total Recebimentos', value: totalRecProj, color: 'bg-green-50 text-green-700 border-green-200' },
    { label: 'Total Despesas', value: totalDespAdjusted, color: 'bg-orange-50 text-orange-700 border-orange-200', extra: tipoAdjustment !== 0 ? tipoAdjustment : undefined },
    { label: 'Saldo Final Projetado', value: saldoAdjusted, color: saldoAdjusted >= 0 ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-red-50 text-red-700 border-red-200' },
  ];

  const monthOptions = monthList.map((m) => ({ value: m, label: formatMonth(m) }));

  return (
    <div className="space-y-4">
      {/* KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {kpis.map((kpi) => (
          <div key={kpi.label} className={`rounded-lg border p-3 ${kpi.color}`}>
            <p className="text-xs font-medium opacity-75">{kpi.label}</p>
            <p className="text-base font-bold mt-0.5">{formatCurrency(kpi.value / 100)}</p>
            {kpi.extra && (
              <p className={`text-[10px] mt-0.5 ${kpi.extra > 0 ? 'text-red-500' : 'text-green-600'}`}>
                Ajuste tipo: {kpi.extra > 0 ? '+' : ''}{formatCurrency(kpi.extra / 100)}
              </p>
            )}
          </div>
        ))}
      </div>

      {/* Resumo Rápido (collapsible) */}
      <div className="border rounded-lg overflow-hidden">
        <button
          onClick={() => setShowSummary(!showSummary)}
          className="w-full px-3 py-2 bg-gray-50 text-gray-700 flex items-center justify-between hover:bg-gray-100 transition-colors"
        >
          <div className="flex items-center gap-2">
            <span className="text-xs">{showSummary ? '▼' : '▶'}</span>
            <h3 className="font-semibold text-sm">Simulação Rápida por Tipo</h3>
            {hasTipoOverrides && <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full font-medium">Ajustes ativos</span>}
          </div>
          <div className="flex items-center gap-3 text-xs">
            <span className="text-gray-500">Real: <span className="font-semibold">{formatCurrency(totalDespRealActive / 100)}</span></span>
            <span className="text-blue-700 font-semibold">Projetado: {formatCurrency(totalDespAdjusted / 100)}</span>
            {tipoAdjustment !== 0 && (
              <span className={`font-medium ${tipoAdjustment > 0 ? 'text-red-500' : 'text-green-600'}`}>
                ({tipoAdjustment > 0 ? '+' : ''}{formatCurrency(tipoAdjustment / 100)})
              </span>
            )}
          </div>
        </button>
        {showSummary && (
          <div className="p-3 space-y-3 border-t">
            {/* Recebimentos summary */}
            <div>
              <h4 className="text-xs font-semibold text-green-700 mb-1.5">Recebimentos</h4>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {recSummary.map((r) => (
                  <div key={r.label} className="bg-green-50 rounded px-2.5 py-1.5 border border-green-100">
                    <p className="text-[10px] text-green-600 truncate">{r.label}</p>
                    <p className="text-xs font-semibold text-green-800">{formatCurrency(r.total / 100)}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Despesas por Tipo — editable */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <h4 className="text-xs font-semibold text-orange-700">Despesas por Tipo — Simulação Rápida</h4>
                {hasTipoOverrides && (
                  <button
                    onClick={() => { for (const k of Object.keys(tipoOverrides)) onTipoOverrideChange(k, ''); }}
                    className="text-[10px] text-orange-600 hover:text-orange-800 underline"
                  >Limpar ajustes de tipo</button>
                )}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {porTipo.map((tipoCard) => {
                  const currentProj = projByTipoKey[tipoCard.key] ?? 0;
                  const overrideStr = tipoOverrides[tipoCard.key] || '';
                  const overrideVal = parseFloat(overrideStr);
                  const hasOverride = overrideStr !== '' && !isNaN(overrideVal);
                  const effectiveProj = hasOverride ? Math.round(overrideVal * 100) : currentProj;
                  const diff = effectiveProj - tipoCard.total;
                  const isExpanded = expandedTipos.has(tipoCard.key);
                  const hasDetails = tipoCard.ambientes.length > 0;

                  const toggleExpand = () => {
                    setExpandedTipos((prev) => {
                      const next = new Set(prev);
                      if (next.has(tipoCard.key)) next.delete(tipoCard.key);
                      else next.add(tipoCard.key);
                      return next;
                    });
                  };

                  return (
                    <div key={tipoCard.key} className={`border rounded-lg overflow-hidden shadow-sm transition-shadow ${hasOverride ? 'border-blue-300' : 'border-gray-200'} hover:shadow-md`}>
                      {/* Header — clickable */}
                      <button
                        type="button"
                        onClick={toggleExpand}
                        className={`w-full text-left px-3 py-2.5 flex items-start justify-between gap-2 transition-colors ${hasOverride ? 'bg-blue-50 hover:bg-blue-100/70' : 'bg-orange-50 hover:bg-orange-100/60'}`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] text-gray-400 transition-transform" style={{ display: 'inline-block', transform: isExpanded ? 'rotate(90deg)' : 'none' }}>▶</span>
                            <span className="font-semibold text-sm text-gray-800 truncate">{tipoCard.label}</span>
                            {tipoCard.key === 'MAO_DE_OBRA' && <span className="text-[9px] bg-gray-200 text-gray-500 px-1 py-0.5 rounded">subcategorias</span>}
                          </div>
                          <div className="flex items-center gap-3 text-xs mt-1 ml-4 flex-wrap">
                            <span className="text-gray-500">Total: <span className="font-semibold">{formatCurrency(tipoCard.total / 100)}</span></span>
                            {typeof tipoCard.pago === 'number' && (
                              <span className="text-green-700">Pago: <span className="font-medium">{formatCurrency(tipoCard.pago / 100)}</span></span>
                            )}
                            {typeof tipoCard.planejado === 'number' && tipoCard.planejado > 0 && (
                              <span className="text-amber-700">Planejado: <span className="font-medium">{formatCurrency(tipoCard.planejado / 100)}</span></span>
                            )}
                            <span className="text-gray-400" title="Soma das parcelas no horizonte da projeção mensal exibida">Parcelas no período: <span className="font-medium">{formatCurrency(currentProj / 100)}</span></span>
                          </div>
                          {(() => {
                            const semData = (tipoCard.planejado ?? 0) - Math.max(0, currentProj - (tipoCard.pago ?? 0));
                            if (semData > 100) {
                              return (
                                <div
                                  className="ml-4 mt-1 text-[10px] text-orange-600 flex items-center gap-1"
                                  title="Existem despesas planejadas sem data de pagamento — elas entram no Total mas não nas parcelas projetadas. Defina datas em /expenses para projetar."
                                >
                                  <span>⚠</span>
                                  <span>{formatCurrency(semData / 100)} planejado sem data de pagamento</span>
                                </div>
                              );
                            }
                            return null;
                          })()}
                        </div>
                        {hasOverride && diff !== 0 && (
                          <span className={`text-xs font-semibold whitespace-nowrap mt-0.5 ${diff > 0 ? 'text-red-500' : 'text-green-600'}`}>
                            {diff > 0 ? '▲' : '▼'} {formatCurrency(Math.abs(diff) / 100)}
                          </span>
                        )}
                      </button>

                      {/* Simulation input — always visible */}
                      <div className="px-3 py-1.5 border-t border-gray-100 bg-white">
                        <div className="flex items-center gap-2">
                          <label className="text-[10px] text-gray-400 whitespace-nowrap">Simular:</label>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            placeholder={(currentProj / 100).toFixed(2)}
                            value={overrideStr}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => onTipoOverrideChange(tipoCard.key, e.target.value)}
                            className={`flex-1 border rounded px-2 py-1 text-xs text-right focus:outline-none focus:ring-1 focus:ring-blue-300 ${hasOverride ? 'border-blue-400 bg-blue-50 font-semibold' : 'border-gray-200'}`}
                          />
                          {hasOverride && (
                            <button
                              onClick={() => onTipoOverrideChange(tipoCard.key, '')}
                              className="text-gray-400 hover:text-red-500 text-xs"
                              title="Limpar"
                            >✕</button>
                          )}
                        </div>
                      </div>

                      {/* Expandable detail */}
                      {isExpanded && hasDetails && (
                        <div className="border-t border-gray-100 bg-gray-50/50 px-3 py-2">
                          <table className="w-full text-[10px]">
                            <thead>
                              <tr className="text-gray-400 border-b border-gray-200">
                                <th className="text-left py-1 font-medium">Ambiente</th>
                                <th className="text-right py-1 font-medium">Valor</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                              {tipoCard.ambientes.map((amb) => (
                                <React.Fragment key={amb.key}>
                                  <tr className="hover:bg-white/60">
                                    <td className="py-1 text-gray-600 font-medium">{amb.label}</td>
                                    <td className="py-1 text-right text-gray-600 font-medium">{formatCurrency(amb.total / 100)}</td>
                                  </tr>
                                  {tipoCard.key === 'MAO_DE_OBRA' && amb.categorias?.map((cat) => (
                                    <tr key={cat.key} className="text-gray-400 hover:bg-white/40">
                                      <td className="py-0.5 pl-4 text-[9px]">↳ {cat.label}</td>
                                      <td className="py-0.5 text-right text-[9px]">{formatCurrency(cat.total / 100)}</td>
                                    </tr>
                                  ))}
                                </React.Fragment>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Resumo por Ambiente (read-only) */}
            <div>
              <h4 className="text-xs font-semibold text-gray-500 mb-1.5">Resumo por Ambiente</h4>
              <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2">
                {summaryByAmbiente.map((item) => {
                  const diff = item.proj - item.real;
                  return (
                    <div key={item.name} className="bg-gray-50 rounded px-2.5 py-1.5 border border-gray-200">
                      <p className="text-[10px] text-gray-500 truncate" title={item.name}>{item.name}</p>
                      <div className="flex items-baseline justify-between mt-0.5">
                        <span className="text-[10px] text-gray-400">Real: {formatCurrency(item.real / 100)}</span>
                        <span className="text-xs font-semibold text-gray-700">{formatCurrency(item.proj / 100)}</span>
                      </div>
                      {diff !== 0 && (
                        <p className={`text-[9px] text-right ${diff > 0 ? 'text-red-500' : 'text-green-600'}`}>
                          {diff > 0 ? '+' : ''}{formatCurrency(diff / 100)}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Despesas — grouped by categoria with checkboxes */}
      <div className="border rounded-lg overflow-hidden">
        <div className="px-3 py-2 bg-orange-50 text-orange-800 flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-sm">Despesas do Fluxo de Caixa</h3>
            <p className="text-[10px] opacity-70 mt-0.5">Dados reais (somente leitura). Use checkboxes para incluir/excluir da projeção.</p>
          </div>
          {hasDespChanges && (
            <button
              onClick={onResetDespesas}
              className="px-3 py-1 text-xs bg-white border border-orange-300 rounded hover:bg-orange-100 text-orange-700 font-medium"
            >
              🔄 Limpar Alterações
            </button>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="w-8 px-2 py-1.5" />
                <th className="text-left px-3 py-1.5 font-medium text-gray-600">Título</th>
                <th className="text-right px-3 py-1.5 font-medium text-gray-400 bg-gray-100/50">Valor Real</th>
                <th className="text-center px-3 py-1.5 font-medium text-gray-400 bg-gray-100/50">Pagto Real</th>
                <th className="text-center px-3 py-1.5 font-medium text-gray-400 bg-gray-100/50">Parc. Real</th>
                <th className="text-right px-3 py-1.5 font-medium text-blue-700 bg-blue-50/30">Valor Proj.</th>
                <th className="text-center px-3 py-1.5 font-medium text-blue-700 bg-blue-50/30">Pagto Proj.</th>
                <th className="text-center px-3 py-1.5 font-medium text-blue-700 bg-blue-50/30">Parc. Proj.</th>
                <th className="text-center px-3 py-1.5 font-medium text-blue-700 bg-blue-50/30">Mês Início</th>
              </tr>
            </thead>
            <tbody>
              {categorias.map((cat) => (
                <React.Fragment key={cat.categoria}>
                  {/* Categoria header row */}
                  <tr className="bg-orange-50/60 border-t border-b">
                    <td colSpan={2} className="px-3 py-1.5 font-semibold text-orange-800 text-xs">
                      {cat.categoria}
                      <span className="ml-2 text-[10px] font-normal text-orange-500">({cat.groups.length} itens)</span>
                    </td>
                    <td className="px-3 py-1.5 text-right font-semibold text-orange-800 text-xs bg-gray-100/30">
                      {formatCurrency(cat.total / 100)}
                    </td>
                    <td colSpan={2} className="bg-gray-100/30" />
                    <td className="px-3 py-1.5 text-right text-xs bg-blue-50/20">
                      {(() => {
                        const projTotal = cat.groups.reduce((s, g) => {
                          const c = payConfigs[g.groupId];
                          const v = c?.valor ? parseFloat(c.valor) : NaN;
                          return s + (!isNaN(v) ? Math.round(v * 100) : g.totalValor);
                        }, 0);
                        return <span className={`font-semibold ${projTotal !== cat.total ? 'text-blue-700' : 'text-orange-800'}`}>{formatCurrency(projTotal / 100)}</span>;
                      })()}
                    </td>
                    <td colSpan={3} className="bg-blue-50/20" />
                  </tr>
                  {/* Expense rows within categoria */}
                  {cat.groups.map((group) => {
                    const isExtra = group.groupId.startsWith('extra_');
                    const isExcluded = excludes.has(group.groupId);
                    const isExpanded = expandedGroups.has(group.groupId);
                    const cfg = payConfigs[group.groupId] || {
                      mode: isExtra ? 'avista' : (group.isMulti ? 'parcelado' : 'avista'),
                      parcelas: isExtra ? '1' : String(group.entries.length),
                      inicio: isExtra ? '' : toMonth(group.entries[0].data),
                      valor: '',
                    };

                    // Compute projected value for this group
                    const valorProjStr = cfg.valor;
                    const valorProjParsed = parseFloat(valorProjStr);
                    const valorProjetado = valorProjStr && !isNaN(valorProjParsed) ? Math.round(valorProjParsed * 100) : group.totalValor;
                    const hasValorChange = !isExtra && valorProjStr !== '' && !isNaN(valorProjParsed) && Math.round(valorProjParsed * 100) !== group.totalValor;
                    const deltaPercent = hasValorChange ? ((valorProjetado - group.totalValor) / group.totalValor * 100) : 0;

                    return (
                      <React.Fragment key={group.groupId}>
                        <tr className={`hover:bg-gray-50 border-b border-gray-100 ${isExcluded ? 'opacity-40' : ''} ${isExtra ? 'bg-purple-50/20' : ''}`}>
                          <td className="px-2 py-1.5 text-center">
                            <input
                              type="checkbox"
                              checked={!isExcluded}
                              onChange={() => onToggleExclude(group.groupId)}
                              className="rounded border-gray-300"
                              title={isExtra ? 'Incluir/excluir item simulado da projeção' : 'Incluir/excluir esta despesa da projeção'}
                            />
                            {isExtra && (
                              <button
                                onClick={() => {
                                  if (confirm('Excluir definitivamente este item simulado?')) onRemovePayConfig(group.groupId);
                                }}
                                className="block mx-auto mt-0.5 text-[9px] text-red-400 hover:text-red-600"
                                title="Excluir definitivamente"
                              >✕</button>
                            )}
                          </td>
                          <td className="px-3 py-1.5">
                            {isExtra ? (
                              <div>
                                <input
                                  value={cfg.titulo || ''}
                                  onChange={(e) => onPayConfigChange(group.groupId, { ...cfg, titulo: e.target.value })}
                                  className="border rounded px-1 py-0.5 text-xs w-full font-medium"
                                  placeholder="Nome da despesa"
                                />
                                {group.ambiente && (
                                  <div className="text-[10px] text-gray-400 mt-0.5">{group.ambiente}</div>
                                )}
                              </div>
                            ) : (
                              <>
                                <div className="font-medium flex items-center gap-1">
                                  {group.isMulti && (
                                    <button
                                      onClick={() => setExpandedGroups((p) => {
                                        const next = new Set(p);
                                        if (next.has(group.groupId)) next.delete(group.groupId);
                                        else next.add(group.groupId);
                                        return next;
                                      })}
                                      className="text-gray-400 hover:text-gray-600"
                                    >
                                      {isExpanded ? '▼' : '▶'}
                                    </button>
                                  )}
                                  <span>{group.titulo || group.categoria}</span>
                                </div>
                                {(group.fornecedor || group.ambiente) && (
                                  <div className="text-[10px] text-gray-400 mt-0.5">
                                    {[group.fornecedor, group.ambiente].filter(Boolean).join(' · ')}
                                  </div>
                                )}
                              </>
                            )}
                          </td>
                          {/* === REAL columns (read-only, gray bg) === */}
                          <td className="px-3 py-1.5 text-right text-gray-500 bg-gray-50/50">
                            {isExtra ? <span className="text-gray-300">—</span> : formatCurrency(group.totalValor / 100)}
                          </td>
                          <td className="px-3 py-1.5 text-center text-gray-500 bg-gray-50/50 text-[10px]">
                            {isExtra ? <span className="text-gray-300">—</span> : (group.formaPagamento === 'PARCELADO' ? 'Parcelado' : group.formaPagamento === 'QUINZENAL' ? 'Quinzenal' : 'À Vista')}
                          </td>
                          <td className="px-3 py-1.5 text-center text-gray-500 bg-gray-50/50 text-[10px]">
                            {isExtra ? <span className="text-gray-300">—</span> : `${group.entries.length}x`}
                          </td>
                          {/* === PROJETADO columns (editable, blue tint) === */}
                          <td className="px-3 py-1.5 text-right bg-blue-50/20">
                            <div className="flex flex-col items-end gap-0.5">
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                placeholder={(group.totalValor / 100).toFixed(2)}
                                value={cfg.valor}
                                onChange={(e) => onPayConfigChange(group.groupId, { ...cfg, valor: e.target.value })}
                                className={`w-24 border rounded px-1.5 py-0.5 text-xs text-right focus:outline-none focus:ring-1 focus:ring-blue-300 ${hasValorChange ? 'border-blue-400 bg-blue-50' : 'border-gray-200 bg-white'}`}
                                disabled={isExcluded}
                              />
                              {hasValorChange && (
                                <span className={`text-[9px] font-medium ${deltaPercent > 0 ? 'text-red-500' : 'text-green-600'}`}>
                                  {deltaPercent > 0 ? '↑' : '↓'} {Math.abs(deltaPercent).toFixed(0)}%
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-1.5 text-center bg-blue-50/20">
                            <select
                              value={cfg.mode}
                              onChange={(e) => onPayConfigChange(group.groupId, { ...cfg, mode: e.target.value, parcelas: e.target.value === 'avista' ? '1' : cfg.parcelas })}
                              className="border rounded px-1 py-0.5 text-xs bg-white"
                              disabled={isExcluded}
                            >
                              <option value="avista">À Vista</option>
                              <option value="parcelado">Parcelado</option>
                            </select>
                          </td>
                          <td className="px-3 py-1.5 text-center bg-blue-50/20">
                            {cfg.mode === 'parcelado' ? (
                              <select
                                value={cfg.parcelas}
                                onChange={(e) => onPayConfigChange(group.groupId, { ...cfg, parcelas: e.target.value })}
                                className="border rounded px-1 py-0.5 text-xs bg-white w-14"
                                disabled={isExcluded}
                              >
                                {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
                                  <option key={n} value={String(n)}>{n}x</option>
                                ))}
                              </select>
                            ) : (
                              <span className="text-gray-400">1x</span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-center bg-blue-50/20">
                            <select
                              value={cfg.inicio || (group.entries.length > 0 ? toMonth(group.entries[0].data) : monthList[0])}
                              onChange={(e) => onPayConfigChange(group.groupId, { ...cfg, inicio: e.target.value })}
                              className="border rounded px-1 py-0.5 text-xs bg-white"
                              disabled={isExcluded}
                            >
                              {monthOptions.map((mo) => (
                                <option key={mo.value} value={mo.value}>{mo.label}</option>
                              ))}
                            </select>
                          </td>
                        </tr>
                        {/* Expanded installment rows */}
                        {isExpanded && !isExtra && group.entries.map((entry, idx) => (
                          <tr key={entry.id} className="bg-gray-50/50">
                            <td />
                            <td className="px-3 py-1 pl-8 text-gray-500">
                              ↳ Parcela {entry.parcela || `${idx + 1}/${group.entries.length}`}
                              <span className="ml-2 text-gray-400">{formatDateBR(entry.data)}</span>
                            </td>
                            <td className="px-3 py-1 text-right text-gray-500 bg-gray-50/50">{formatCurrency(entry.valor / 100)}</td>
                            <td colSpan={2} className="bg-gray-50/50" />
                            <td colSpan={4} className="bg-blue-50/10" />
                          </tr>
                        ))}
                      </React.Fragment>
                    );
                  })}
                </React.Fragment>
              ))}

              {/* Inline add extra row */}
              {showAddExtra && (
                <tr className="border-t bg-purple-50/30">
                  <td className="px-2 py-1.5 text-center">
                    <button onClick={() => { setShowAddExtra(false); setNewExtra({ titulo: '', valor: '', mode: 'avista', parcelas: '1', inicio: '', categoria: '', subcategoria: '', ambiente: '', link: '', imageUrl: '' }); }}
                      className="text-gray-400 hover:text-gray-600 text-xs">✕</button>
                  </td>
                  <td className="px-3 py-1.5" colSpan={4}>
                    <div className="flex flex-wrap gap-1.5 items-center">
                      <input value={newExtra.titulo} onChange={(e) => setNewExtra((p) => ({ ...p, titulo: e.target.value }))}
                        className="border rounded px-1.5 py-0.5 text-xs flex-1 min-w-[120px]" placeholder="Nome da despesa" autoFocus />
                      <select value={newExtra.categoria} onChange={(e) => setNewExtra((p) => ({ ...p, categoria: e.target.value, subcategoria: '' }))}
                        className="border rounded px-1 py-0.5 text-xs bg-white">
                        <option value="">Tipo...</option>
                        {TIPO_DESPESA_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
                      </select>
                      {newExtra.categoria === 'MAO_DE_OBRA' && (
                        <select value={newExtra.subcategoria} onChange={(e) => setNewExtra((p) => ({ ...p, subcategoria: e.target.value }))}
                          className="border rounded px-1 py-0.5 text-xs bg-white">
                          <option value="">Categoria...</option>
                          {CATEGORIA_MAO_DE_OBRA_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
                        </select>
                      )}
                      <input value={newExtra.ambiente} onChange={(e) => setNewExtra((p) => ({ ...p, ambiente: e.target.value }))}
                        className="border rounded px-1 py-0.5 text-xs w-24" placeholder="Ambiente" />
                      <input type="url" value={newExtra.link} onChange={(e) => setNewExtra((p) => ({ ...p, link: e.target.value }))}
                        className="border rounded px-1.5 py-0.5 text-xs w-40" placeholder="URL do produto (opcional)" />
                      <input type="url" value={newExtra.imageUrl} onChange={(e) => setNewExtra((p) => ({ ...p, imageUrl: e.target.value }))}
                        className="border rounded px-1.5 py-0.5 text-xs w-40" placeholder="URL da imagem (opcional)" />
                    </div>
                  </td>
                  <td className="px-3 py-1.5 bg-blue-50/20">
                    <input type="number" value={newExtra.valor} onChange={(e) => setNewExtra((p) => ({ ...p, valor: e.target.value }))}
                      className="border rounded px-1 py-0.5 text-xs w-20 text-right" placeholder="0,00" step="0.01" />
                  </td>
                  <td className="px-3 py-1.5 bg-blue-50/20">
                    <select value={newExtra.mode} onChange={(e) => setNewExtra((p) => ({ ...p, mode: e.target.value }))}
                      className="border rounded px-1 py-0.5 text-xs bg-white">
                      <option value="avista">À Vista</option>
                      <option value="parcelado">Parcelado</option>
                    </select>
                  </td>
                  <td className="px-3 py-1.5 bg-blue-50/20">
                    {newExtra.mode === 'parcelado' ? (
                      <select value={newExtra.parcelas} onChange={(e) => setNewExtra((p) => ({ ...p, parcelas: e.target.value }))}
                        className="border rounded px-1 py-0.5 text-xs bg-white">
                        {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (<option key={n} value={String(n)}>{n}x</option>))}
                      </select>
                    ) : <span className="text-gray-400">1x</span>}
                  </td>
                  <td className="px-3 py-1.5 bg-blue-50/20">
                    <div className="flex items-center gap-1">
                      <select value={newExtra.inicio} onChange={(e) => setNewExtra((p) => ({ ...p, inicio: e.target.value }))}
                        className="border rounded px-1 py-0.5 text-xs bg-white">
                        <option value="">Mês...</option>
                        {monthOptions.map((mo) => (<option key={mo.value} value={mo.value}>{mo.label}</option>))}
                      </select>
                      <button
                        onClick={() => {
                          if (!newExtra.titulo || !newExtra.valor || !newExtra.inicio) return;
                          const id = `extra_${Date.now()}`;
                          onPayConfigChange(id, {
                            mode: newExtra.mode,
                            parcelas: newExtra.parcelas,
                            inicio: newExtra.inicio,
                            valor: newExtra.valor,
                            titulo: newExtra.titulo,
                            categoria: newExtra.categoria,
                            subcategoria: newExtra.subcategoria,
                            ambiente: newExtra.ambiente,
                            link: newExtra.link || undefined,
                            imageUrl: newExtra.imageUrl || undefined,
                          });
                          setNewExtra({ titulo: '', valor: '', mode: 'avista', parcelas: '1', inicio: '', categoria: '', subcategoria: '', ambiente: '', link: '', imageUrl: '' });
                          setShowAddExtra(false);
                        }}
                        disabled={!newExtra.titulo || !newExtra.valor || !newExtra.inicio}
                        className="bg-purple-600 text-white px-2 py-0.5 rounded text-xs hover:bg-purple-700 disabled:opacity-40"
                      >✓</button>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot className="bg-gray-50 border-t">
              <tr className="font-semibold">
                <td className="px-2 py-1.5 text-center text-[10px] text-gray-400">
                  {despGroups.filter((g) => !excludes.has(g.groupId)).length}/{despGroups.length}{extraRows.length > 0 ? `+${extraRows.length}` : ''}
                </td>
                <td className="px-3 py-1.5">Total</td>
                <td className="px-3 py-1.5 text-right text-gray-500 bg-gray-100/50">{formatCurrency(totalDespRealActive / 100)}</td>
                <td colSpan={2} className="bg-gray-100/50" />
                <td className="px-3 py-1.5 text-right font-bold text-blue-700 bg-blue-50/20">{formatCurrency(totalDespActive / 100)}</td>
                <td colSpan={3} className="bg-blue-50/20" />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Add extra button */}
      {!showAddExtra && (
        <button
          onClick={() => setShowAddExtra(true)}
          className="w-full border-2 border-dashed border-purple-300 rounded-lg py-2 text-purple-600 text-sm hover:bg-purple-50 hover:border-purple-400 transition-colors"
        >
          + Adicionar despesa projetada
        </button>
      )}

      {/* Recebimentos — distribuição por mês */}
      <div className="border rounded-lg overflow-hidden">
        <div className="px-3 py-2 bg-green-50 text-green-800 flex items-center justify-between">
          <h3 className="font-semibold text-sm">Recebimentos — Distribuição Mensal</h3>
          <div className="text-xs">
            <span className="font-medium">Disponível: {formatCurrency(totalRecReal / 100)}</span>
            <span className="mx-2">|</span>
            <span className="font-medium">Distribuído: {formatCurrency(totalRecDistributed / 100)}</span>
            <span className="mx-2">|</span>
            <span className={`font-bold ${recRemaining >= 0 ? 'text-green-700' : 'text-red-600'}`}>
              Restante: {formatCurrency(recRemaining / 100)}
            </span>
          </div>
        </div>
        <div className="grid grid-cols-4 md:grid-cols-6 gap-2 p-3">
          {monthList.map((month) => (
            <div key={month} className="text-center">
              <label className="text-[10px] font-medium text-gray-500 block">{formatMonth(month)}</label>
              <input
                type="number"
                step="0.01"
                min="0"
                placeholder="0"
                value={recDist[month] ?? ''}
                onChange={(e) => onRecDistChange(month, e.target.value)}
                className="w-full border border-gray-200 rounded px-1 py-0.5 text-xs text-right focus:outline-none focus:ring-1 focus:ring-green-300 mt-0.5"
              />
            </div>
          ))}
        </div>
        {recRemaining < 0 && (
          <div className="px-3 pb-2">
            <p className="text-xs text-red-600 font-medium">⚠️ Valor distribuído excede o total em {formatCurrency(Math.abs(recRemaining) / 100)}</p>
          </div>
        )}
      </div>

      {/* Chart 1: Saldo Acumulado */}
      <div className="border rounded-lg p-4 bg-white">
        <h4 className="text-sm font-semibold text-gray-700 mb-1">Saldo Acumulado — Real vs Projetado</h4>
        <details className="mb-3">
          <summary className="text-[11px] text-gray-500 cursor-pointer hover:text-gray-700 select-none">
            O que esse gráfico mostra?
          </summary>
          <div className="mt-2 text-[11px] text-gray-600 bg-gray-50 border border-gray-200 rounded p-2 space-y-1">
            <p><span className="inline-block w-3 h-3 bg-gray-400 rounded-sm mr-1 align-middle"></span><b>Saldo Real:</b> recebimentos − despesas mês a mês usando o que está registrado no fluxo de caixa (despesas excluídas na simulação não entram).</p>
            <p><span className="inline-block w-3 h-3 bg-blue-500 rounded-sm mr-1 align-middle"></span><b>Saldo Projetado:</b> mesmo cálculo aplicando suas simulações (overrides de valor por tipo, reparcelamentos, despesas excluídas).</p>
            <p className="text-gray-500 italic">💡 Se a linha cai abaixo de zero, você precisa de mais recebimentos ou ajustar despesas naquele mês.</p>
          </div>
        </details>
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={rowsAdjusted.map((r) => ({
            month: formatMonth(r.month),
            'Saldo Real': r.saldoReal / 100,
            'Saldo Projetado': (r.saldoProjAdj) / 100,
          }))}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="month" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}k`} />
            <Tooltip formatter={(value: number) => formatCurrency(value)} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <ReferenceLine y={0} stroke="#666" strokeDasharray="3 3" />
            <Line type="monotone" dataKey="Saldo Real" stroke="#6b7280" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="Saldo Projetado" stroke="#2563eb" strokeWidth={2.5} dot={false} strokeDasharray="5 3" />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Chart 2: Despesas por Mês */}
      <div className="border rounded-lg p-4 bg-white">
        <h4 className="text-sm font-semibold text-gray-700 mb-1">Despesas por Mês — Projetado</h4>
        <details className="mb-3">
          <summary className="text-[11px] text-gray-500 cursor-pointer hover:text-gray-700 select-none">
            O que significa cada barra?
          </summary>
          <div className="mt-2 text-[11px] text-gray-600 bg-gray-50 border border-gray-200 rounded p-2 space-y-1">
            <p><span className="inline-block w-3 h-3 bg-orange-300 rounded-sm mr-1 align-middle"></span><b>Despesas Reais:</b> o que está efetivamente registrado no fluxo de caixa de cada mês (parcelas com data definida — pagas ou planejadas; despesas excluídas na simulação não entram).</p>
            <p><span className="inline-block w-3 h-3 bg-orange-500 rounded-sm mr-1 align-middle"></span><b>Despesas Projetadas:</b> mesma base, mas aplicando seus ajustes (mudança de parcelas, valores simulados, exclusões e despesas extras adicionadas). Sem nenhum ajuste, é igual ao Real.</p>
            <p className="text-gray-500 italic">💡 Se uma despesa está como "Planejada" mas sem data de pagamento definida, ela não aparece aqui. Defina datas em /expenses para projetar.</p>
          </div>
        </details>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={rowsAdjusted.map((r) => ({
            month: formatMonth(r.month),
            'Despesas Projetadas': (r.despProjAdj) / 100,
            'Despesas Reais': r.despReal / 100,
          }))}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="month" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}k`} />
            <Tooltip formatter={(value: number) => formatCurrency(value)} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="Despesas Reais" fill="#fdba74" />
            <Bar dataKey="Despesas Projetadas" fill="#f97316" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Projection Table */}
      <div className="border rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-3 py-2 font-medium text-gray-600 sticky left-0 bg-gray-50">Mês</th>
                <th className="text-right px-3 py-2 font-medium text-green-700">Receb. Real</th>
                <th className="text-right px-3 py-2 font-medium text-green-700">Receb. Proj.</th>
                <th className="text-right px-3 py-2 font-medium text-orange-700">Desp. Real</th>
                <th className="text-right px-3 py-2 font-medium text-orange-700">Desp. Proj.</th>
                <th className="text-right px-3 py-2 font-medium text-gray-700">Saldo Acum. Real</th>
                <th className="text-right px-3 py-2 font-medium text-blue-700">Saldo Acum. Proj.</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rowsAdjusted.map((row) => (
                <tr key={row.month} className="hover:bg-gray-50">
                  <td className="px-3 py-1.5 font-medium sticky left-0 bg-white">{formatMonth(row.month)}</td>
                  <td className="px-3 py-1.5 text-right text-green-700">{formatCurrency(row.recReal / 100)}</td>
                  <td className="px-3 py-1.5 text-right text-green-600 font-medium">{formatCurrency(row.recProj / 100)}</td>
                  <td className="px-3 py-1.5 text-right text-orange-700">{formatCurrency(row.despReal / 100)}</td>
                  <td className="px-3 py-1.5 text-right text-orange-600 font-medium">{formatCurrency((row.despProjAdj) / 100)}</td>
                  <td className={`px-3 py-1.5 text-right font-medium ${row.saldoReal >= 0 ? 'text-gray-700' : 'text-red-600'}`}>
                    {formatCurrency(row.saldoReal / 100)}
                  </td>
                  <td className={`px-3 py-1.5 text-right font-bold ${(row.saldoProjAdj) >= 0 ? 'text-blue-700' : 'text-red-600'}`}>
                    {formatCurrency((row.saldoProjAdj) / 100)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-gray-50 border-t font-semibold">
              <tr>
                <td className="px-3 py-2 sticky left-0 bg-gray-50">Total</td>
                <td className="px-3 py-2 text-right text-green-700">{formatCurrency(rows.reduce((s, r) => s + r.recReal, 0) / 100)}</td>
                <td className="px-3 py-2 text-right text-green-700">{formatCurrency(totalRecProj / 100)}</td>
                <td className="px-3 py-2 text-right text-orange-700">{formatCurrency(rows.reduce((s, r) => s + r.despReal, 0) / 100)}</td>
                <td className="px-3 py-2 text-right text-orange-700">{formatCurrency(totalDespAdjusted / 100)}</td>
                <td className="px-3 py-2 text-right">{formatCurrency(rows.length > 0 ? rows[rows.length - 1].saldoReal / 100 : 0)}</td>
                <td className={`px-3 py-2 text-right font-bold ${saldoAdjusted >= 0 ? 'text-blue-700' : 'text-red-600'}`}>
                  {formatCurrency(saldoAdjusted / 100)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}
