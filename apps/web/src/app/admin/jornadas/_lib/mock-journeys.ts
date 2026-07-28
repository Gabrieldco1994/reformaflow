import {
  JOURNEY_CATALOG,
  JOURNEY_TRIGGER_TYPES,
  resolveJourneySteps,
  type JourneyDefinition,
  type JourneyTriggerType,
} from "@reformaflow/domain";
import type { EditorJourney, JourneyDraftPatch } from "../_types";

const DEFAULT_START: JourneyTriggerType = JOURNEY_TRIGGER_TYPES[1];

function fromDefinition(definition: JourneyDefinition): EditorJourney {
  return {
    key: definition.key,
    name: definition.name,
    description: definition.description,
    steps: resolveJourneySteps(definition.steps),
    trigger: { ...definition.triggers[0] },
    startsWhen: DEFAULT_START,
  };
}

let journeys = Object.values(JOURNEY_CATALOG).map(fromDefinition);

function copy(journey: EditorJourney): EditorJourney {
  return {
    ...journey,
    trigger: { ...journey.trigger },
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
  journeys[index] = {
    ...journeys[index],
    ...patch,
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
  journeys = Object.values(JOURNEY_CATALOG).map(fromDefinition);
}
