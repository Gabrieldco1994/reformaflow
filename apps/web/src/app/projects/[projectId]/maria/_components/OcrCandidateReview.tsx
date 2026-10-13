"use client";

import { useEffect, useRef, useState } from "react";
import type {
  OcrCandidateStatus,
  OcrCandidateView,
  OcrPreparedCandidate,
} from "../_types";

const OCR_STATUS_LABEL: Record<OcrCandidateStatus, string> = {
  UNVERIFIED: "NÃO VERIFICADO",
};

interface CandidateDraft {
  values: Record<string, string>;
  confirmed: Set<string>;
  attested: boolean;
  selected: boolean;
}

function initialDraft(candidate: OcrCandidateView): CandidateDraft {
  return {
    values: Object.fromEntries(
      candidate.fields.map((field) => [field.key, field.value]),
    ),
    confirmed: new Set(),
    attested: false,
    selected: false,
  };
}

export function OcrCandidateReview({
  candidates,
  onPrepare,
}: {
  candidates: readonly OcrCandidateView[];
  onPrepare?: (candidates: readonly OcrPreparedCandidate[]) => void;
}) {
  const fieldRefs = useRef(new Map<string, HTMLInputElement>());
  const [drafts, setDrafts] = useState<Record<string, CandidateDraft>>(() =>
    Object.fromEntries(
      candidates.map((candidate) => [candidate.ref, initialDraft(candidate)]),
    ),
  );

  useEffect(() => {
    const first = candidates
      .flatMap((candidate) =>
        candidate.fields.map((field) => `${candidate.ref}:${field.key}`),
      )
      .find(Boolean);
    if (!first) return;
    queueMicrotask(() => fieldRefs.current.get(first)?.focus());
  }, [candidates]);

  const selected = candidates.filter(
    (candidate) => drafts[candidate.ref]?.selected,
  );
  const canPrepare =
    selected.length > 0 &&
    selected.every((candidate) => drafts[candidate.ref]?.attested);

  function changeField(
    candidate: OcrCandidateView,
    fieldKey: string,
    value: string,
  ) {
    setDrafts((current) => {
      const previous = current[candidate.ref] ?? initialDraft(candidate);
      const confirmed = new Set(previous.confirmed);
      confirmed.delete(fieldKey);
      return {
        ...current,
        [candidate.ref]: {
          ...previous,
          values: { ...previous.values, [fieldKey]: value },
          confirmed,
          attested: false,
          selected: false,
        },
      };
    });
  }

  function confirmField(candidate: OcrCandidateView, fieldKey: string) {
    const draft = drafts[candidate.ref] ?? initialDraft(candidate);
    if (!draft.values[fieldKey]?.trim()) return;
    const confirmed = new Set(draft.confirmed);
    confirmed.add(fieldKey);
    setDrafts((current) => ({
      ...current,
      [candidate.ref]: { ...draft, confirmed },
    }));
    const unresolved = candidates
      .flatMap((candidateOption) =>
        candidateOption.fields.map((field) => ({
          candidate: candidateOption,
          field,
        })),
      )
      .find(({ candidate: candidateOption, field }) => {
        const candidateConfirmed =
          candidateOption.ref === candidate.ref
            ? confirmed
            : (drafts[candidateOption.ref]?.confirmed ?? new Set<string>());
        return !candidateConfirmed.has(field.key);
      });
    if (unresolved)
      queueMicrotask(() =>
        fieldRefs.current
          .get(`${unresolved.candidate.ref}:${unresolved.field.key}`)
          ?.focus(),
      );
  }

  return (
    <div className="min-w-0 space-y-4">
      <p className="break-words text-sm text-lifeone-ink-2">
        Todo resultado de OCR começa não verificado e fora da seleção. Confira
        cada campo; uma correção desfaz a atestação e a seleção.
      </p>
      {candidates.map((candidate, candidateIndex) => {
        const draft = drafts[candidate.ref] ?? initialDraft(candidate);
        const allConfirmed = candidate.fields.every((field) =>
          draft.confirmed.has(field.key),
        );
        return (
          <article
            key={candidate.ref}
            aria-label={`Candidato ${candidateIndex + 1}`}
            className="min-w-0 space-y-4 rounded-xl border border-darc-linen p-3"
          >
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">Candidato {candidateIndex + 1}</h3>
              <strong className="rounded-full bg-amber-100 px-3 py-1 text-xs text-amber-900">
                {OCR_STATUS_LABEL[candidate.status]}
              </strong>
            </div>
            {candidate.fields.map((field) => {
              const confirmed = draft.confirmed.has(field.key);
              const inputId = `${candidateIndex}-${field.key}`;
              return (
                <div
                  key={field.key}
                  className="min-w-0 space-y-2 rounded-xl bg-lifeone-surface p-3"
                >
                  <label
                    htmlFor={inputId}
                    className="block text-sm font-medium"
                  >
                    {field.label}
                  </label>
                  <input
                    id={inputId}
                    ref={(element) => {
                      const key = `${candidate.ref}:${field.key}`;
                      if (element) fieldRefs.current.set(key, element);
                      else fieldRefs.current.delete(key);
                    }}
                    value={draft.values[field.key] ?? ""}
                    onChange={(event) =>
                      changeField(
                        candidate,
                        field.key,
                        event.currentTarget.value,
                      )
                    }
                    className="min-h-11 w-full min-w-0 rounded-xl border border-darc-linen bg-white px-3 text-base focus-visible:outline focus-visible:outline-2"
                  />
                  <button
                    type="button"
                    disabled={confirmed || !draft.values[field.key]?.trim()}
                    onClick={() => confirmField(candidate, field.key)}
                    className="min-h-11 rounded-xl border border-darc-linen px-3 text-sm font-semibold disabled:opacity-50"
                    aria-label={`Confirmar campo ${field.label}`}
                  >
                    {confirmed ? "Campo conferido" : "Confirmar campo"}
                  </button>
                </div>
              );
            })}
            <label className="flex min-h-11 min-w-0 items-center gap-3 rounded-xl border border-darc-linen p-3 text-sm">
              <input
                type="checkbox"
                checked={draft.attested}
                disabled={!allConfirmed}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  setDrafts((current) => ({
                    ...current,
                    [candidate.ref]: {
                      ...draft,
                      attested: checked,
                      selected: checked ? draft.selected : false,
                    },
                  }));
                }}
                className="h-5 w-5 shrink-0"
              />
              <span className="min-w-0 break-words">
                Atesto que conferi todos os campos do candidato{" "}
                {candidateIndex + 1}
              </span>
            </label>
            <label className="flex min-h-11 min-w-0 items-center gap-3 rounded-xl border border-darc-linen p-3 text-sm">
              <input
                type="checkbox"
                checked={draft.selected}
                disabled={!draft.attested}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  setDrafts((current) => ({
                    ...current,
                    [candidate.ref]: {
                      ...draft,
                      selected: checked,
                    },
                  }));
                }}
                className="h-5 w-5 shrink-0"
              />
              <span className="min-w-0 break-words">
                Selecionar candidato {candidateIndex + 1} para preparar
              </span>
            </label>
          </article>
        );
      })}
      <button
        type="button"
        disabled={!canPrepare || !onPrepare}
        onClick={() =>
          onPrepare?.(
            selected.map((candidate) => ({
              ref: candidate.ref,
              fields: { ...drafts[candidate.ref].values },
              attested: true,
            })),
          )
        }
        className="min-h-11 w-full rounded-xl bg-darc-red px-4 font-semibold text-white disabled:opacity-50"
      >
        Preparar candidatos selecionados
      </button>
      <p className="text-sm text-lifeone-ink-2">
        Preparar não confirma nem cria lançamentos financeiros.
      </p>
    </div>
  );
}
