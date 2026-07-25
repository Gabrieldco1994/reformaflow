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
import { ChevronRight } from 'lucide-react';
import type { ResolvedJourneyStep } from '@reformaflow/domain';
import { StepScreenCard } from './StepScreenCard';

interface Props {
  steps: ResolvedJourneyStep[];
  onReorder: (activeKey: string, overKey: string) => void;
  onMove: (key: string, direction: -1 | 1) => void;
  onPatch: (key: string, patch: Partial<ResolvedJourneyStep>) => void;
}

/**
 * A trilha: as telinhas na ordem em que a pessoa as vê, ligadas por setas.
 * Arrastar reordena (mouse/toque via PointerSensor, teclado via KeyboardSensor)
 * e cada card ainda traz botões ←/→ — reordenar não pode depender de drag.
 */
export function JourneyTrack({ steps, onReorder, onMove, onPatch }: Props) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) onReorder(String(active.id), String(over.id));
  }

  return (
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
  );
}
