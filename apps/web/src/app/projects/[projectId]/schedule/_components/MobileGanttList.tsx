'use client';
import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Check, Trash2 } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import type { ScheduleStage, TaskUpdatePatch } from '../_types';

interface Props {
  stages: ScheduleStage[];
  onPatchTask: (taskId: string, patch: TaskUpdatePatch, opts?: { immediate?: boolean }) => void;
  onDeleteTask: (taskId: string) => void;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
  } catch {
    return '—';
  }
}

function MobileGanttListImpl({ stages, onPatchTask, onDeleteTask }: Props) {
  const [collapsedStages, setCollapsedStages] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setCollapsedStages((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="md:hidden space-y-3">
      {stages.map((stage) => {
        const collapsed = collapsedStages.has(stage.id);
        const stageProgress =
          stage.tasks.length > 0
            ? Math.round(
                stage.tasks.reduce((s, t) => s + t.percentualConcluido, 0) / stage.tasks.length,
              )
            : 0;
        const stageOrcado = stage.tasks.reduce((s, t) => s + (t.valorOrcado ?? 0), 0);

        return (
          <div
            key={stage.id}
            className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen overflow-hidden"
          >
            <button
              type="button"
              onClick={() => toggle(stage.id)}
              className="w-full flex items-center justify-between px-4 py-3 bg-darc-pink-logo/40 active:bg-darc-pink-logo/70 transition-colors text-left"
            >
              <div className="flex items-center gap-2 min-w-0">
                {collapsed ? (
                  <ChevronRight className="w-4 h-4 text-darc-raspberry flex-shrink-0" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-darc-raspberry flex-shrink-0" />
                )}
                <span className="font-semibold uppercase tracking-[0.15em] text-[11px] text-darc-velvet truncate">
                  {stage.nome}
                </span>
                <span className="text-[10px] text-darc-raspberry/80 flex-shrink-0">
                  ({stage.tasks.length})
                </span>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="text-[10px] text-darc-velvet/60 tabular-nums">{stageProgress}%</span>
                {stageOrcado > 0 && (
                  <span className="text-sm font-bold text-darc-velvet tabular-nums">
                    {formatCurrency(stageOrcado / 100)}
                  </span>
                )}
              </div>
            </button>

            {!collapsed && (
              <div className="divide-y divide-darc-linen">
                {stage.tasks.map((task) => {
                  const done = task.percentualConcluido >= 100;
                  return (
                    <div key={task.id} className="px-4 py-3 active:bg-darc-linen/40 transition-colors">
                      <div className="flex items-start gap-3">
                        <button
                          type="button"
                          aria-label={done ? 'Reabrir tarefa' : 'Concluir tarefa'}
                          onClick={() =>
                            onPatchTask(
                              task.id,
                              { percentualConcluido: done ? 0 : 100 },
                              { immediate: true },
                            )
                          }
                          className={`mt-0.5 flex-shrink-0 w-6 h-6 rounded-full border-2 flex items-center justify-center transition-colors ${
                            done
                              ? 'bg-darc-raspberry border-darc-raspberry text-white'
                              : 'border-darc-linen hover:border-darc-red-pastel'
                          }`}
                        >
                          {done && <Check className="w-3.5 h-3.5" />}
                        </button>

                        <div className="min-w-0 flex-1">
                          <p
                            className={`font-medium leading-snug ${
                              done ? 'text-darc-velvet/50 line-through' : 'text-darc-velvet'
                            }`}
                          >
                            {task.numero}. {task.nome}
                          </p>
                          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-darc-velvet/60 tabular-nums">
                            <span>
                              {formatDate(task.dataInicio)} → {formatDate(task.dataTermino)}
                            </span>
                            <span>· {task.duracao}d</span>
                            {task.valorOrcado != null && task.valorOrcado > 0 && (
                              <span>· {formatCurrency(task.valorOrcado / 100)}</span>
                            )}
                          </div>

                          {/* Slider de progresso */}
                          <div className="mt-2 flex items-center gap-2">
                            <input
                              type="range"
                              min={0}
                              max={100}
                              step={5}
                              value={task.percentualConcluido}
                              onChange={(e) =>
                                onPatchTask(task.id, {
                                  percentualConcluido: Number(e.target.value),
                                })
                              }
                              onMouseUp={() => onPatchTask(task.id, {}, { immediate: true })}
                              onTouchEnd={() => onPatchTask(task.id, {}, { immediate: true })}
                              className="flex-1 accent-darc-red-bright"
                            />
                            <span className="text-[11px] font-semibold text-darc-velvet tabular-nums min-w-[36px] text-right">
                              {task.percentualConcluido}%
                            </span>
                          </div>
                        </div>

                        <button
                          type="button"
                          aria-label="Excluir tarefa"
                          onClick={() => onDeleteTask(task.id)}
                          className="p-1.5 rounded-full hover:bg-darc-red-bright/10 active:bg-darc-red-bright/20 flex-shrink-0"
                        >
                          <Trash2 className="w-4 h-4 text-darc-red" />
                        </button>
                      </div>
                    </div>
                  );
                })}

                {stage.tasks.length === 0 && (
                  <div className="px-4 py-6 text-center text-[12px] text-darc-velvet/50 italic">
                    Sem tarefas nesta etapa.
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {stages.length === 0 && (
        <div className="text-center text-darc-velvet/50 text-sm py-8 rounded-2xl bg-white shadow-darc-soft border border-darc-linen">
          Nenhuma etapa cadastrada.
        </div>
      )}
    </div>
  );
}

export const MobileGanttList = React.memo(MobileGanttListImpl);
