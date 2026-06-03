'use client';

import { useCallback, useRef, useState } from 'react';
import { AlertCircle, Check, CheckCircle2, Trash2 } from 'lucide-react';
import type { ScheduleTask, TaskUpdatePatch } from '../_types';
import {
  fmtDate,
  fromDateInputValue,
  parsePredecessoras,
  predecessorasDisplay,
  toDateInputValue,
} from '../_lib/format';

export const ROW_H = 52;

export function EditableTaskRow({
  task,
  onPatch,
  onDelete,
  compact = false,
}: {
  task: ScheduleTask;
  onPatch: (taskId: string, patch: TaskUpdatePatch, opts?: { immediate?: boolean }) => void;
  onDelete: (taskId: string) => void;
  compact?: boolean;
}) {
  const done = task.percentualConcluido >= 100;
  const hasPreds = parsePredecessoras(task.predecessoras).length > 0;

  // Local mirrors for text inputs so typing remains smooth even with debounced parent state.
  const [nome, setNome] = useState(task.nome);
  const [duracao, setDuracao] = useState<string>(String(task.duracao));
  const [predText, setPredText] = useState(predecessorasDisplay(task.predecessoras));
  const [pct, setPct] = useState<string>(String(task.percentualConcluido));

  // Sync local state when external value changes (e.g. after refetch).
  const lastSync = useRef<{
    nome: string;
    duracao: number;
    pred: string | null;
    pct: number;
  }>({
    nome: task.nome,
    duracao: task.duracao,
    pred: task.predecessoras,
    pct: task.percentualConcluido,
  });

  if (
    lastSync.current.nome !== task.nome ||
    lastSync.current.duracao !== task.duracao ||
    lastSync.current.pred !== task.predecessoras ||
    lastSync.current.pct !== task.percentualConcluido
  ) {
    lastSync.current = {
      nome: task.nome,
      duracao: task.duracao,
      pred: task.predecessoras,
      pct: task.percentualConcluido,
    };
    setNome(task.nome);
    setDuracao(String(task.duracao));
    setPredText(predecessorasDisplay(task.predecessoras));
    setPct(String(task.percentualConcluido));
  }

  const commitNome = useCallback(() => {
    const v = nome.trim();
    if (v && v !== task.nome) onPatch(task.id, { nome: v });
    else if (!v) setNome(task.nome);
  }, [nome, task.id, task.nome, onPatch]);

  const commitDuracao = useCallback(() => {
    const n = parseInt(duracao, 10);
    if (!Number.isFinite(n) || n < 1) {
      setDuracao(String(task.duracao));
      return;
    }
    if (n !== task.duracao) onPatch(task.id, { duracao: n });
  }, [duracao, task.id, task.duracao, onPatch]);

  const commitPred = useCallback(() => {
    const nums = predText
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n));
    const next = nums.length ? JSON.stringify(nums) : null;
    if (next !== task.predecessoras) onPatch(task.id, { predecessoras: next });
  }, [predText, task.id, task.predecessoras, onPatch]);

  const commitPct = useCallback(() => {
    let n = parseFloat(pct.replace(',', '.'));
    if (!Number.isFinite(n)) {
      setPct(String(task.percentualConcluido));
      return;
    }
    n = Math.max(0, Math.min(100, Math.round(n)));
    if (n !== task.percentualConcluido) onPatch(task.id, { percentualConcluido: n }, { immediate: true });
    else setPct(String(n));
  }, [pct, task.id, task.percentualConcluido, onPatch]);

  const toggleDone = () => {
    onPatch(task.id, { percentualConcluido: done ? 0 : 100 }, { immediate: true });
  };

  const onDateChange = (value: string) => {
    onPatch(task.id, { dataInicio: fromDateInputValue(value) }, { immediate: true });
  };

  return (
    <div
      className={`flex items-center border-b text-sm group ${
        done ? 'bg-green-50/40' : 'hover:bg-blue-50/40'
      }`}
      style={{ height: ROW_H }}
    >
      <button
        onClick={toggleDone}
        className={`w-8 flex justify-center transition ${
          done ? 'text-green-600' : 'text-gray-300 hover:text-brand-600'
        }`}
        title={done ? 'Marcar como pendente' : 'Marcar como concluída (100%)'}
      >
        {done ? <CheckCircle2 className="w-5 h-5" /> : <Check className="w-5 h-5" />}
      </button>

      <div className="w-10 px-1 text-xs text-gray-500 tabular-nums">{task.numero}</div>

      <div className="flex-1 min-w-[320px] px-2">
        <input
          value={nome}
          onChange={(e) => setNome(e.target.value)}
          onBlur={commitNome}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            else if (e.key === 'Escape') {
              setNome(task.nome);
              (e.target as HTMLInputElement).blur();
            }
          }}
          className={`w-full bg-transparent rounded px-2 py-1.5 text-[15px] outline-none border border-transparent hover:border-gray-200 focus:border-brand-400 focus:bg-white truncate ${
            done ? 'line-through text-gray-500' : 'text-gray-800'
          }`}
          title={nome}
        />
      </div>

      {!compact && (
        <>
          <div className="w-14 px-1">
            <input
              type="number"
              min={1}
              value={duracao}
              onChange={(e) => setDuracao(e.target.value)}
              onBlur={commitDuracao}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              className="w-full bg-transparent rounded px-1 py-1 text-xs text-center outline-none border border-transparent hover:border-gray-200 focus:border-brand-400 focus:bg-white tabular-nums"
            />
          </div>

          <div className="w-14 px-1">
            <input
              value={predText}
              onChange={(e) => setPredText(e.target.value)}
              onBlur={commitPred}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              className="w-full bg-transparent rounded px-1 py-1 text-xs text-center outline-none border border-transparent hover:border-gray-200 focus:border-brand-400 focus:bg-white"
              placeholder="-"
              title="Predecessoras (separadas por vírgula). Ex: 2,3"
            />
          </div>

          <div className="w-[104px] px-1 flex items-center gap-1">
            <input
              type="date"
              value={toDateInputValue(task.dataInicio)}
              disabled={hasPreds}
              onChange={(e) => onDateChange(e.target.value)}
              className={`w-full rounded px-1 py-1 text-xs outline-none border border-transparent ${
                hasPreds
                  ? 'text-gray-500 cursor-not-allowed bg-transparent'
                  : 'hover:border-gray-200 focus:border-brand-400 focus:bg-white text-gray-700'
              }`}
              title={hasPreds ? 'Data calculada a partir das predecessoras' : 'Data de início'}
            />
            {hasPreds && (
              <AlertCircle
                className="w-3 h-3 text-gray-300 flex-shrink-0"
                aria-label="Data calculada automaticamente"
              />
            )}
          </div>

          <div className="w-[104px] px-1 text-xs text-gray-600 tabular-nums">{fmtDate(task.dataTermino)}</div>
        </>
      )}

      <div className="w-20 px-1 flex items-center gap-1">
        <input
          type="number"
          min={0}
          max={100}
          step={5}
          value={pct}
          onChange={(e) => setPct(e.target.value)}
          onBlur={commitPct}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          className={`w-12 rounded px-1 py-1 text-xs text-center outline-none border border-transparent hover:border-gray-200 focus:border-brand-400 focus:bg-white tabular-nums ${
            done ? 'text-green-700 font-semibold' : 'text-gray-700'
          }`}
        />
        <span className="text-xs text-gray-400">%</span>
      </div>

      <button
        onClick={() => onDelete(task.id)}
        className="w-8 flex justify-center text-gray-300 opacity-0 group-hover:opacity-100 hover:text-red-500 transition"
        title="Excluir tarefa"
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  );
}
