'use client';

import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useProject } from '@/contexts/project-context';
import { api } from '@/lib/api';
import {
  Plus,
  Upload,
  ChevronDown,
  ChevronRight,
  Trash2,
  Calendar,
  AlertTriangle,
} from 'lucide-react';

// ─── Types ──────────────────────────────────────────────
interface ScheduleConfig {
  id: string;
  dataInicio: string;
  trabalhaDiasUteis: boolean;
  trabalhaSabados: boolean;
  linhaBaseData?: string;
}

interface ScheduleTask {
  id: string;
  stageId: string;
  numero: number;
  nome: string;
  duracao: number;
  dataInicio: string | null;
  dataTermino: string | null;
  predecessoras: string | null;
  valorOrcado: number | null;
  custoReal: number | null;
  percentualConcluido: number;
  ordem: number;
  dataInicioBase?: string | null;
  dataTerminoBase?: string | null;
}

interface ScheduleStage {
  id: string;
  nome: string;
  ordem: number;
  tasks: ScheduleTask[];
}

interface ScheduleHoliday {
  id: string;
  nome: string;
  data: string;
}

interface GanttData {
  config: ScheduleConfig | null;
  stages: ScheduleStage[];
  holidays: ScheduleHoliday[];
  kpis: {
    totalOrcado: number;
    totalReal: number;
    totalDesvio: number;
    percentualTotal: number;
    terminoPrevisto: string | null;
  };
}

// ─── Helpers ────────────────────────────────────────────
function fmt(cents: number | null): string {
  if (cents == null) return '-';
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function fmtDate(iso: string | null): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleDateString('pt-BR');
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString();
}

const DAY_NAMES = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const MONTH_NAMES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

// ─── KPI Cards ──────────────────────────────────────────
function KPICards({ kpis, config }: { kpis: GanttData['kpis']; config: ScheduleConfig | null }) {
  const today = new Date();
  const terminoPrevisto = kpis.terminoPrevisto ? new Date(kpis.terminoPrevisto) : null;
  const diasAtraso = terminoPrevisto && terminoPrevisto < today ? daysBetween(terminoPrevisto, today) : 0;

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
      <div className="bg-white rounded-lg border p-3">
        <div className="text-xs text-gray-500">% Concluído</div>
        <div className="text-xl font-bold text-brand-700">{kpis.percentualTotal}%</div>
        <div className="mt-1 bg-gray-200 rounded-full h-1.5">
          <div className="bg-brand-600 h-1.5 rounded-full" style={{ width: `${kpis.percentualTotal}%` }} />
        </div>
      </div>
      <div className="bg-white rounded-lg border p-3">
        <div className="text-xs text-gray-500">Total Orçado</div>
        <div className="text-lg font-bold text-gray-800">{fmt(kpis.totalOrcado)}</div>
      </div>
      <div className="bg-white rounded-lg border p-3">
        <div className="text-xs text-gray-500">Custo Real</div>
        <div className="text-lg font-bold text-gray-800">{fmt(kpis.totalReal)}</div>
      </div>
      <div className={`bg-white rounded-lg border p-3 ${kpis.totalDesvio > 0 ? 'border-red-300' : kpis.totalDesvio < 0 ? 'border-green-300' : ''}`}>
        <div className="text-xs text-gray-500">Desvio</div>
        <div className={`text-lg font-bold ${kpis.totalDesvio > 0 ? 'text-red-600' : kpis.totalDesvio < 0 ? 'text-green-600' : 'text-gray-600'}`}>
          {fmt(kpis.totalDesvio)}
        </div>
      </div>
      <div className="bg-white rounded-lg border p-3">
        <div className="text-xs text-gray-500">Término Previsto</div>
        <div className="text-lg font-bold text-gray-800">{terminoPrevisto ? fmtDate(kpis.terminoPrevisto) : '-'}</div>
      </div>
      <div className={`bg-white rounded-lg border p-3 ${diasAtraso > 0 ? 'border-red-300 bg-red-50' : ''}`}>
        <div className="text-xs text-gray-500">Dias de Atraso</div>
        <div className={`text-lg font-bold ${diasAtraso > 0 ? 'text-red-600' : 'text-green-600'}`}>
          {diasAtraso > 0 ? diasAtraso : '0'}
        </div>
      </div>
    </div>
  );
}

