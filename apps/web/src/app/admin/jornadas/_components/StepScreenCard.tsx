'use client';

import { useId } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ChevronLeft,
  ChevronRight,
  GripVertical,
  Lock,
  Maximize2,
  Minimize2,
  Pencil,
  Power,
  Sparkles,
  Trash2,
  Unlock,
} from 'lucide-react';
import { hasJourneyStepSlug } from '@reformaflow/domain';
import type { EditorStep } from '../_types';

interface Props {
  step: EditorStep;
  /** Posição na trilha (1-based) — é o número impresso na telinha. */
  position: number;
  total: number;
  editing: boolean;
  onToggleEditing: () => void;
  onMove: (direction: -1 | 1) => void;
  onPatch: (patch: Partial<EditorStep>) => void;
  onRemove: () => void;
}

const CHIP = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold';
const ACTION =
  'inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-[10px] border border-lifeone-hairline bg-lifeone-card px-2 text-[12px] font-medium text-lifeone-ink-2 transition-colors hover:border-lifeone-blue hover:text-lifeone-blue disabled:cursor-not-allowed disabled:opacity-40';

/**
 * Uma tela da jornada desenhada como uma "telinha de celular": dá pra bater o
 * olho na trilha e ver o que a pessoa vê, na ordem em que vê. Desligada, a
 * telinha fica tracejada e apagada — claramente fora do fluxo.
 */
