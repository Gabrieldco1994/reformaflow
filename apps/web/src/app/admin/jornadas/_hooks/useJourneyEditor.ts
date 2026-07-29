"use client";

import { useCallback, useEffect, useState } from "react";
import type { JourneyStepDefinition, JourneyTriggerType } from "@reformaflow/domain";
import {
  createMockJourney,
  listMockJourneys,
  saveMockJourney,
} from "../_lib/mock-journeys";
import type { EditorJourney, EditorStep, EditorTrigger, JourneyDraftPatch } from "../_types";

function move<T>(list: T[], from: number, to: number) {
  if (from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

let triggerIdSeq = 0;
function nextTriggerId(): string {
  triggerIdSeq += 1;
  return `draft-trigger-${triggerIdSeq}`;
}

export function useJourneyEditor() {
  const [journeys, setJourneys] = useState<EditorJourney[]>([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    listMockJourneys()
      .then((loaded) => {
        setJourneys(loaded);
        setSelectedKey(loaded[0]?.key ?? "");
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason : new Error("Falha ao carregar jornadas.")),
      )
      .finally(() => setLoading(false));
  }, []);

  const selected = journeys.find((journey) => journey.key === selectedKey) ?? null;

  const updateSelected = useCallback(
    (patch: Partial<EditorJourney>) => {
      setJourneys((current) =>
        current.map((journey) => (journey.key === selectedKey ? { ...journey, ...patch } : journey)),
      );
      setDirty(true);
    },
    [selectedKey],
  );

  const patchStep = useCallback(
    (key: string, patch: Partial<EditorStep>) => {
      updateSelected({
        steps: selected?.steps.map((step) => (step.key === key ? { ...step, ...patch } : step)) ?? [],
      });
    },
    [selected, updateSelected],
  );

  const moveStep = useCallback(
    (key: string, direction: -1 | 1) => {
      if (!selected) return;
      const index = selected.steps.findIndex((step) => step.key === key);
      updateSelected({ steps: move(selected.steps, index, index + direction) });
    },
    [selected, updateSelected],
  );

  const reorder = useCallback(
    (activeKey: string, overKey: string) => {
      if (!selected) return;
      const from = selected.steps.findIndex((step) => step.key === activeKey);
      const to = selected.steps.findIndex((step) => step.key === overKey);
      updateSelected({ steps: move(selected.steps, from, to) });
    },
    [selected, updateSelected],
  );

  const addStep = useCallback(
    (definition: JourneyStepDefinition) => {
      if (!selected || selected.steps.some((step) => step.key === definition.key)) return;
      updateSelected({
        steps: [
          ...selected.steps,
          {
            key: definition.key,
            label: definition.label,
            subtitle: definition.defaultSubtitle,
            enabled: true,
            skippable: definition.skippableByDefault,
            alwaysAvailable: definition.alwaysAvailable,
            experience: "SUMMARY",
          },
        ],
      });
    },
    [selected, updateSelected],
  );

  const removeStep = useCallback(
    (key: string) => {
      if (!selected) return;
      updateSelected({ steps: selected.steps.filter((step) => step.key !== key) });
    },
    [selected, updateSelected],
  );

  const patchJourney = useCallback((patch: JourneyDraftPatch) => updateSelected(patch), [updateSelected]);

  const addTrigger = useCallback(
    (type: JourneyTriggerType = "SIGNUP_COMPLETED") => {
      if (!selected) return;
      const trigger: EditorTrigger = { id: nextTriggerId(), type, key: null };
      updateSelected({ triggers: [...selected.triggers, trigger] });
    },
    [selected, updateSelected],
  );

  const removeTrigger = useCallback(
    (id: string) => {
      if (!selected || selected.triggers.length <= 1) return;
      updateSelected({ triggers: selected.triggers.filter((trigger) => trigger.id !== id) });
    },
    [selected, updateSelected],
  );

  const patchTrigger = useCallback(
    (id: string, patch: Partial<EditorTrigger>) => {
      if (!selected) return;
      updateSelected({
        triggers: selected.triggers.map((trigger) =>
          trigger.id === id ? { ...trigger, ...patch } : trigger,
        ),
      });
    },
    [selected, updateSelected],
  );

  const save = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveMockJourney(selected.key, selected);
      setJourneys((current) => current.map((journey) => (journey.key === saved.key ? saved : journey)));
      setDirty(false);
    } catch (reason) {
      const nextError = reason instanceof Error ? reason : new Error("Não foi possível salvar a jornada.");
      setError(nextError);
      throw nextError;
    } finally {
      setSaving(false);
    }
  }, [selected]);

  const create = useCallback(async (name: string, templateKey: string) => {
    setError(null);
    try {
      const created = await createMockJourney(name, templateKey);
      setJourneys((current) => [...current, created]);
      setSelectedKey(created.key);
      setDirty(false);
    } catch (reason) {
      const nextError = reason instanceof Error ? reason : new Error("Não foi possível criar a jornada.");
      setError(nextError);
      throw nextError;
    }
  }, []);

  return {
    journeys,
    selected,
    selectedKey,
    select: (key: string) => {
      setSelectedKey(key);
      setDirty(false);
    },
    patchJourney,
    patchStep,
    moveStep,
    reorder,
    addStep,
    removeStep,
    addTrigger,
    removeTrigger,
    patchTrigger,
    save,
    create,
    loading,
    saving,
    dirty,
    error,
  };
}