// ─── Config Panel ───────────────────────────────────────
function ConfigPanel({
  config,
  onSave,
}: {
  config: ScheduleConfig | null;
  onSave: (data: Partial<ScheduleConfig>) => void;
}) {
  const [open, setOpen] = useState(!config);
  const [dataInicio, setDataInicio] = useState(config?.dataInicio?.slice(0, 10) ?? new Date().toISOString().slice(0, 10));
  const [diasUteis, setDiasUteis] = useState(config?.trabalhaDiasUteis ?? true);
  const [sabados, setSabados] = useState(config?.trabalhaSabados ?? false);

  return (
    <div className="mb-4">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-800"
      >
        <Calendar className="w-4 h-4" />
        Configuração do Projeto
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
      </button>
      {open && (
        <div className="mt-2 bg-white border rounded-lg p-4 flex flex-wrap gap-4 items-end">
          <div>
            <label className="text-xs text-gray-500 block">Data Início do Projeto</label>
            <input type="date" value={dataInicio} onChange={(e) => setDataInicio(e.target.value)}
              className="border rounded px-2 py-1 text-sm" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={diasUteis} onChange={(e) => setDiasUteis(e.target.checked)} />
            Só dias úteis
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={sabados} onChange={(e) => setSabados(e.target.checked)} />
            Trabalha sábados
          </label>
          <button
            onClick={() => onSave({ dataInicio: new Date(dataInicio + 'T12:00:00').toISOString(), trabalhaDiasUteis: diasUteis, trabalhaSabados: sabados })}
            className="bg-brand-600 text-white px-4 py-1.5 rounded text-sm hover:bg-brand-700"
          >
            Salvar
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Gantt Chart ────────────────────────────────────────
function GanttChart({ stages, config, holidays }: { stages: ScheduleStage[]; config: ScheduleConfig | null; holidays: ScheduleHoliday[] }) {
  const ganttRef = useRef<HTMLDivElement>(null);
  const [collapsedStages, setCollapsedStages] = useState<Set<string>>(new Set());

  // Calculate timeline range
  const { startDate, endDate, totalDays, days } = useMemo(() => {
    if (!config) return { startDate: new Date(), endDate: new Date(), totalDays: 30, days: [] };

    let minDate = new Date(config.dataInicio);
    let maxDate = addDays(minDate, 30);

    for (const stage of stages) {
      for (const task of stage.tasks) {
        if (task.dataInicio) {
          const d = new Date(task.dataInicio);
          if (d < minDate) minDate = d;
        }
        if (task.dataTermino) {
          const d = new Date(task.dataTermino);
          if (d > maxDate) maxDate = d;
        }
      }
    }

    // Add padding
    minDate = addDays(minDate, -2);
    maxDate = addDays(maxDate, 5);

    const total = daysBetween(minDate, maxDate) + 1;
    const allDays: Date[] = [];
    for (let i = 0; i < total; i++) {
      allDays.push(addDays(minDate, i));
    }

    return { startDate: minDate, endDate: maxDate, totalDays: total, days: allDays };
  }, [stages, config]);

  const holidaySet = useMemo(() => {
    const s = new Set<string>();
    holidays.forEach((h) => s.add(new Date(h.data).toDateString()));
    return s;
  }, [holidays]);

  const toggleStage = (id: string) => {
    setCollapsedStages((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const DAY_W = 28;
  const ROW_H = 32;
  const today = new Date();

  // Build flat list of rows
  const rows = useMemo(() => {
    const r: Array<{ type: 'stage' | 'task'; stage: ScheduleStage; task?: ScheduleTask }> = [];
    for (const stage of stages) {
      r.push({ type: 'stage', stage });
      if (!collapsedStages.has(stage.id)) {
        for (const task of stage.tasks) {
          r.push({ type: 'task', stage, task });
        }
      }
    }
    return r;
  }, [stages, collapsedStages]);

  // Month headers
  const monthHeaders = useMemo(() => {
    const headers: Array<{ label: string; startIdx: number; span: number }> = [];
    let currentMonth = -1;
    for (let i = 0; i < days.length; i++) {
      const m = days[i].getMonth();
      if (m !== currentMonth) {
        if (headers.length > 0) {
          headers[headers.length - 1].span = i - headers[headers.length - 1].startIdx;
        }
        headers.push({ label: `${MONTH_NAMES[m]} ${days[i].getFullYear()}`, startIdx: i, span: 0 });
        currentMonth = m;
      }
    }
    if (headers.length > 0) {
      headers[headers.length - 1].span = days.length - headers[headers.length - 1].startIdx;
    }
    return headers;
  }, [days]);

  if (!config) return null;

  return (
    <div className="border rounded-lg bg-white overflow-hidden">
      <div className="flex overflow-x-auto" ref={ganttRef}>
        {/* LEFT: Task table */}
        <div className="flex-shrink-0 border-r border-gray-300" style={{ width: 500 }}>
          {/* Table header */}
          <div className="flex bg-gray-100 border-b text-xs font-semibold text-gray-600" style={{ height: 56 }}>
            <div className="w-8 px-1 flex items-end pb-1"></div>
            <div className="w-10 px-1 flex items-end pb-1">N°</div>
            <div className="flex-1 px-2 flex items-end pb-1">Tarefa</div>
            <div className="w-12 px-1 flex items-end pb-1 text-center">Dias</div>
            <div className="w-20 px-1 flex items-end pb-1">Início</div>
            <div className="w-20 px-1 flex items-end pb-1">Término</div>
            <div className="w-12 px-1 flex items-end pb-1 text-center">%</div>
          </div>

          {/* Task rows */}
          {rows.map((row, idx) => {
            if (row.type === 'stage') {
              const isCollapsed = collapsedStages.has(row.stage.id);
              return (
                <div
                  key={`s-${row.stage.id}`}
                  className="flex items-center bg-gray-50 border-b cursor-pointer hover:bg-gray-100"
                  style={{ height: ROW_H }}
                  onClick={() => toggleStage(row.stage.id)}
                >
                  <div className="w-8 px-1 flex justify-center">
                    {isCollapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  </div>
                  <div className="w-10 px-1 text-xs font-bold text-gray-500">{row.stage.tasks[0]?.numero ?? ''}</div>
                  <div className="flex-1 px-2 text-xs font-bold text-gray-800 truncate">{row.stage.nome}</div>
                  <div className="w-12" />
                  <div className="w-20" />
                  <div className="w-20" />
                  <div className="w-12" />
                </div>
              );
            }

            const task = row.task!;
            const preds = task.predecessoras ? JSON.parse(task.predecessoras).join(',') : '';
            return (
              <div
                key={`t-${task.id}`}
                className="flex items-center border-b hover:bg-blue-50/50 text-xs"
                style={{ height: ROW_H }}
              >
                <div className="w-8" />
                <div className="w-10 px-1 text-gray-500">{task.numero}</div>
                <div className="flex-1 px-2 text-gray-800 truncate" title={task.nome}>{task.nome}</div>
                <div className="w-12 px-1 text-center text-gray-600">{task.duracao}</div>
                <div className="w-20 px-1 text-gray-600">{fmtDate(task.dataInicio)}</div>
                <div className="w-20 px-1 text-gray-600">{fmtDate(task.dataTermino)}</div>
                <div className="w-12 px-1 text-center">
                  <span className={`${task.percentualConcluido >= 100 ? 'text-green-600 font-bold' : 'text-gray-600'}`}>
                    {task.percentualConcluido}%
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* RIGHT: Gantt bars */}
        <div className="flex-1 overflow-x-auto">
          {/* Timeline header */}
          <div style={{ minWidth: totalDays * DAY_W }}>
            {/* Month row */}
            <div className="flex bg-gray-100 border-b" style={{ height: 24 }}>
              {monthHeaders.map((m, i) => (
                <div
                  key={i}
                  className="text-xs font-semibold text-gray-600 border-r border-gray-300 flex items-center justify-center"
                  style={{ width: m.span * DAY_W }}
                >
                  {m.label}
                </div>
              ))}
            </div>

            {/* Day row */}
            <div className="flex border-b" style={{ height: 32 }}>
              {days.map((d, i) => {
                const isToday = isSameDay(d, today);
                const isWeekend = d.getDay() === 0 || d.getDay() === 6;
                const isHoliday = holidaySet.has(d.toDateString());
                return (
                  <div
                    key={i}
                    className={`flex flex-col items-center justify-center border-r text-[9px] leading-tight ${
                      isToday ? 'bg-brand-100 font-bold' : isHoliday ? 'bg-red-50' : isWeekend ? 'bg-gray-50' : ''
                    }`}
                    style={{ width: DAY_W }}
                  >
                    <span className={isWeekend ? 'text-gray-400' : 'text-gray-500'}>{DAY_NAMES[d.getDay()]}</span>
                    <span className={isToday ? 'text-brand-700' : 'text-gray-600'}>{d.getDate()}</span>
                  </div>
                );
              })}
            </div>

            {/* Gantt rows */}
            {rows.map((row) => {
              if (row.type === 'stage') {
                // Stage summary bar
                const tasks = row.stage.tasks;
                const minStart = tasks.reduce((acc, t) => {
                  if (!t.dataInicio) return acc;
                  const d = new Date(t.dataInicio);
                  return !acc || d < acc ? d : acc;
                }, null as Date | null);
                const maxEnd = tasks.reduce((acc, t) => {
                  if (!t.dataTermino) return acc;
                  const d = new Date(t.dataTermino);
                  return !acc || d > acc ? d : acc;
                }, null as Date | null);

                return (
                  <div key={`gs-${row.stage.id}`} className="relative bg-gray-50 border-b" style={{ height: ROW_H }}>
                    {/* Day columns */}
                    <div className="absolute inset-0 flex">
                      {days.map((d, i) => (
                        <div key={i} className={`border-r ${d.getDay() === 0 || d.getDay() === 6 ? 'bg-gray-100/50' : ''}`} style={{ width: DAY_W }} />
                      ))}
                    </div>
                    {/* Stage bar */}
                    {minStart && maxEnd && (
                      <div
                        className="absolute top-2.5 h-2 bg-gray-500 rounded-sm"
                        style={{
                          left: Math.max(0, daysBetween(startDate, minStart)) * DAY_W + 2,
                          width: Math.max(1, daysBetween(minStart, maxEnd) + 1) * DAY_W - 4,
                        }}
                      />
                    )}
                  </div>
                );
              }

              const task = row.task!;
              const taskStart = task.dataInicio ? new Date(task.dataInicio) : null;
              const taskEnd = task.dataTermino ? new Date(task.dataTermino) : null;

              return (
                <div key={`gt-${task.id}`} className="relative border-b" style={{ height: ROW_H }}>
                  {/* Day columns */}
                  <div className="absolute inset-0 flex">
                    {days.map((d, i) => {
                      const isWeekend = d.getDay() === 0 || d.getDay() === 6;
                      const isHoliday = holidaySet.has(d.toDateString());
                      const isToday = isSameDay(d, today);
                      return (
                        <div
                          key={i}
                          className={`border-r ${
                            isToday ? 'bg-brand-50/50' : isHoliday ? 'bg-red-50/30' : isWeekend ? 'bg-gray-50/50' : ''
                          }`}
                          style={{ width: DAY_W }}
                        />
                      );
                    })}
                  </div>
                  {/* Task bar */}
                  {taskStart && taskEnd && (
                    <div
                      className="absolute top-1.5 rounded group cursor-pointer"
                      style={{
                        left: Math.max(0, daysBetween(startDate, taskStart)) * DAY_W + 2,
                        width: Math.max(1, daysBetween(taskStart, taskEnd) + 1) * DAY_W - 4,
                        height: ROW_H - 12,
                      }}
                    >
                      {/* Background */}
                      <div className="absolute inset-0 bg-brand-400 rounded opacity-80" />
                      {/* Progress fill */}
                      <div
                        className="absolute inset-y-0 left-0 bg-brand-600 rounded-l"
                        style={{ width: `${task.percentualConcluido}%`, borderRadius: task.percentualConcluido >= 100 ? '0.25rem' : '0.25rem 0 0 0.25rem' }}
                      />
                      {/* Tooltip */}
                      <div className="hidden group-hover:block absolute bottom-full left-0 mb-1 bg-gray-800 text-white text-[10px] px-2 py-1 rounded whitespace-nowrap z-50">
                        {task.nome} | {task.duracao}d | {task.percentualConcluido}%
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Today line */}
            {days.some((d) => isSameDay(d, today)) && (
              <div
                className="absolute top-0 bottom-0 w-px bg-red-500 z-20 pointer-events-none"
                style={{ left: 500 + daysBetween(startDate, today) * DAY_W + DAY_W / 2 }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Import Modal ───────────────────────────────────────
function ImportModal({
  projectId,
  onImported,
  onClose,
}: {
  projectId: string;
  onImported: () => void;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Sample data for import (from the analyzed spreadsheet structure)
  const handleImportSample = async () => {
    setLoading(true);
    setError('');
    try {
      const sampleData = {
        dataInicio: '2025-01-06T12:00:00.000Z',
        trabalhaDiasUteis: true,
        trabalhaSabados: false,
        holidays: [
          { nome: 'Confraternização Universal', data: '2025-01-01T12:00:00.000Z' },
          { nome: 'Carnaval', data: '2025-03-04T12:00:00.000Z' },
          { nome: 'Paixão de Cristo', data: '2025-04-18T12:00:00.000Z' },
          { nome: 'Tiradentes', data: '2025-04-21T12:00:00.000Z' },
          { nome: 'Dia do Trabalho', data: '2025-05-01T12:00:00.000Z' },
          { nome: 'Corpus Christi', data: '2025-06-19T12:00:00.000Z' },
        ],
        stages: [
          {
            nome: 'DEMOLIÇÃO',
            tasks: [
              { numero: 2, nome: 'Demolir revestimentos', duracao: 7, predecessoras: null },
              { numero: 3, nome: 'Demolir alvenaria da porta de vidro', duracao: 2, predecessoras: '[2]' },
              { numero: 4, nome: 'Demolir piso e rodapé existente', duracao: 2, predecessoras: '[3]' },
              { numero: 5, nome: 'Demolir vãos porta piso teto', duracao: 1, predecessoras: '[3]' },
              { numero: 6, nome: 'Demolição para rodapé invertido', duracao: 2, predecessoras: '[5]' },
              { numero: 7, nome: 'Demolição bancadas', duracao: 1, predecessoras: '[5]' },
              { numero: 8, nome: 'Retirar louças e metais', duracao: 1, predecessoras: '[5]' },
              { numero: 9, nome: 'Demolição para nicho', duracao: 1, predecessoras: '[8]' },
            ],
          },
          {
            nome: 'CONSTRUÇÃO',
            tasks: [
              { numero: 11, nome: 'Construção das bases em alvenaria', duracao: 5, predecessoras: '[9]' },
              { numero: 12, nome: 'Regularização das alvenarias', duracao: 1, predecessoras: '[11]' },
              { numero: 13, nome: 'Regularização do contra piso', duracao: 1, predecessoras: '[12]' },
              { numero: 14, nome: 'Realocar condensadora', duracao: 2, predecessoras: '[13]' },
              { numero: 15, nome: 'Infraestrutura hidráulica', duracao: 5, predecessoras: '[14]' },
              { numero: 16, nome: 'Impermeabilização áreas molhadas', duracao: 3, predecessoras: '[15]' },
              { numero: 17, nome: 'Relocação dos ralos da varanda', duracao: 1, predecessoras: '[16]' },
            ],
          },
          {
            nome: 'ELÉTRICA',
            tasks: [
              { numero: 19, nome: 'Infraestrutura elétrica (tomadas)', duracao: 5, predecessoras: '[15]' },
              { numero: 20, nome: 'Interruptores', duracao: 1, predecessoras: '[19]' },
              { numero: 21, nome: 'Rabichos para fita de LED', duracao: 2, predecessoras: '[19]' },
            ],
          },
          {
            nome: 'FORRO',
            tasks: [
              { numero: 23, nome: 'Forro vinílico', duracao: 5, predecessoras: '[11]' },
              { numero: 24, nome: 'Cortineiros', duracao: 1, predecessoras: '[23]' },
              { numero: 25, nome: 'Refazer sancas para pé direito', duracao: 3, predecessoras: '[23]' },
            ],
          },
          {
            nome: 'REVESTIMENTOS',
            tasks: [
              { numero: 27, nome: 'Colocação do azulejo banho', duracao: 5, predecessoras: '[25]' },
            ],
          },
          {
            nome: 'PISO',
            tasks: [
              { numero: 29, nome: 'Colocação do porcelanato', duracao: 5, predecessoras: '[27]' },
              { numero: 30, nome: 'Instalação rodapé sobrepor', duracao: 2, predecessoras: '[29]' },
              { numero: 31, nome: 'Instalação rodapé embutir', duracao: 3, predecessoras: '[30]' },
              { numero: 32, nome: 'Instalação dos ralos', duracao: 1, predecessoras: '[29]' },
              { numero: 33, nome: 'Instalação cantoneira transição', duracao: 1, predecessoras: '[29]' },
            ],
          },
          {
            nome: 'PINTURA',
            tasks: [
              { numero: 38, nome: 'Textura cimento queimado', duracao: 4, predecessoras: '[33]' },
              { numero: 39, nome: 'Textura mineral branco capela', duracao: 9, predecessoras: '[33]' },
            ],
          },
          {
            nome: 'MARMORARIA',
            tasks: [
              { numero: 46, nome: 'Medição', duracao: 4, predecessoras: '[13]' },
              { numero: 47, nome: 'Instalação', duracao: 2, predecessoras: '[27]' },
            ],
          },
          {
            nome: 'MARCENÁRIA',
            tasks: [
              { numero: 53, nome: 'Instalação forro', duracao: 2, predecessoras: '[25]' },
              { numero: 55, nome: 'Instalação marcenaria', duracao: 7, predecessoras: '[53]' },
            ],
          },
          {
            nome: 'BOX E VIDRO',
            tasks: [
              { numero: 76, nome: 'Medição', duracao: 1, predecessoras: '[29]' },
              { numero: 77, nome: 'Instalação', duracao: 2, predecessoras: '[31]' },
            ],
          },
          {
            nome: 'LIMPEZA FINAL',
            tasks: [
              { numero: 86, nome: 'Apto para entrega', duracao: 1, predecessoras: '[39]' },
            ],
          },
        ],
      };

      await api.post(`/projects/${projectId}/schedule/import`, sampleData);
      onImported();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
        <h3 className="text-lg font-bold mb-4">Importar Cronograma</h3>

        <p className="text-sm text-gray-600 mb-4">
          Importe um cronograma modelo de obra com etapas e tarefas pré-configuradas,
          incluindo dependências entre tarefas e cálculo automático de datas.
        </p>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded p-2 mb-4 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" /> {error}
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={handleImportSample}
            disabled={loading}
            className="flex-1 bg-brand-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            <Upload className="w-4 h-4" />
            {loading ? 'Importando...' : 'Importar Modelo de Obra'}
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 border rounded-lg text-sm text-gray-600 hover:bg-gray-50"
          >
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Add Task Modal ─────────────────────────────────────
function AddTaskModal({
  projectId,
  stages,
  onCreated,
  onClose,
}: {
  projectId: string;
  stages: ScheduleStage[];
  onCreated: () => void;
  onClose: () => void;
}) {
  const [stageId, setStageId] = useState(stages[0]?.id ?? '');
  const [nome, setNome] = useState('');
  const [duracao, setDuracao] = useState(1);
  const [predecessoras, setPredecessoras] = useState('');
  const [loading, setLoading] = useState(false);

  // Auto-calculate next numero
  const nextNumero = useMemo(() => {
    const allTasks = stages.flatMap((s) => s.tasks);
    return Math.max(0, ...allTasks.map((t) => t.numero)) + 1;
  }, [stages]);

  const handleSubmit = async () => {
    if (!nome.trim() || !stageId) return;
    setLoading(true);
    const predArray = predecessoras ? `[${predecessoras}]` : undefined;
    const stage = stages.find((s) => s.id === stageId);
    const ordem = stage ? stage.tasks.length : 0;

    await api.post(`/projects/${projectId}/schedule/tasks`, {
      stageId,
      numero: nextNumero,
      nome: nome.trim(),
      duracao,
      predecessoras: predArray,
      ordem,
    });
    onCreated();
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
        <h3 className="text-lg font-bold mb-4">Nova Tarefa</h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-500 block mb-1">Etapa</label>
            <select value={stageId} onChange={(e) => setStageId(e.target.value)} className="w-full border rounded px-2 py-1.5 text-sm">
              {stages.map((s) => (
                <option key={s.id} value={s.id}>{s.nome}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Nome da Tarefa</label>
            <input value={nome} onChange={(e) => setNome(e.target.value)} className="w-full border rounded px-2 py-1.5 text-sm" placeholder="Ex: Instalação do piso" />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-xs text-gray-500 block mb-1">Duração (dias)</label>
              <input type="number" min={1} value={duracao} onChange={(e) => setDuracao(parseInt(e.target.value) || 1)} className="w-full border rounded px-2 py-1.5 text-sm" />
            </div>
            <div className="flex-1">
              <label className="text-xs text-gray-500 block mb-1">Predecessoras (N°)</label>
              <input value={predecessoras} onChange={(e) => setPredecessoras(e.target.value)} className="w-full border rounded px-2 py-1.5 text-sm" placeholder="Ex: 2,3" />
            </div>
          </div>
        </div>
        <div className="flex gap-3 mt-4">
          <button onClick={handleSubmit} disabled={loading || !nome.trim()} className="flex-1 bg-brand-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-brand-700 disabled:opacity-50">
            {loading ? 'Criando...' : 'Criar Tarefa'}
          </button>
          <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm text-gray-600 hover:bg-gray-50">Cancelar</button>
        </div>
      </div>
    </div>
  );
}

// ─── Add Stage Modal ────────────────────────────────────
function AddStageModal({
  projectId,
  stagesCount,
  onCreated,
  onClose,
}: {
  projectId: string;
  stagesCount: number;
  onCreated: () => void;
  onClose: () => void;
}) {
  const [nome, setNome] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (!nome.trim()) return;
    setLoading(true);
    await api.post(`/projects/${projectId}/schedule/stages`, { nome: nome.trim(), ordem: stagesCount });
    onCreated();
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
        <h3 className="text-lg font-bold mb-4">Nova Etapa</h3>
        <div>
          <label className="text-xs text-gray-500 block mb-1">Nome da Etapa</label>
          <input value={nome} onChange={(e) => setNome(e.target.value)} className="w-full border rounded px-2 py-1.5 text-sm" placeholder="Ex: DEMOLIÇÃO" />
        </div>
        <div className="flex gap-3 mt-4">
          <button onClick={handleSubmit} disabled={loading || !nome.trim()} className="flex-1 bg-brand-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-brand-700 disabled:opacity-50">
            {loading ? 'Criando...' : 'Criar Etapa'}
          </button>
          <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm text-gray-600 hover:bg-gray-50">Cancelar</button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────
export default function SchedulePage() {
  const { projectId } = useProject();
  const [data, setData] = useState<GanttData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showImport, setShowImport] = useState(false);
  const [showAddTask, setShowAddTask] = useState(false);
  const [showAddStage, setShowAddStage] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const gantt = await api.get<GanttData>(`/projects/${projectId}/schedule/gantt`);
      setData(gantt);
    } catch (e) {
      console.error('Failed to load schedule', e);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { loadData(); }, [loadData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
      </div>
    );
  }

  if (!data) return <div className="text-red-600">Erro ao carregar cronograma</div>;

  const hasData = data.stages.length > 0;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Cronograma da Obra</h1>
          <p className="text-sm text-gray-500">Planejamento e acompanhamento das etapas</p>
        </div>
        <div className="flex gap-2">
          {hasData && (
            <>
              <button
                onClick={() => setShowAddStage(true)}
                className="flex items-center gap-1 border border-gray-300 px-3 py-1.5 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
              >
                <Plus className="w-4 h-4" /> Etapa
              </button>
              <button
                onClick={() => setShowAddTask(true)}
                className="flex items-center gap-1 bg-brand-600 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-brand-700"
              >
                <Plus className="w-4 h-4" /> Tarefa
              </button>
            </>
          )}
          <button
            onClick={() => setShowImport(true)}
            className="flex items-center gap-1 border border-gray-300 px-3 py-1.5 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
          >
            <Upload className="w-4 h-4" /> Importar
          </button>
        </div>
      </div>

      {/* KPIs */}
      {hasData && <KPICards kpis={data.kpis} config={data.config} />}

      {/* Config */}
      <ConfigPanel
        config={data.config}
        onSave={async (cfg) => {
          await api.put(`/projects/${projectId}/schedule/config`, cfg);
          loadData();
        }}
      />

      {/* Gantt or empty state */}
      {hasData ? (
        <GanttChart stages={data.stages} config={data.config} holidays={data.holidays} />
      ) : (
        <div className="flex flex-col items-center justify-center h-64 bg-white rounded-xl border-2 border-dashed border-gray-300">
          <Calendar className="w-12 h-12 text-gray-300 mb-3" />
          <p className="text-gray-500 mb-1">Nenhum cronograma configurado</p>
          <p className="text-sm text-gray-400 mb-4">Importe um modelo ou crie etapas e tarefas manualmente</p>
          <button
            onClick={() => setShowImport(true)}
            className="flex items-center gap-2 bg-brand-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-brand-700"
          >
            <Upload className="w-4 h-4" /> Importar Modelo de Obra
          </button>
        </div>
      )}

      {/* Modals */}
      {showImport && (
        <ImportModal
          projectId={projectId}
          onImported={() => { setShowImport(false); loadData(); }}
          onClose={() => setShowImport(false)}
        />
      )}
      {showAddTask && hasData && (
        <AddTaskModal
          projectId={projectId}
          stages={data.stages}
          onCreated={() => { setShowAddTask(false); loadData(); }}
          onClose={() => setShowAddTask(false)}
        />
      )}
      {showAddStage && (
        <AddStageModal
          projectId={projectId}
          stagesCount={data.stages.length}
          onCreated={() => { setShowAddStage(false); loadData(); }}
          onClose={() => setShowAddStage(false)}
        />
      )}
    </div>
  );
}
