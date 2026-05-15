'use client';

import { useMemo, useRef, useState } from 'react';
import type {
  ScheduleConfig,
  ScheduleHoliday,
  ScheduleStage,
  ScheduleTask,
  TaskUpdatePatch,
} from '../_types';
import { DAY_NAMES, MONTH_NAMES, addDays, daysBetween, isSameDay } from '../_lib/format';
import { EditableTaskRow, ROW_H } from './EditableTaskRow';
import { EditableStageRow } from './EditableStageRow';

const DAY_W = 28;
const LEFT_PANEL_W = 900;

interface GanttChartProps {
  stages: ScheduleStage[];
  config: ScheduleConfig | null;
  holidays: ScheduleHoliday[];
  onPatchTask: (taskId: string, patch: TaskUpdatePatch, opts?: { immediate?: boolean }) => void;
  onDeleteTask: (taskId: string) => void;
  onRenameStage: (stageId: string, nome: string) => void;
  onDeleteStage: (stageId: string) => void;
}

export function GanttChart({
  stages,
  config,
  holidays,
  onPatchTask,
  onDeleteTask,
  onRenameStage,
  onDeleteStage,
}: GanttChartProps) {
  const ganttRef = useRef<HTMLDivElement>(null);
  const [collapsedStages, setCollapsedStages] = useState<Set<string>>(new Set());

  const { startDate, totalDays, days } = useMemo(() => {
    if (!config) return { startDate: new Date(), totalDays: 30, days: [] as Date[] };

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

    minDate = addDays(minDate, -2);
    maxDate = addDays(maxDate, 5);

    const total = daysBetween(minDate, maxDate) + 1;
    const allDays: Date[] = [];
    for (let i = 0; i < total; i++) allDays.push(addDays(minDate, i));

    return { startDate: minDate, totalDays: total, days: allDays };
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

  const today = new Date();

  const rows = useMemo(() => {
    const r: Array<{ type: 'stage' | 'task'; stage: ScheduleStage; task?: ScheduleTask }> = [];
    for (const stage of stages) {
      r.push({ type: 'stage', stage });
      if (!collapsedStages.has(stage.id)) {
        for (const task of stage.tasks) r.push({ type: 'task', stage, task });
      }
    }
    return r;
  }, [stages, collapsedStages]);

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
        {/* LEFT: Editable task table */}
        <div className="flex-shrink-0 border-r border-gray-300" style={{ width: LEFT_PANEL_W }}>
          <div
            className="flex bg-gray-100 border-b text-xs font-semibold text-gray-600 sticky top-0 z-10"
            style={{ height: 56 }}
          >
            <div className="w-8 px-1 flex items-end pb-1 text-center"></div>
            <div className="w-10 px-1 flex items-end pb-1">N°</div>
            <div className="flex-1 min-w-[320px] px-2 flex items-end pb-1">Tarefa</div>
            <div className="w-14 px-1 flex items-end pb-1 text-center">Dur</div>
            <div className="w-14 px-1 flex items-end pb-1 text-center">Pred</div>
            <div className="w-[104px] px-1 flex items-end pb-1">Início</div>
            <div className="w-[104px] px-1 flex items-end pb-1">Término</div>
            <div className="w-20 px-1 flex items-end pb-1 text-center">%</div>
            <div className="w-8 px-1 flex items-end pb-1"></div>
          </div>

          {rows.map((row) => {
            if (row.type === 'stage') {
              return (
                <EditableStageRow
                  key={`s-${row.stage.id}`}
                  stage={row.stage}
                  collapsed={collapsedStages.has(row.stage.id)}
                  onToggle={() => toggleStage(row.stage.id)}
                  onRename={(name) => onRenameStage(row.stage.id, name)}
                  onDelete={() => onDeleteStage(row.stage.id)}
                />
              );
            }
            return (
              <EditableTaskRow
                key={`t-${row.task!.id}`}
                task={row.task!}
                onPatch={onPatchTask}
                onDelete={onDeleteTask}
              />
            );
          })}
        </div>

        {/* RIGHT: Gantt bars */}
        <div className="flex-1 overflow-x-auto relative">
          <div style={{ minWidth: totalDays * DAY_W }}>
            <div className="flex bg-gray-100 border-b sticky top-0 z-10" style={{ height: 24 }}>
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

            <div className="flex border-b" style={{ height: 32 }}>
              {days.map((d, i) => {
                const isToday = isSameDay(d, today);
                const isWeekend = d.getDay() === 0 || d.getDay() === 6;
                const isHoliday = holidaySet.has(d.toDateString());
                return (
                  <div
                    key={i}
                    className={`flex flex-col items-center justify-center border-r text-[9px] leading-tight ${
                      isToday
                        ? 'bg-brand-100 font-bold'
                        : isHoliday
                        ? 'bg-red-50'
                        : isWeekend
                        ? 'bg-gray-50'
                        : ''
                    }`}
                    style={{ width: DAY_W }}
                  >
                    <span className={isWeekend ? 'text-gray-400' : 'text-gray-500'}>
                      {DAY_NAMES[d.getDay()]}
                    </span>
                    <span className={isToday ? 'text-brand-700' : 'text-gray-600'}>{d.getDate()}</span>
                  </div>
                );
              })}
            </div>

            {rows.map((row) => {
              if (row.type === 'stage') {
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
                  <div
                    key={`gs-${row.stage.id}`}
                    className="relative bg-gray-50 border-b"
                    style={{ height: ROW_H }}
                  >
                    <div className="absolute inset-0 flex">
                      {days.map((d, i) => (
                        <div
                          key={i}
                          className={`border-r ${
                            d.getDay() === 0 || d.getDay() === 6 ? 'bg-gray-100/50' : ''
                          }`}
                          style={{ width: DAY_W }}
                        />
                      ))}
                    </div>
                    {minStart && maxEnd && (
                      <div
                        className="absolute top-4 h-2 bg-gray-500 rounded-sm"
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
              const done = task.percentualConcluido >= 100;

              return (
                <div key={`gt-${task.id}`} className="relative border-b" style={{ height: ROW_H }}>
                  <div className="absolute inset-0 flex">
                    {days.map((d, i) => {
                      const isWeekend = d.getDay() === 0 || d.getDay() === 6;
                      const isHoliday = holidaySet.has(d.toDateString());
                      const isToday = isSameDay(d, today);
                      return (
                        <div
                          key={i}
                          className={`border-r ${
                            isToday
                              ? 'bg-brand-50/50'
                              : isHoliday
                              ? 'bg-red-50/30'
                              : isWeekend
                              ? 'bg-gray-50/50'
                              : ''
                          }`}
                          style={{ width: DAY_W }}
                        />
                      );
                    })}
                  </div>
                  {taskStart && taskEnd && (
                    <div
                      className="absolute top-3 rounded group cursor-pointer"
                      style={{
                        left: Math.max(0, daysBetween(startDate, taskStart)) * DAY_W + 2,
                        width: Math.max(1, daysBetween(taskStart, taskEnd) + 1) * DAY_W - 4,
                        height: ROW_H - 18,
                      }}
                    >
                      <div
                        className={`absolute inset-0 rounded opacity-80 ${
                          done ? 'bg-green-500' : 'bg-brand-400'
                        }`}
                      />
                      <div
                        className={`absolute inset-y-0 left-0 rounded-l ${
                          done ? 'bg-green-700' : 'bg-brand-600'
                        }`}
                        style={{
                          width: `${task.percentualConcluido}%`,
                          borderRadius:
                            task.percentualConcluido >= 100 ? '0.25rem' : '0.25rem 0 0 0.25rem',
                        }}
                      />
                      <div className="hidden group-hover:block absolute bottom-full left-0 mb-1 bg-gray-800 text-white text-[10px] px-2 py-1 rounded whitespace-nowrap z-50">
                        {task.nome} | {task.duracao}d | {task.percentualConcluido}%
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {days.some((d) => isSameDay(d, today)) && (
              <div
                className="absolute top-0 bottom-0 w-px bg-red-500 z-20 pointer-events-none"
                style={{ left: daysBetween(startDate, today) * DAY_W + DAY_W / 2 }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
