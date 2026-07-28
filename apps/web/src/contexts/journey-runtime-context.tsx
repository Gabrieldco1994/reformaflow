"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/contexts/auth-context";
import {
  completeJourney,
  getEligibleJourneys,
  listJourneyProjects,
  type EligibleJourneyStep,
  type JourneyEligibilityContext,
  type JourneyProject,
  type RuntimeJourney,
  normalizeJourney,
} from "@/lib/journeys/runtime";

interface ActiveJourney {
  journey: RuntimeJourney;
  stepIndex: number;
  projectId?: string;
}

interface JourneyRuntimeContextValue {
  active: ActiveJourney | null;
  projects: JourneyProject[];
  loading: boolean;
  error: string | null;
  emit: (context: JourneyEligibilityContext) => Promise<void>;
  emitSignupCompleted: () => Promise<void>;
  emitProjectCreated: (
    projectId: string,
    projectType: JourneyProject["type"],
  ) => Promise<void>;
  next: () => void;
  back: () => void;
  skip: () => void;
  chooseProject: (projectId: string) => void;
  dismiss: () => void;
}

const JourneyRuntimeContext = createContext<JourneyRuntimeContextValue | null>(
  null,
);
const STORAGE_KEY = "lifeone:journey-runtime";

function currentProjectId(pathname: string): string | undefined {
  const match = pathname.match(/^\/projects\/([^/]+)/);
  return match?.[1];
}

function device(): "web" | "mobile" {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 767px)").matches
    ? "mobile"
    : "web";
}

function readStored(): ActiveJourney | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ActiveJourney) : null;
  } catch {
    return null;
  }
}

function writeStored(active: ActiveJourney | null) {
  if (typeof window === "undefined") return;
  if (!active) window.sessionStorage.removeItem(STORAGE_KEY);
  else window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(active));
}

export function JourneyRuntimeProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, loading: authLoading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [active, setActive] = useState<ActiveJourney | null>(null);
  const [queue, setQueue] = useState<RuntimeJourney[]>([]);
  const [restored, setRestored] = useState(false);
  const [projects, setProjects] = useState<JourneyProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const completedKeys = useRef(new Set<string>());

  useEffect(() => {
    setActive(readStored());
    setRestored(true);
  }, []);

  useEffect(() => {
    writeStored(active);
  }, [active]);

  const emit = useCallback(
    async (context: JourneyEligibilityContext) => {
      if (!user || authLoading || active) return;
      setLoading(true);
      setError(null);
      try {
        const journeys = (await getEligibleJourneys(context))
          .map(normalizeJourney)
          .filter((journey) => !completedKeys.current.has(journey.key));
        const [journey] = journeys;
        if (journey?.steps.length) {
          if (journey.crossProject) {
            void listJourneyProjects()
              .then(setProjects)
              .catch(() => setProjects([]));
          }
          setActive({
            journey,
            stepIndex: 0,
            projectId: context.projectId,
          });
          setQueue(journeys);
        }
      } catch {
        // The runtime is additive: an unavailable journey API must not break the app.
      } finally {
        setLoading(false);
      }
    },
    [active, authLoading, user],
  );

  const emitSignupCompleted = useCallback(
    () => emit({ triggerType: "SIGNUP_COMPLETED", device: device() }),
    [emit],
  );

  const emitProjectCreated = useCallback(
    (projectId: string, projectType: JourneyProject["type"]) =>
      emit({
        triggerType: "PROJECT_CREATED",
        device: device(),
        projectId,
        projectType,
      }),
    [emit],
  );

  useEffect(() => {
    if (!restored || !user || authLoading || !pathname || active) return;
    const projectId = currentProjectId(pathname);
    void emit({
      triggerType: "SCREEN_VISIT",
      device: device(),
      projectId,
      screenKey: pathname.split("/").pop() || undefined,
    });
  }, [active, authLoading, emit, pathname, restored, user]);

  useEffect(() => {
    if (!user || authLoading) return;
    const onAction = (event: MouseEvent) => {
      const target =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-journey-action]")
          : null;
      const actionKey = target?.dataset.journeyAction;
      if (actionKey) {
        void emit({
          triggerType: "ACTION",
          device: device(),
          projectId: currentProjectId(window.location.pathname),
          actionKey,
        });
      }
    };
    document.addEventListener("click", onAction);
    return () => document.removeEventListener("click", onAction);
  }, [authLoading, emit, user]);

  const finish = useCallback(async () => {
    if (!active) return;
    const completed = active;
    completedKeys.current.add(completed.journey.key);
    const nextJourney = queue[1];
    if (nextJourney) {
      setQueue((current) => current.slice(1));
      setActive({
        journey: nextJourney,
        stepIndex: 0,
        projectId: active.projectId,
      });
    } else {
      setQueue([]);
      setActive(null);
    }
    try {
      await completeJourney(
        completed.journey.journeyId,
        completed.journey.triggerId,
        completed.projectId,
      );
    } catch {
      // Completion is best effort for the overlay; the next eligibility check remains authoritative.
    }
  }, [active, queue]);

  const next = useCallback(() => {
    if (!active) return;
    if (active.stepIndex >= active.journey.steps.length - 1) void finish();
    else {
      const nextStep = active.journey.steps[active.stepIndex + 1];
      if (
        nextStep?.experience === "FULL" &&
        nextStep.route &&
        active.projectId
      ) {
        router.push(`/projects/${active.projectId}/${nextStep.route}`);
      }
      setActive({ ...active, stepIndex: active.stepIndex + 1 });
    }
  }, [active, finish, router]);

  const back = useCallback(() => {
    if (active)
      setActive({ ...active, stepIndex: Math.max(0, active.stepIndex - 1) });
  }, [active]);

  const skip = useCallback(() => {
    if (!active) return;
    const step = active.journey.steps[active.stepIndex];
    if (!step?.skippable) return;
    if (step.blocked) {
      if (active.stepIndex >= active.journey.steps.length - 1) void finish();
      else setActive({ ...active, stepIndex: active.stepIndex + 1 });
      return;
    }
    next();
  }, [active, finish, next]);

  const chooseProject = useCallback(
    (projectId: string) => {
      if (active) setActive({ ...active, projectId });
    },
    [active],
  );

  const dismiss = useCallback(() => {
    if (active?.journey.dismissPolicy !== "none") {
      setQueue([]);
      setActive(null);
    }
  }, [active]);

  const value = useMemo(
    () => ({
      active,
      projects,
      loading,
      error,
      emit,
      emitSignupCompleted,
      emitProjectCreated,
      next,
      back,
      skip,
      chooseProject,
      dismiss,
    }),
    [
      active,
      back,
      chooseProject,
      dismiss,
      emit,
      emitProjectCreated,
      emitSignupCompleted,
      error,
      loading,
      next,
      projects,
      skip,
    ],
  );

  return (
    <JourneyRuntimeContext.Provider value={value}>
      {children}
      <JourneyRuntimeOverlay />
    </JourneyRuntimeContext.Provider>
  );
}

