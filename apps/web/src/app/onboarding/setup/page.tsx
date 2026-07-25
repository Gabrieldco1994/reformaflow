'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ProjectType, type ResolvedJourneyStep } from '@reformaflow/domain';
import { LifeOneLogo } from '@/components/LifeOneLogo';
import { ProjectProvider } from '@/contexts/project-context';
import { ProgressDots } from './_components/ProgressDots';
import { ProjectNameStep } from './_components/ProjectNameStep';
import { MariaInsightStep } from './_components/steps/MariaInsightStep';
import { FeedbackStep } from './_components/steps/FeedbackStep';
import { DoneStep } from './_components/DoneStep';
import { STEP_COMPONENTS } from './_lib/steps-config';
import { useJourney } from './_hooks/useJourney';
import type { StepDonePayload } from './_types';
import { getProjectHomePath } from '@/app/projects/_lib/project-home-route';

const VALID_TYPES = new Set<string>(Object.values(ProjectType));

/**
 * Uma posição do wizard: as telas configuráveis da jornada + os dois bookends
 * (`project`/`done`), que o admin não reordena nem desliga.
 */
interface FlowStep {
  key: string;
  label: string;
  subtitle?: string;
  skippable?: boolean;
}

const BOOKEND_PROJECT: FlowStep = { key: 'project', label: 'Projeto' };
const BOOKEND_DONE: FlowStep = { key: 'done', label: 'Pronto' };

/**
 * Generic, config-driven onboarding wizard shell — replaces the old
 * PESSOAL-only `onboarding/pessoal-setup/page.tsx`. Query params:
 * - `type` (required): one of the 6 ProjectType values. Missing/invalid
 *   redirects to `/projects`.
 * - `projectId` (optional): when present, the project already exists (the
 *   "+"-button flow already created it) and the wizard skips the
 *   project-creation step, starting at the first anchor step.
 *
 * Always terminates by redirecting to the project's per-type cockpit
 * (the first nav module for the type via `getProjectHomePath`): PESSOAL →
 * `/monthly`, the rest → `/dashboard`. Never lands on an intermediate page.
 */
function OnboardingSetupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const typeParam = searchParams.get('type');
  const projectIdParam = searchParams.get('projectId');

  const type = typeParam && VALID_TYPES.has(typeParam) ? (typeParam as ProjectType) : null;

  const [projectId, setProjectId] = useState<string | null>(projectIdParam);
  const [stepIdx, setStepIdx] = useState(0);
  const [createdExpense, setCreatedExpense] = useState<
    NonNullable<StepDonePayload['createdExpense']> | null
  >(null);

  useEffect(() => {
    if (!type) {
      router.replace('/projects');
    }
  }, [type, router]);

  const journey = useJourney(type);

  // O passo da Maria só existe no PESSOAL e só depois de a 1ª despesa ser
  // criada (pulou a despesa → createdExpense fica null → passo não aparece).
  const showMariaStep = type === ProjectType.PESSOAL && createdExpense != null;

  // Telas condicionais (`alwaysAvailable: false`): ligar no painel do admin não
  // burla a condição do wizard — sem contexto, a tela continua fora do fluxo.
  const conditionMet = useCallback(
    (step: ResolvedJourneyStep) =>
      step.alwaysAvailable || (step.key === 'maria-insight' && showMariaStep),
    [showMariaStep],
  );

  // Telas do fluxo, na ordem que a jornada define, sem as desligadas e sem as
  // condicionais cuja condição ainda não foi satisfeita.
  const flowSteps: FlowStep[] = useMemo(
    () =>
      journey
        .filter((step) => step.enabled && conditionMet(step))
        .map((step) => ({
          key: step.key,
          label: step.label,
          subtitle: step.subtitle,
          skippable: step.skippable,
        })),
    [journey, conditionMet],
  );

  const steps: FlowStep[] = useMemo(() => {
    const list: FlowStep[] = [];
    if (!projectIdParam) list.push(BOOKEND_PROJECT);
    list.push(...flowSteps);
    list.push(BOOKEND_DONE);
    return list;
  }, [projectIdParam, flowSteps]);

  const advance = useCallback(() => {
    setStepIdx((i) => i + 1);
  }, []);

  useEffect(() => {
    if (stepIdx === steps.length - 1 && projectId && type) {
      const timer = setTimeout(() => {
        router.replace(getProjectHomePath(projectId, type));
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [stepIdx, steps.length, projectId, type, router]);

  if (!type) return null;

  const currentStep = steps[stepIdx];
  const currentKey = currentStep?.key;
  // Componente da tela atual por lookup da key — o shell nunca ramifica por
  // tipo de projeto; quem decide o que aparece (e em que ordem) é a jornada.
  const CurrentComponent = currentKey ? STEP_COMPONENTS[currentKey] : undefined;

  // Enquanto o passo atual é um passo de fluxo (bank/card/expense/maria/...), a
  // régua mostra o progresso DENTRO da fase de setup do tipo, não o total
  // incluindo o nome do projeto e o "Pronto" — esses dois são bookends.
  const flowIndex = flowSteps.findIndex((step) => step.key === currentKey);
  const progressSteps = flowIndex >= 0 ? flowSteps : steps;
  const progressIndex = flowIndex >= 0 ? flowIndex : stepIdx;

  return (
    <main className="min-h-screen bg-lifeone-canvas px-4 py-6 font-geist sm:px-6 sm:py-10">
      <div className="mx-auto w-full max-w-lg">
        <header className="mb-8 flex items-center justify-between">
          <LifeOneLogo compact />
          <span className="text-[12px] font-medium text-lifeone-ink-3">Começando do zero</span>
        </header>

        <ProgressDots steps={progressSteps} currentIndex={progressIndex} />

        {currentKey === 'project' && (
          <ProjectNameStep
            projectType={type}
            onCreated={(id) => {
              setProjectId(id);
              advance();
            }}
          />
        )}

        {currentKey === 'done' && <DoneStep />}

        {projectId && currentKey === 'maria-insight' && createdExpense && (
          <ProjectProvider value={{ projectId, projectType: type, projectName: '' }}>
            <MariaInsightStep
              projectId={projectId}
              createdExpense={createdExpense}
              onSkip={advance}
              onDone={advance}
              subtitle={currentStep?.subtitle}
              canSkip={currentStep?.skippable}
            />
          </ProjectProvider>
        )}

        {projectId && currentKey === 'feedback' && (
          <FeedbackStep onDone={advance} subtitle={currentStep?.subtitle} canSkip={currentStep?.skippable} />
        )}

        {projectId && CurrentComponent && currentStep && (
          <ProjectProvider
            key={currentStep.key}
            value={{ projectId, projectType: type, projectName: '' }}
          >
            <CurrentComponent
              projectId={projectId}
              projectType={type}
              onDone={(payload?: StepDonePayload) => {
                if (payload?.createdExpense) setCreatedExpense(payload.createdExpense);
                advance();
              }}
              onSkip={advance}
              subtitle={currentStep.subtitle}
              canSkip={currentStep.skippable}
            />
          </ProjectProvider>
        )}
      </div>
    </main>
  );
}

export default function OnboardingSetupPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-lifeone-canvas" />}>
      <OnboardingSetupForm />
    </Suspense>
  );
}
