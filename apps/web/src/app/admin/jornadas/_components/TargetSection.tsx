'use client';

import { JOURNEY_REPEAT_POLICIES, ProjectType } from '@reformaflow/domain';
import {
  DEVICE_LABELS,
  DEVICE_OPTIONS,
  DISMISS_POLICY_LABELS,
  DISMISS_POLICY_OPTIONS,
  PROJECT_TYPE_LABELS,
  REPEAT_POLICY_LABELS,
  TARGET_SCOPE_LABELS,
  TARGET_SCOPE_OPTIONS,
  type EditorJourney,
  type JourneyDraftPatch,
} from '../_types';
import { useProjectOptions } from '../_hooks/useProjectOptions';

interface Props {
  journey: EditorJourney;
  onPatch: (patch: JourneyDraftPatch) => void;
}

const TYPES = Object.values(ProjectType);
const FIELD = 'text-[12px] font-semibold text-lifeone-ink-2';
const SELECT =
  'mt-1 min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-card px-3 text-[13px]';

/** Seção "Onde aparece": escopo do alvo, dispositivo, cross-project e o
 * alvo concreto (tipo ou projeto específico) conforme o escopo escolhido. */
export function TargetSection({ journey, onPatch }: Props) {
  const { projects, loading } = useProjectOptions();

  return (
    <div className="mb-5 rounded-[14px] border border-lifeone-hairline bg-lifeone-surface p-3">
      <h2 className="mb-2 text-[13px] font-bold text-lifeone-ink">Onde aparece</h2>
      <div className="grid gap-3 md:grid-cols-2">
        <label className={FIELD}>
          Escopo do alvo
          <select
            aria-label="Escopo do alvo"
            value={journey.targetScope}
            onChange={(event) => {
              const targetScope = event.target.value as EditorJourney['targetScope'];
              onPatch({
                targetScope,
                targetProjectType: targetScope === 'ALL_PROJECTS' ? null : journey.targetProjectType,
                targetProjectId: targetScope === 'PROJECT' ? journey.targetProjectId : null,
              });
            }}
            className={SELECT}
          >
            {TARGET_SCOPE_OPTIONS.map((scope) => (
              <option key={scope} value={scope}>
                {TARGET_SCOPE_LABELS[scope]}
              </option>
            ))}
          </select>
        </label>

        {journey.targetScope !== 'ALL_PROJECTS' && (
          <label className={FIELD}>
            Tipo de projeto
            <select
              aria-label="Onde aparece"
              value={journey.targetProjectType ?? ''}
              onChange={(event) =>
                onPatch({ targetProjectType: (event.target.value || null) as ProjectType | null })
              }
              className={SELECT}
            >
              <option value="">Escolha o tipo</option>
              {TYPES.map((type) => (
                <option key={type} value={type}>
                  {PROJECT_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </label>
        )}

        {journey.targetScope === 'PROJECT' && (
          <label className={FIELD}>
            Projeto específico
            <select
              aria-label="Projeto específico"
              value={journey.targetProjectId ?? ''}
              onChange={(event) => onPatch({ targetProjectId: event.target.value || null })}
              className={SELECT}
              disabled={loading}
            >
              <option value="">{loading ? 'Carregando…' : 'Escolha o projeto'}</option>
              {projects
                .filter((project) => !journey.targetProjectType || project.type === journey.targetProjectType)
                .map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
            </select>
          </label>
        )}

        <label className={FIELD}>
          Dispositivo
          <select
            aria-label="Dispositivo"
            value={journey.device}
            onChange={(event) => onPatch({ device: event.target.value as EditorJourney['device'] })}
            className={SELECT}
          >
            {DEVICE_OPTIONS.map((device) => (
              <option key={device} value={device}>
                {DEVICE_LABELS[device]}
              </option>
            ))}
          </select>
        </label>

        <label className={FIELD}>
          Repetição
          <select
            aria-label="Repetição"
            value={journey.repeatPolicy}
            onChange={(event) =>
              onPatch({ repeatPolicy: event.target.value as EditorJourney['repeatPolicy'] })
            }
            className={SELECT}
          >
            {JOURNEY_REPEAT_POLICIES.map((policy) => (
              <option key={policy} value={policy}>
                {REPEAT_POLICY_LABELS[policy]}
              </option>
            ))}
          </select>
        </label>

        <label className={FIELD}>
          Ao fechar antes de concluir
          <select
            aria-label="Ao fechar antes de concluir"
            value={journey.dismissPolicy}
            onChange={(event) =>
              onPatch({ dismissPolicy: event.target.value as EditorJourney['dismissPolicy'] })
            }
            className={SELECT}
          >
            {DISMISS_POLICY_OPTIONS.map((policy) => (
              <option key={policy} value={policy}>
                {DISMISS_POLICY_LABELS[policy]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex min-h-11 items-center gap-2 text-[12px] font-semibold text-lifeone-ink-2">
          <input
            type="checkbox"
            checked={journey.allowCrossProjectNavigation}
            onChange={(event) => onPatch({ allowCrossProjectNavigation: event.target.checked })}
            className="h-4 w-4"
          />
          Pode atravessar projetos
        </label>

        <label className="flex min-h-11 items-center gap-2 text-[12px] font-semibold text-lifeone-ink-2">
          <input
            type="checkbox"
            checked={journey.active}
            onChange={(event) => onPatch({ active: event.target.checked })}
            className="h-4 w-4"
          />
          Jornada ativa
        </label>
      </div>
    </div>
  );
}