export function useJourneyRuntime() {
  const context = useContext(JourneyRuntimeContext);
  if (!context)
    throw new Error(
      "useJourneyRuntime must be used within JourneyRuntimeProvider",
    );
  return context;
}

function JourneyRuntimeOverlay() {
  const runtime = useJourneyRuntime();
  const active = runtime.active;
  if (!active) return null;
  const step: EligibleJourneyStep | undefined =
    active.journey.steps[active.stepIndex];
  if (!step) return null;

  return (
    <aside
      role="dialog"
      data-journey-panel
      aria-modal="false"
      aria-label={`Jornada: ${active.journey.name}`}
      className="fixed inset-x-3 bottom-3 z-[70] mx-auto max-w-lg rounded-[18px] border border-lifeone-hairline bg-lifeone-card p-4 shadow-2xl"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-lifeone-blue">
            Jornada ·{" "}
            <span data-journey-progress>
              {active.stepIndex + 1}/{active.journey.steps.length}
            </span>
          </p>
          <h2
            data-journey-step={step.stepKey}
            data-journey-experience={step.experience}
            className="text-[17px] font-bold text-lifeone-ink"
          >
            {step.label}
          </h2>
        </div>
        <button
          type="button"
          onClick={runtime.dismiss}
          disabled={!step.skippable}
          aria-label="Fechar jornada"
          className="min-h-11 min-w-11 rounded-[10px] text-[20px] text-lifeone-ink-3 disabled:opacity-30"
        >
          ×
        </button>
      </div>

      {step.experience === "FULL" ? (
        <p className="text-[13px] text-lifeone-ink-2">
          Você está na tela real da funcionalidade. Use o painel para continuar
          a jornada.
        </p>
      ) : (
        <p className="text-[13px] text-lifeone-ink-2">{step.subtitle}</p>
      )}
      {step.blocked && (
        <p className="mt-3 text-[13px] text-lifeone-ink-2">
          Esta etapa aguarda uma condição para continuar.
        </p>
      )}

      {active.journey.crossProject && <ProjectPicker runtime={runtime} />}

      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={runtime.back}
          disabled={active.stepIndex === 0}
          className="min-h-11 rounded-[10px] border border-lifeone-hairline px-3 text-[13px] disabled:opacity-40"
        >
          Voltar
        </button>
        {step.skippable && (
          <button
            type="button"
            onClick={runtime.skip}
            className="min-h-11 rounded-[10px] px-3 text-[13px] text-lifeone-ink-2"
          >
            Pular
          </button>
        )}
        <button
          type="button"
          onClick={runtime.next}
          disabled={step.blocked}
          className="min-h-11 rounded-[10px] bg-lifeone-blue px-4 text-[13px] font-semibold text-white"
        >
          {active.stepIndex === active.journey.steps.length - 1
            ? "Concluir"
            : "Continuar"}
        </button>
      </div>
    </aside>
  );
}

function ProjectPicker({ runtime }: { runtime: JourneyRuntimeContextValue }) {
  if (runtime.projects.length === 0) {
    return (
      <p className="mt-3 text-[12px] text-[#B42318]">
        Nenhum projeto compatível encontrado. Você pode pular esta etapa.
      </p>
    );
  }
  return (
    <label className="mt-3 block text-[12px] font-semibold text-lifeone-ink-2">
      Escolha o projeto
      <select
        aria-label="Projeto da jornada"
        onChange={(event) => runtime.chooseProject(event.target.value)}
        className="mt-1 min-h-11 w-full rounded-[10px] border border-lifeone-hairline px-3 text-[13px]"
      >
        <option value="">Selecione</option>
        {runtime.projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
    </label>
  );
}
