'use client';

import { Fragment, useState } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { ChevronRight, Plus } from 'lucide-react';
import type { JourneyStepDefinition } from '@reformaflow/domain';
import type { EditorStep } from '../_types';
import { StepScreenCard } from './StepScreenCard';

interface Props {
  steps: EditorStep[];
  availableSteps: JourneyStepDefinition[];
  onReorder: (activeKey: string, overKey: string) => void;
  onMove: (key: string, direction: -1 | 1) => void;
  onPatch: (key: string, patch: Partial<EditorStep>) => void;
  onAddStep: (definition: JourneyStepDefinition) => void;
  onRemoveStep: (key: string) => void;
}

/**
 * A trilha: as telinhas na ordem em que a pessoa as vê, ligadas por setas.
 * Arrastar reordena (mouse/toque via PointerSensor, teclado via KeyboardSensor)
 * e cada card ainda traz botões ←/→ — reordenar não pode depender de drag.
 */
export function JourneyTrack({
  steps,
  availableSteps,
  onReorder,
  onMove,
  onPatch,
  onAddStep,
  onRemoveStep,
}: Props) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const usedKeys = new Set(steps.map((step) => step.key));
  const candidates = availableSteps.filter((step) => !usedKeys.has(step.key));
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) onReorder(String(active.id), String(over.id));
  }

  return (
    <div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext
          items={steps.map((step) => step.key)}
          strategy={horizontalListSortingStrategy}
        >
          <ol
            data-testid="journey-track"
            className="flex items-start gap-1 overflow-x-auto pb-4 pt-1"
          >
            {steps.map((step, index) => (
              <Fragment key={step.key}>
                <StepScreenCard
                  step={step}
                  position={index + 1}
                  total={steps.length}
                  editing={editingKey === step.key}
                  onToggleEditing={() =>
                    setEditingKey((current) => (current === step.key ? null : step.key))
                  }
                  onMove={(direction) => onMove(step.key, direction)}
                  onPatch={(patch) => onPatch(step.key, patch)}
                  onRemove={() => onRemoveStep(step.key)}
                />
                {index < steps.length - 1 && (
                  <li aria-hidden className="mt-24 shrink-0 px-0.5 text-lifeone-ink-4">
                    <ChevronRight className="h-5 w-5" />
                  </li>
                )}
              </Fragment>
            ))}
          </ol>
        </SortableContext>
      </DndContext>

      {candidates.length > 0 && (
        <label className="mt-2 block max-w-xs text-[12px] font-semibold text-lifeone-ink-2">
          Adicionar tela à trilha
          <select
            aria-label="Adicionar tela à trilha"
            value=""
            onChange={(event) => {
              const definition = candidates.find((step) => step.key === event.target.value);
              if (definition) onAddStep(definition);
            }}
            className="mt-1 min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3 text-[13px]"
          >
            <option value="">Escolha uma tela do catálogo…</option>
            {candidates.map((step) => (
              <option key={step.key} value={step.key}>
                {step.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {steps.length === 0 && (
        <p className="mt-1 flex items-center gap-1.5 text-[12px] text-lifeone-ink-3">
          <Plus className="h-3.5 w-3.5" /> Nenhuma tela na trilha ainda — a jornada só dispara os
          gatilhos, sem etapas.
        </p>
      )}
    </div>
  );
}
