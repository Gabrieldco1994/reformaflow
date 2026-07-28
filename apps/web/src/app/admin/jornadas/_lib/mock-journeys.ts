import {
  JOURNEY_CATALOG,
  resolveJourneySteps,
  type JourneyDefinition,
  type JourneyStepDefinition,
} from "@reformaflow/domain";
import type { EditorJourney, EditorStep, EditorTrigger, JourneyDraftPatch } from "../_types";

/**
 * Seam local para o editor de Jornadas. A API real (#339 — `admin/journeys`)
 * ainda é RED (apps/api/src/journeys/*.spec.ts sem implementação); este
 * módulo simula list/get/create/update em memória com a MESMA forma de
 * `EditorJourney`, para o editor poder ser construído e testado sem
 * bloquear no backend. Trocar por chamadas reais de `@/lib/api` deve exigir
 * mudar só este arquivo — os componentes e o hook não conhecem o mock.
 */

let idSeq = 0;
function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
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

function toEditorSteps(definition: JourneyDefinition): EditorStep[] {
  return resolveJourneySteps(definition.steps).map((step) => ({
    ...step,
    experience: "SUMMARY",
  }));
}

function toEditorTriggers(definition: JourneyDefinition): EditorTrigger[] {
  // Onboarding legado sempre nasce com um único gatilho (criação de
  // projeto do tipo alvo) — jornadas novas partem daqui e ganham mais
  // gatilhos pelo editor.
  return [{ id: nextId("trigger"), type: "PROJECT_CREATED", key: null }];
}

function fromDefinition(definition: JourneyDefinition): EditorJourney {
  const trigger = definition.triggers[0];
  return {
    key: definition.key,
    name: definition.name,
    description: definition.description,
    active: true,
    targetScope: trigger?.targetProjectType ? "PROJECT_TYPE" : "ALL_PROJECTS",
    targetProjectType: trigger?.targetProjectType ?? null,
    targetProjectId: trigger?.targetProjectId ?? null,
    device: "BOTH",
    allowCrossProjectNavigation: trigger?.crossProject ?? false,
    repeatPolicy: "ONCE_PER_USER",
    dismissPolicy: "DISMISS_UNTIL_LOGIN",
    triggers: toEditorTriggers(definition),
    steps: toEditorSteps(definition),
  };
}

let journeys = Object.values(JOURNEY_CATALOG).map(fromDefinition);

function copy(journey: EditorJourney): EditorJourney {
  return {
    ...journey,
    triggers: journey.triggers.map((trigger) => ({ ...trigger })),
    steps: journey.steps.map((step) => ({ ...step })),
  };
}

export async function listMockJourneys(): Promise<EditorJourney[]> {
  return journeys.map(copy);
}

export async function saveMockJourney(
  key: string,
  patch: JourneyDraftPatch & { steps: EditorJourney["steps"] },
): Promise<EditorJourney> {
  const index = journeys.findIndex((journey) => journey.key === key);
  if (index < 0) throw new Error("Jornada não encontrada.");
  if (patch.triggers && patch.triggers.length === 0) {
    throw new Error("A jornada precisa de pelo menos um gatilho.");
  }
  journeys[index] = {
    ...journeys[index],
    ...patch,
    triggers: (patch.triggers ?? journeys[index].triggers).map((trigger) => ({
      ...trigger,
    })),
    steps: patch.steps.map((step) => ({ ...step })),
  };
  return copy(journeys[index]);
}

export async function createMockJourney(
  name: string,
  templateKey: string,
): Promise<EditorJourney> {
  const template = journeys.find((journey) => journey.key === templateKey);
  if (!template) throw new Error("Template de jornada não encontrado.");
  const key = `custom:${name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`;
  const journey = copy({ ...template, key, name: name.trim() });
  journeys = [...journeys, journey];
  return copy(journey);
}

export function resetMockJourneys() {
  idSeq = 0;
  journeys = Object.values(JOURNEY_CATALOG).map(fromDefinition);
}
