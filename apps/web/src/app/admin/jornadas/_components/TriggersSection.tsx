'use client';

import { JOURNEY_SAFE_ACTIONS, JOURNEY_TRIGGER_TYPES, ProjectType, getJourneyScreenKeys } from '@reformaflow/domain';
import { Plus, Trash2 } from 'lucide-react';
import { TRIGGER_TYPE_LABELS, type EditorJourney, type EditorTrigger } from '../_types';

interface Props {
  journey: EditorJourney;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onPatch: (id: string, patch: Partial<EditorTrigger>) => void;
}

const SELECT =
  'mt-1 min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-card px-3 text-[13px]';

/** Seção "Quando começa": um ou mais gatilhos do catálogo (#338). Cada
 * jornada precisa de ao menos um — o botão remover fica desabilitado no
 * último para nunca salvar uma jornada sem forma de disparar. */
export function TriggersSection({ journey, onAdd, onRemove, onPatch }: Props) {
  const screenKeys = journey.targetProjectType
    ? getJourneyScreenKeys(journey.targetProjectType)
    : Array.from(new Set(Object.values(ProjectType).flatMap((type) => getJourneyScreenKeys(type))));

  return (
    <div className="mb-5 rounded-[14px] border border-lifeone-hairline bg-lifeone-surface p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[13px] font-bold text-lifeone-ink">Quando começa</h2>
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-[10px] border border-lifeone-hairline px-3 text-[12px] font-semibold text-lifeone-ink-2 hover:border-lifeone-blue hover:text-lifeone-blue"
        >
          <Plus className="h-3.5 w-3.5" /> Gatilho
        </button>
      </div>

      <div className="space-y-2" data-testid="journey-triggers">
        {journey.triggers.map((trigger, index) => (
          <div
            key={trigger.id}
            data-testid={`journey-trigger-${index}`}
            className="grid gap-2 rounded-[10px] border border-lifeone-hairline bg-lifeone-card p-2.5 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          >
            <label className="text-[12px] font-semibold text-lifeone-ink-2">
              Começa quando
              <select
                aria-label="Começa quando"
                value={trigger.type}
                onChange={(event) =>
                  onPatch(trigger.id, {
                    type: event.target.value as EditorTrigger['type'],
                    key: null,
                  })
                }
                className={SELECT}
              >
                {JOURNEY_TRIGGER_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {TRIGGER_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </label>

            {trigger.type === 'SCREEN_VISIT' && (
              <label className="text-[12px] font-semibold text-lifeone-ink-2">
                Tela
                <select
                  aria-label="Tela do gatilho"
                  value={trigger.key ?? ''}
                  onChange={(event) => onPatch(trigger.id, { key: event.target.value || null })}
                  className={SELECT}
                >
                  <option value="">Escolha a tela</option>
                  {screenKeys.map((slug) => (
                    <option key={slug} value={slug}>
                      {slug}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {trigger.type === 'ACTION' && (
              <label className="text-[12px] font-semibold text-lifeone-ink-2">
                Ação segura
                <select
                  aria-label="Ação do gatilho"
                  value={trigger.key ?? ''}
                  onChange={(event) => onPatch(trigger.id, { key: event.target.value || null })}
                  className={SELECT}
                >
                  <option value="">Escolha a ação</option>
                  {JOURNEY_SAFE_ACTIONS.map((action) => (
                    <option key={action} value={action}>
                      {action}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <button
              type="button"
              aria-label={`Remover gatilho ${index + 1}`}
              disabled={journey.triggers.length <= 1}
              onClick={() => onRemove(trigger.id)}
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-[10px] border border-lifeone-hairline text-lifeone-ink-3 hover:border-red-300 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
