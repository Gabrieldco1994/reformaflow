"use client";

export const dynamic = "force-dynamic";

import { useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, Eye, Loader2, Plus, Save } from "lucide-react";
import { JOURNEY_TRIGGER_TYPES, ProjectType } from "@reformaflow/domain";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/auth-context";
import { JourneyTrack } from "./_components/JourneyTrack";
import { useJourneyEditor } from "./_hooks/useJourneyEditor";
import {
  PROJECT_TYPE_LABELS,
  TRIGGER_TYPE_LABELS,
  type EditorJourney,
} from "./_types";

const TYPES = Object.values(ProjectType);

export default function AdminJornadasPage() {
  const { user, isAdmin, loading: authLoading } = useAuth();
  const router = useRouter();
  const editor = useJourneyEditor();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [templateKey, setTemplateKey] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (authLoading) return;
    if (!user) router.replace("/login");
    else if (!isAdmin) router.replace("/no-permission");
  }, [authLoading, isAdmin, router, user]);

  async function handleSave() {
    try {
      await editor.save();
      setNotice("Alterações salvas.");
    } catch {
      setNotice("");
    }
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newName.trim() || !templateKey) return;
    try {
      await editor.create(newName, templateKey);
      setNewName("");
      setTemplateKey("");
      setCreating(false);
    } catch {
      setNotice("");
    }
  }

  if (!isAdmin) return null;

  return (
    <main className="min-h-screen bg-lifeone-canvas px-4 py-6 font-geist sm:px-6">
      <div className="mx-auto w-full max-w-7xl">
        <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <a
              href="/admin/users"
              className="mb-3 inline-flex min-h-11 items-center text-[12px] text-lifeone-ink-3 hover:text-lifeone-ink"
            >
              ← Usuários
            </a>
            <h1 className="text-[22px] font-bold text-lifeone-ink">Jornadas</h1>
            <p className="mt-1 text-[13px] text-lifeone-ink-2">
              Configure onde cada jornada aparece, quando começa e o caminho que
              a pessoa percorre.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCreating((open) => !open)}
            className="inline-flex min-h-11 items-center gap-2 rounded-[10px] bg-lifeone-ink px-4 text-[13px] font-semibold text-white"
          >
            <Plus className="h-4 w-4" /> Nova jornada
          </button>
        </header>

        {creating && (
          <form
            onSubmit={handleCreate}
            className="mb-4 grid gap-3 rounded-[18px] border border-lifeone-hairline bg-lifeone-card p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          >
            <label className="text-[12px] font-semibold text-lifeone-ink-2">
              Nome da jornada
              <input
                aria-label="Nome da jornada"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                required
                className="mt-1 min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3 text-[13px]"
              />
            </label>
            <label className="text-[12px] font-semibold text-lifeone-ink-2">
              Template
              <select
                aria-label="Template"
                value={templateKey}
                onChange={(event) => setTemplateKey(event.target.value)}
                required
                className="mt-1 min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3 text-[13px]"
              >
                <option value="">Escolha uma jornada</option>
                {editor.journeys.map((journey) => (
                  <option key={journey.key} value={journey.key}>
                    {journey.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              className="min-h-11 rounded-[10px] bg-lifeone-blue px-4 text-[13px] font-semibold text-white"
            >
              Criar jornada
            </button>
          </form>
        )}

        <div className="grid gap-4 lg:grid-cols-[230px_1fr]">
          <aside className="rounded-[18px] border border-lifeone-hairline bg-lifeone-card p-2 shadow-lifeone-card">
            <h2 className="px-3 py-2 text-[12px] font-semibold uppercase tracking-wide text-lifeone-ink-3">
              Todas as jornadas
            </h2>
            <div className="space-y-1">
              {editor.journeys.map((journey) => (
                <button
                  key={journey.key}
                  type="button"
                  aria-pressed={journey.key === editor.selectedKey}
                  onClick={() => editor.select(journey.key)}
                  className={`w-full rounded-[10px] px-3 py-3 text-left text-[13px] ${journey.key === editor.selectedKey ? "bg-lifeone-ink text-white" : "text-lifeone-ink-2 hover:bg-lifeone-surface"}`}
                >
                  <span className="block font-semibold">{journey.name}</span>
                  <span
                    className={`mt-1 block text-[11px] ${journey.key === editor.selectedKey ? "text-white/70" : "text-lifeone-ink-3"}`}
                  >
                    {journey.key}
                  </span>
                </button>
              ))}
            </div>
          </aside>

          <section className="min-w-0 rounded-[18px] border border-lifeone-hairline bg-lifeone-card p-4 shadow-lifeone-card">
            {editor.loading || !editor.selected ? (
              <div className="flex min-h-48 items-center justify-center text-[13px] text-lifeone-ink-3">
                {editor.loading ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  "Nenhuma jornada encontrada."
                )}
              </div>
            ) : (
              <>
                <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <label className="block text-[12px] font-semibold text-lifeone-ink-2">
                      Nome
                      <input
                        value={editor.selected.name}
                        onChange={(event) =>
                          editor.patchJourney({ name: event.target.value })
                        }
                        className="mt-1 min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3 text-[16px] font-bold text-lifeone-ink"
                      />
                    </label>
                    <label className="mt-2 block text-[12px] font-semibold text-lifeone-ink-2">
                      Descrição
                      <textarea
                        value={editor.selected.description}
                        onChange={(event) =>
                          editor.patchJourney({
                            description: event.target.value,
                          })
                        }
                        rows={2}
                        className="mt-1 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface p-3 text-[13px] text-lifeone-ink"
                      />
                    </label>
                  </div>
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={!editor.dirty || editor.saving}
                    className="inline-flex min-h-11 items-center gap-2 rounded-[10px] bg-lifeone-blue px-4 text-[13px] font-semibold text-white disabled:opacity-40"
                  >
                    {editor.saving ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4" />
                    )}
                    Salvar jornada
                  </button>
                </div>

                {(editor.dirty || notice) && (
                  <p className="mb-4 flex items-center gap-2 rounded-[10px] bg-[#FBEBDC] px-3 py-2 text-[12px] text-[#8A5A18]">
                    {editor.dirty && <AlertTriangle className="h-4 w-4" />}
                    {editor.dirty ? "Alterações não salvas." : notice}
                  </p>
                )}
                {editor.error && (
                  <p className="mb-4 rounded-[10px] bg-[#FDECEA] px-3 py-2 text-[13px] text-[#B42318]">
                    {editor.error.message}
                  </p>
                )}

                <div className="mb-5 grid gap-3 rounded-[14px] border border-lifeone-hairline bg-lifeone-surface p-3 md:grid-cols-2">
                  <label className="text-[12px] font-semibold text-lifeone-ink-2">
                    Onde aparece
                    <select
                      aria-label="Onde aparece"
                      value={editor.selected.trigger.targetProjectType ?? ""}
                      onChange={(event) =>
                        editor.patchJourney({
                          trigger: {
                            ...editor.selected!.trigger,
                            targetProjectType: (event.target.value ||
                              null) as ProjectType | null,
                          },
                        })
                      }
                      className="mt-1 min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-card px-3 text-[13px]"
                    >
                      <option value="">Todos os projetos</option>
                      {TYPES.map((type) => (
                        <option key={type} value={type}>
                          {PROJECT_TYPE_LABELS[type]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-[12px] font-semibold text-lifeone-ink-2">
                    Começa quando
                    <select
                      aria-label="Começa quando"
                      value={editor.selected.startsWhen}
                      onChange={(event) =>
                        editor.patchJourney({
                          startsWhen: event.target
                            .value as typeof editor.selected.startsWhen,
                        })
                      }
                      className="mt-1 min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-card px-3 text-[13px]"
                    >
                      {JOURNEY_TRIGGER_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {TRIGGER_TYPE_LABELS[type]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-[12px] font-semibold text-lifeone-ink-2">
                    Dispositivo
                    <select
                      aria-label="Dispositivo"
                      value={editor.selected.trigger.device}
                      onChange={(event) =>
                        editor.patchJourney({
                          trigger: {
                            ...editor.selected!.trigger,
                            device: event.target
                              .value as EditorJourney["trigger"]["device"],
                          },
                        })
                      }
                      className="mt-1 min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-card px-3 text-[13px]"
                    >
                      <option value="any">Web e mobile</option>
                      <option value="web">Web</option>
                      <option value="mobile">Mobile</option>
                    </select>
                  </label>
                  <label className="flex min-h-11 items-center gap-2 text-[12px] font-semibold text-lifeone-ink-2">
                    <input
                      type="checkbox"
                      checked={editor.selected.trigger.crossProject}
                      onChange={(event) =>
                        editor.patchJourney({
                          trigger: {
                            ...editor.selected!.trigger,
                            crossProject: event.target.checked,
                          },
                        })
                      }
                      className="h-4 w-4"
                    />
                    Pode atravessar projetos
                  </label>
                </div>

                <div className="mb-2 flex items-center gap-2">
                  <Eye className="h-4 w-4 text-lifeone-blue" />
                  <h2 className="text-[16px] font-bold text-lifeone-ink">
                    Trail de passos
                  </h2>
                </div>
                <JourneyTrack
                  steps={editor.selected.steps}
                  onReorder={editor.reorder}
                  onMove={editor.moveStep}
                  onPatch={editor.patchStep}
                />

                <div
                  data-testid="journey-preview"
                  className="mt-4 rounded-[14px] border border-lifeone-hairline bg-lifeone-surface p-4"
                >
                  <h2 className="text-[15px] font-bold text-lifeone-ink">
                    Preview para a pessoa
                  </h2>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {editor.selected.steps
                      .filter((step) => step.enabled)
                      .map((step, index) => (
                        <div
                          key={step.key}
                          className="min-w-[150px] flex-1 rounded-[12px] border border-lifeone-hairline bg-lifeone-card p-3"
                        >
                          <span className="text-[11px] font-semibold text-lifeone-blue">
                            Passo {index + 1}
                          </span>
                          <h3 className="mt-1 text-[15px] font-bold text-lifeone-ink">
                            {step.label}
                          </h3>
                          <p className="mt-1 text-[12px] text-lifeone-ink-2">
                            {step.subtitle}
                          </p>
                        </div>
                      ))}
                  </div>
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
