'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useProject } from '@/contexts/project-context';
import { api } from '@/lib/api';
import { Calendar, Loader2, Plus, Upload } from 'lucide-react';
import type { GanttData, ScheduleConfig, TaskUpdatePatch } from './_types';
import { recalcAll } from './_lib/recalc';
import { KPICards } from './_components/KPICards';
import { ConfigPanel } from './_components/ConfigPanel';
import { GanttChart } from './_components/GanttChart';
import { ImportModal } from './_components/ImportModal';
import { AddTaskModal } from './_components/AddTaskModal';
import { AddStageModal } from './_components/AddStageModal';
import { MobileGanttList } from './_components/MobileGanttList';

const SAVE_DEBOUNCE_MS = 300;

export default function SchedulePage() {
  const { projectId } = useProject();
  const [data, setData] = useState<GanttData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showAddTask, setShowAddTask] = useState(false);
  const [showAddStage, setShowAddStage] = useState(false);

  // Pending task patches keyed by task id; flushed in a single debounced cycle.
  const pendingRef = useRef<Map<string, TaskUpdatePatch>>(new Map());
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Number of in-flight save operations — when > 0, we skip refetch-driven state overwrites
  // so the user's typing isn't clobbered.
  const inflightRef = useRef(0);

  const loadData = useCallback(
    async (opts?: { silent?: boolean }) => {
      try {
        const gantt = await api.get<GanttData>(`/projects/${projectId}/schedule/gantt`);
        // Only overwrite local state when there are no pending edits in flight.
        if (inflightRef.current === 0 && pendingRef.current.size === 0) {
          setData(gantt);
        }
      } catch (e) {
        console.error('Failed to load schedule', e);
      } finally {
        if (!opts?.silent) setLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    loadData();
  }, [loadData]);

  const flushSaves = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const pending = pendingRef.current;
    if (pending.size === 0) return;
    const entries = Array.from(pending.entries());
    pendingRef.current = new Map();

    inflightRef.current += 1;
    setSaving(true);
    try {
      await Promise.all(
        entries.map(([id, patch]) =>
          api.patch(`/projects/${projectId}/schedule/tasks/${id}`, patch),
        ),
      );
    } catch (e) {
      console.error('Failed to save task patches', e);
    } finally {
      inflightRef.current -= 1;
      if (inflightRef.current === 0) setSaving(false);
      await loadData({ silent: true });
    }
  }, [projectId, loadData]);

  // Apply a local optimistic patch (instant UI feedback + recalc), then queue save.
  const onPatchTask = useCallback(
    (taskId: string, patch: TaskUpdatePatch, opts?: { immediate?: boolean }) => {
      setData((prev) => {
        if (!prev) return prev;
        const stages = prev.stages.map((s) => ({
          ...s,
          tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t)),
        }));
        return recalcAll({ ...prev, stages });
      });

      const existing = pendingRef.current.get(taskId) ?? {};
      pendingRef.current.set(taskId, { ...existing, ...patch });

      if (opts?.immediate) {
        flushSaves();
      } else {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
          flushSaves();
        }, SAVE_DEBOUNCE_MS);
      }
    },
    [flushSaves],
  );

  const onDeleteTask = useCallback(
    async (taskId: string) => {
      if (!confirm('Excluir esta tarefa?')) return;
      // Optimistic remove
      setData((prev) => {
        if (!prev) return prev;
        const stages = prev.stages.map((s) => ({
          ...s,
          tasks: s.tasks.filter((t) => t.id !== taskId),
        }));
        return recalcAll({ ...prev, stages });
      });
      try {
        await api.delete(`/projects/${projectId}/schedule/tasks/${taskId}`);
      } catch (e) {
        console.error('Failed to delete task', e);
      }
      loadData({ silent: true });
    },
    [projectId, loadData],
  );

  const onRenameStage = useCallback(
    async (stageId: string, nome: string) => {
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          stages: prev.stages.map((s) => (s.id === stageId ? { ...s, nome } : s)),
        };
      });
      try {
        await api.patch(`/projects/${projectId}/schedule/stages/${stageId}`, { nome });
      } catch (e) {
        console.error('Failed to rename stage', e);
      }
      loadData({ silent: true });
    },
    [projectId, loadData],
  );

  const onDeleteStage = useCallback(
    async (stageId: string) => {
      const stage = data?.stages.find((s) => s.id === stageId);
      if (!stage) return;
      const taskCount = stage.tasks.length;
      const msg =
        taskCount > 0
          ? `Excluir a etapa "${stage.nome}"? Suas ${taskCount} tarefas serão removidas.`
          : `Excluir a etapa "${stage.nome}"?`;
      if (!confirm(msg)) return;

      setData((prev) => {
        if (!prev) return prev;
        return { ...prev, stages: prev.stages.filter((s) => s.id !== stageId) };
      });
      try {
        // Soft-delete child tasks first so they don't linger orphaned in the UI.
        await Promise.all(
          stage.tasks.map((t) =>
            api.delete(`/projects/${projectId}/schedule/tasks/${t.id}`).catch(() => {}),
          ),
        );
        await api.delete(`/projects/${projectId}/schedule/stages/${stageId}`);
      } catch (e) {
        console.error('Failed to delete stage', e);
      }
      loadData({ silent: true });
    },
    [projectId, loadData, data],
  );

  const onSaveConfig = useCallback(
    async (cfg: Partial<ScheduleConfig>) => {
      await api.put(`/projects/${projectId}/schedule/config`, cfg);
      loadData({ silent: true });
    },
    [projectId, loadData],
  );

  // Flush any pending save when leaving the page.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        flushSaves();
      }
    };
  }, [flushSaves]);

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
      {/* Header desktop */}
      <div className="hidden md:flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
            Cronograma da Obra
            {saving && (
              <span className="flex items-center gap-1 text-xs font-medium text-gray-500">
                <Loader2 className="w-3 h-3 animate-spin" /> salvando…
              </span>
            )}
          </h1>
          <p className="text-sm text-gray-500">
            Edite tarefas inline — duração, datas, predecessoras e progresso recalculam automaticamente
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setShowAddStage(true)}
            className="flex items-center gap-1 border border-gray-300 px-3 py-1.5 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
          >
            <Plus className="w-4 h-4" /> Etapa
          </button>
          <button
            onClick={() => setShowAddTask(true)}
            disabled={!hasData}
            className="flex items-center gap-1 bg-brand-600 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
            title={!hasData ? 'Crie uma etapa primeiro' : 'Nova tarefa'}
          >
            <Plus className="w-4 h-4" /> Tarefa
          </button>
          <button
            onClick={() => setShowImport(true)}
            className="flex items-center gap-1 border border-gray-300 px-3 py-1.5 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
          >
            <Upload className="w-4 h-4" /> Importar
          </button>
        </div>
      </div>

      {/* Header mobile editorial */}
      <div className="md:hidden -mt-2">
        <p className="text-[11px] uppercase tracking-[0.2em] text-darc-raspberry/70">Obra</p>
        <h1 className="font-editorial italic text-3xl text-darc-velvet leading-tight flex items-center gap-2">
          Cronograma
          {saving && <Loader2 className="w-4 h-4 animate-spin text-darc-raspberry" />}
        </h1>
      </div>

      {/* KPIs */}
      {hasData && <KPICards kpis={data.kpis} config={data.config} />}

      {/* Config */}
      <ConfigPanel config={data.config} onSave={onSaveConfig} />

      {/* Gantt or empty state */}
      {hasData ? (
        <>
          {/* Desktop: gantt chart completo */}
          <div className="hidden md:block">
            <GanttChart
              stages={data.stages}
              config={data.config}
              holidays={data.holidays}
              onPatchTask={onPatchTask}
              onDeleteTask={onDeleteTask}
              onRenameStage={onRenameStage}
              onDeleteStage={onDeleteStage}
            />
          </div>

          {/* Mobile: lista de tarefas com checkbox + slider de progresso */}
          <MobileGanttList
            stages={data.stages}
            onPatchTask={onPatchTask}
            onDeleteTask={onDeleteTask}
          />
        </>
      ) : (
        <div className="flex flex-col items-center justify-center h-64 bg-white rounded-xl border-2 border-dashed border-gray-300">
          <Calendar className="w-12 h-12 text-gray-300 mb-3" />
          <p className="text-gray-500 mb-1">Nenhum cronograma configurado</p>
          <p className="text-sm text-gray-400 mb-4">
            Importe um modelo ou crie etapas e tarefas manualmente
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              onClick={() => setShowAddStage(true)}
              className="flex items-center gap-2 border border-gray-300 px-4 py-2 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
            >
              <Plus className="w-4 h-4" /> Criar Etapa
            </button>
            <button
              onClick={() => setShowAddTask(true)}
              disabled={!hasData}
              className="flex items-center gap-2 bg-brand-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
              title={!hasData ? 'Crie uma etapa primeiro' : 'Nova tarefa'}
            >
              <Plus className="w-4 h-4" /> Criar Tarefa
            </button>
            <button
              onClick={() => setShowImport(true)}
              className="flex items-center gap-2 border border-gray-300 px-4 py-2 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
            >
              <Upload className="w-4 h-4" /> Importar Modelo de Obra
            </button>
          </div>
          <p className="mt-2 text-xs text-gray-400">
            Depois da primeira etapa, a opção de criar tarefa fica disponível.
          </p>
        </div>
      )}

      {/* Modals */}
      {showImport && (
        <ImportModal
          projectId={projectId}
          onImported={() => {
            setShowImport(false);
            loadData({ silent: true });
          }}
          onClose={() => setShowImport(false)}
        />
      )}
      {showAddTask && hasData && (
        <AddTaskModal
          projectId={projectId}
          stages={data.stages}
          onCreated={() => {
            setShowAddTask(false);
            loadData({ silent: true });
          }}
          onClose={() => setShowAddTask(false)}
        />
      )}
      {showAddStage && (
        <AddStageModal
          projectId={projectId}
          stagesCount={data.stages.length}
          onCreated={() => {
            setShowAddStage(false);
            loadData({ silent: true });
          }}
          onClose={() => setShowAddStage(false)}
        />
      )}
      {/* FAB mobile — adicionar tarefa */}
      {hasData && (
        <button
          type="button"
          onClick={() => setShowAddTask(true)}
          aria-label="Nova tarefa"
          className="md:hidden fixed bottom-20 right-4 z-40 w-14 h-14 rounded-full bg-darc-red-bright text-white shadow-darc-med flex items-center justify-center hover:bg-darc-red-pastel active:scale-95 transition-all"
        >
          <Plus className="w-6 h-6" />
        </button>
      )}
    </div>
  );
}