export function StepScreenCard({
  step,
  position,
  total,
  editing,
  onToggleEditing,
  onMove,
  onPatch,
  onRemove,
}: Props) {
  const fieldId = useId();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: step.key,
  });

  const off = !step.enabled;

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
      }}
      data-testid={`journey-card-${step.key}`}
      className="w-[240px] shrink-0"
    >
      <div
        className={`rounded-[26px] border-2 p-3 shadow-lifeone-card transition-colors ${
          off
            ? 'border-dashed border-lifeone-hairline bg-lifeone-sidebar'
            : 'border-lifeone-ink bg-lifeone-card'
        }`}
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <span
            className={`flex h-7 w-7 items-center justify-center rounded-full text-[12px] font-bold ${
              off ? 'bg-lifeone-hairline text-lifeone-ink-3' : 'bg-lifeone-blue text-white'
            }`}
          >
            {position}
          </span>
          <button
            type="button"
            aria-label={`Arrastar "${step.label}"`}
            className="flex min-h-11 min-w-11 cursor-grab items-center justify-center rounded-[10px] text-lifeone-ink-3 active:cursor-grabbing"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-4 w-4" />
          </button>
        </div>

        {/* Mini-tela: o que a pessoa vê no onboarding. */}
        <div
          className={`rounded-[18px] border border-lifeone-hairline-2 bg-lifeone-surface p-3 ${
            off ? 'opacity-50' : ''
          }`}
        >
          <span className="mx-auto mb-2 block h-1 w-10 rounded-full bg-lifeone-hairline" />
          <h3
            data-testid="journey-step-label"
            className="text-[15px] font-bold leading-snug text-lifeone-ink"
          >
            {step.label}
          </h3>
          <p
            data-testid="journey-step-subtitle"
            className="mt-1 text-[12px] leading-snug text-lifeone-ink-2"
          >
            {step.subtitle}
          </p>
          <div className="mt-3 h-7 rounded-[8px] bg-lifeone-blue/15" />
          <div className="mt-1.5 h-7 rounded-[8px] bg-lifeone-hairline-3" />
        </div>

        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {off && (
            <span className={`${CHIP} bg-lifeone-hairline text-lifeone-ink-2`}>
              Fora da jornada
            </span>
          )}
          <span
            className={`${CHIP} ${
              step.skippable
                ? 'bg-lifeone-info text-lifeone-ink-2'
                : 'bg-lifeone-blue/10 text-lifeone-blue'
            }`}
          >
            {step.skippable ? (
              <>
                <Unlock className="h-3 w-3" /> Pulável
              </>
            ) : (
              <>
                <Lock className="h-3 w-3" /> Obrigatória
              </>
            )}
          </span>
          {!step.alwaysAvailable && (
            <span className={`${CHIP} bg-[#FBEBDC] text-[#B5803A]`}>
              <Sparkles className="h-3 w-3" /> Condicional
            </span>
          )}
          <span
            className={`${CHIP} ${
              step.experience === 'FULL'
                ? 'bg-lifeone-blue/10 text-lifeone-blue'
                : 'bg-lifeone-info text-lifeone-ink-2'
            }`}
          >
            {step.experience === 'FULL' ? 'Completa' : 'Resumida'}
          </span>
        </div>

        {!step.alwaysAvailable && (
          <p className="mt-1.5 text-[11px] leading-snug text-lifeone-ink-3">
            Só aparece quando o wizard tem contexto pra ela — ligar aqui não burla essa condição.
          </p>
        )}

        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <button
            type="button"
            className={ACTION}
            aria-label={`Mover "${step.label}" para antes`}
            disabled={position === 1}
            onClick={() => onMove(-1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={ACTION}
            aria-label={`Mover "${step.label}" para depois`}
            disabled={position === total}
            onClick={() => onMove(1)}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={ACTION}
            aria-label={`${step.enabled ? 'Desligar' : 'Ligar'} "${step.label}"`}
            aria-pressed={step.enabled}
            onClick={() => onPatch({ enabled: !step.enabled })}
          >
            <Power className="h-4 w-4" /> {step.enabled ? 'Ligada' : 'Desligada'}
          </button>
          <button
            type="button"
            className={ACTION}
            aria-label={`Tornar "${step.label}" ${step.skippable ? 'obrigatória' : 'pulável'}`}
            onClick={() => onPatch({ skippable: !step.skippable })}
          >
            {step.skippable ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
          </button>
          <button
            type="button"
            className={ACTION}
            aria-label={`Editar textos de "${step.label}"`}
            aria-expanded={editing}
            onClick={onToggleEditing}
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={ACTION}
            aria-label={`Tornar "${step.label}" ${step.experience === 'FULL' ? 'resumida' : 'completa'}`}
            disabled={!hasJourneyStepSlug(step.key)}
            title={!hasJourneyStepSlug(step.key) ? 'Este passo não tem tela própria' : undefined}
            onClick={() => onPatch({ experience: step.experience === 'FULL' ? 'SUMMARY' : 'FULL' })}
          >
            {step.experience === 'FULL' ? (
              <Minimize2 className="h-4 w-4" />
            ) : (
              <Maximize2 className="h-4 w-4" />
            )}
          </button>
          <button
            type="button"
            className={ACTION}
            aria-label={`Remover "${step.label}" da trilha`}
            onClick={onRemove}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>

        {editing && (
          <div className="mt-2.5 space-y-2 rounded-[12px] border border-lifeone-hairline bg-lifeone-surface p-2.5">
            <div>
              <label
                htmlFor={`${fieldId}-label`}
                className="mb-1 block text-[12px] font-medium text-lifeone-ink-2"
              >
                Rótulo curto
              </label>
              <input
                id={`${fieldId}-label`}
                value={step.label}
                onChange={(e) => onPatch({ label: e.target.value })}
                className="min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-card px-3 text-[13px]"
              />
            </div>
            <div>
              <label
                htmlFor={`${fieldId}-subtitle`}
                className="mb-1 block text-[12px] font-medium text-lifeone-ink-2"
              >
                Texto de apoio
              </label>
              <textarea
                id={`${fieldId}-subtitle`}
                value={step.subtitle}
                rows={3}
                onChange={(e) => onPatch({ subtitle: e.target.value })}
                className="w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-card p-2.5 text-[13px]"
              />
            </div>
          </div>
        )}
      </div>
    </li>
  );
}
