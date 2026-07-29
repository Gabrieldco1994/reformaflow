import {
  JOURNEY_CATALOG,
  type JourneyStepDefinition,
  type JourneyRepeatPolicy,
  type JourneyStepExperience,
  type JourneyTriggerType,
  type ProjectType,
} from "@reformaflow/domain";
import { api } from "@/lib/api";
import type {
  EditorDevice,
  EditorDismissPolicy,
  EditorJourney,
  EditorStep,
  EditorTrigger,
  JourneyDraftPatch,
} from "../_types";

/**
 * Cliente de `admin/journeys`. O editor modela device/alvo/políticas no nível
 * da JORNADA, enquanto a API os desnormaliza por GATILHO; a tradução entre os
 * dois formatos mora só aqui (`toApiShape`/`fromApiShape`), sem espalhar a
 * decisão pelos componentes.
 */

interface ApiStep {
  id: string;
  stepKey: string;
  order: number;
  experience: string;
  label: string;
  subtitle: string | null;
  enabled: boolean;
  skippable: boolean;
}

interface ApiTrigger {
  id: string;
  triggerType: string;
  targetProjectType: string | null;
  targetProjectId: string | null;
  crossProject: boolean;
  screenKey: string | null;
  actionKey: string | null;
  device: string;
  repeatPolicy: string;
  dismissPolicy: string;
  active: boolean;
}

interface ApiJourney {
  id: string;
  key: string;
  name: string;
  description: string | null;
  active: boolean;
  steps: ApiStep[];
  triggers: ApiTrigger[];
}

/** Catálogo de passos disponíveis para adicionar à trilha — flatten de
 * `JOURNEY_CATALOG` (nunca inventado à mão), deduplicado por `key`. */
const STEP_CATALOG: Record<string, JourneyStepDefinition> = Object.values(JOURNEY_CATALOG).reduce(
  (acc, journey) => {
    for (const step of journey.steps) {
      if (!acc[step.key]) acc[step.key] = step;
    }
    return acc;
  },
  {} as Record<string, JourneyStepDefinition>,
);

export function listStepCatalog(): JourneyStepDefinition[] {
  return Object.values(STEP_CATALOG);
}

const DEVICE_TO_API: Record<EditorDevice, string> = {
  BOTH: "any",
  DESKTOP: "web",
  MOBILE: "mobile",
};

const DEVICE_FROM_API: Record<string, EditorDevice> = {
  any: "BOTH",
  web: "DESKTOP",
  mobile: "MOBILE",
};

/** A chave do gatilho vive em `screenKey` ou `actionKey` conforme o tipo — o
 * editor guarda as duas no mesmo campo `key`. */
function triggerKeyFields(type: JourneyTriggerType, key: string | null) {
  return {
    screenKey: type === "SCREEN_VISIT" ? key : null,
    actionKey: type === "ACTION" ? key : null,
  };
}

function fromApiSteps(steps: ApiStep[]): EditorStep[] {
  return [...steps]
    .sort((a, b) => a.order - b.order)
    .map((step) => ({
      key: step.stepKey,
      label: step.label,
      subtitle: step.subtitle ?? "",
      enabled: step.enabled,
      skippable: step.skippable,
      // A API não persiste `alwaysAvailable` (é característica do catálogo,
      // não override do admin) — reidrata do domínio.
      alwaysAvailable: STEP_CATALOG[step.stepKey]?.alwaysAvailable ?? true,
      experience: step.experience as JourneyStepExperience,
    }));
}

function fromApiTriggers(triggers: ApiTrigger[]): EditorTrigger[] {
  return triggers.map((trigger) => ({
    id: trigger.id,
    type: trigger.triggerType as JourneyTriggerType,
    key: trigger.screenKey ?? trigger.actionKey ?? null,
  }));
}

export function fromApiShape(journey: ApiJourney): EditorJourney {
  // Os campos de alvo/política são iguais em todos os gatilhos de uma jornada
  // (o editor os edita no nível da jornada); o primeiro define o estado da tela.
  const first = journey.triggers[0];
  const targetProjectType = (first?.targetProjectType as ProjectType | null) ?? null;
  const targetProjectId = first?.targetProjectId ?? null;
  return {
    id: journey.id,
    key: journey.key,
    name: journey.name,
    description: journey.description ?? "",
    active: journey.active,
    targetScope: targetProjectId ? "PROJECT" : targetProjectType ? "PROJECT_TYPE" : "ALL_PROJECTS",
    targetProjectType,
    targetProjectId,
    device: DEVICE_FROM_API[first?.device ?? "any"] ?? "BOTH",
    allowCrossProjectNavigation: first?.crossProject ?? false,
    repeatPolicy: (first?.repeatPolicy as JourneyRepeatPolicy) ?? "ONCE_PER_USER",
    dismissPolicy: (first?.dismissPolicy as EditorDismissPolicy) ?? "DISMISS_UNTIL_LOGIN",
    triggers: fromApiTriggers(journey.triggers),
    steps: fromApiSteps(journey.steps),
  };
}

export function toApiShape(journey: EditorJourney) {
  const scoped = journey.targetScope;
  return {
    name: journey.name,
    description: journey.description || null,
    active: journey.active,
    steps: journey.steps.map((step, index) => ({
      stepKey: step.key,
      order: index,
      // `label` é obrigatório no serviço: cai para o rótulo do catálogo em vez
      // de mandar vazio e tomar 400.
      label: step.label || STEP_CATALOG[step.key]?.label || step.key,
      subtitle: step.subtitle || null,
      enabled: step.enabled,
      skippable: step.skippable,
      experience: step.experience,
    })),
    triggers: journey.triggers.map((trigger) => ({
      triggerType: trigger.type,
      ...triggerKeyFields(trigger.type, trigger.key),
      targetProjectType: scoped === "ALL_PROJECTS" ? null : journey.targetProjectType,
      targetProjectId: scoped === "PROJECT" ? journey.targetProjectId : null,
      crossProject: journey.allowCrossProjectNavigation,
      device: DEVICE_TO_API[journey.device],
      repeatPolicy: journey.repeatPolicy,
      dismissPolicy: journey.dismissPolicy,
      active: true,
    })),
  };
}

export async function listJourneys(): Promise<EditorJourney[]> {
  const data = await api.get<ApiJourney[]>("/admin/journeys");
  return data.map(fromApiShape);
}

export async function saveJourney(
  journey: EditorJourney,
  patch: JourneyDraftPatch & { steps: EditorJourney["steps"] },
): Promise<EditorJourney> {
  const merged: EditorJourney = { ...journey, ...patch, steps: patch.steps };
  if (merged.triggers.length === 0) {
    throw new Error("A jornada precisa de pelo menos um gatilho.");
  }
  const saved = await api.put<ApiJourney>(`/admin/journeys/${journey.id}`, toApiShape(merged));
  return fromApiShape(saved);
}

export async function createJourney(name: string, template: EditorJourney): Promise<EditorJourney> {
  const trimmed = name.trim();
  const key = `custom:${trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`;
  const created = await api.post<ApiJourney>("/admin/journeys", {
    key,
    ...toApiShape({ ...template, name: trimmed }),
  });
  return fromApiShape(created);
}
