'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ProjectType } from '@reformaflow/domain';
import { LifeOneLogo } from '@/components/LifeOneLogo';
import { ProjectProvider } from '@/contexts/project-context';
import { ProgressDots, type ProgressDotsStep } from './_components/ProgressDots';
import { ProjectNameStep } from './_components/ProjectNameStep';
import { DoneStep } from './_components/DoneStep';
import { ANCHOR_STEPS } from './_lib/steps-config';

const VALID_TYPES = new Set<string>(Object.values(ProjectType));

/**
 * Generic, config-driven onboarding wizard shell — replaces the old
 * PESSOAL-only `onboarding/pessoal-setup/page.tsx`. Query params:
 * - `type` (required): one of the 6 ProjectType values. Missing/invalid
 *   redirects to `/projects`.
 * - `projectId` (optional): when present, the project already exists (the
 *   "+"-button flow already created it) and the wizard skips the
 *   project-creation step, starting at the first anchor step.
 *
 * Always terminates by redirecting to `/projects/:id/apoio` — never to
 * `/monthly` or any other cockpit route (regression class fixed in #195,
 * extended here to all 6 project types).
 */
export default function OnboardingSetupPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const typeParam = searchParams.get('type');
  const projectIdParam = searchParams.get('projectId');

  const type = typeParam && VALID_TYPES.has(typeParam) ? (typeParam as ProjectType) : null;

  const [projectId, setProjectId] = useState<string | null>(projectIdParam);
  const [stepIdx, setStepIdx] = useState(0);

  useEffect(() => {
    if (!type) {
      router.replace('/projects');
    }
  }, [type, router]);

  const anchorSteps = useMemo(() => (type ? ANCHOR_STEPS[type] : []), [type]);

  const steps: ProgressDotsStep[] = useMemo(() => {
    const list: ProgressDotsStep[] = [];
    if (!projectIdParam) list.push({ key: 'project', label: 'Projeto' });
    for (const anchor of anchorSteps) list.push({ key: anchor.key, label: anchor.label });
    list.push({ key: 'done', label: 'Pronto' });
    return list;
  }, [projectIdParam, anchorSteps]);

  const advance = useCallback(() => {
    setStepIdx((i) => i + 1);
  }, []);

  useEffect(() => {
    if (stepIdx === steps.length - 1 && projectId) {
      const timer = setTimeout(() => {
        router.replace(`/projects/${projectId}/apoio`);
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [stepIdx, steps.length, projectId, router]);

  if (!type) return null;

  const currentKey = steps[stepIdx]?.key;

  return (
    <main className="min-h-screen bg-lifeone-canvas px-4 py-6 font-geist sm:px-6 sm:py-10">
      <div className="mx-auto w-full max-w-lg">
        <header className="mb-8 flex items-center justify-between">
          <LifeOneLogo compact />
          <span className="text-[12px] font-medium text-lifeone-ink-3">Começando do zero</span>
        </header>

        <ProgressDots steps={steps} currentIndex={stepIdx} />

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

        {projectId &&
          anchorSteps.map((anchor) => {
            const anchorGlobalIdx = steps.findIndex((s) => s.key === anchor.key);
            if (anchorGlobalIdx !== stepIdx) return null;
            const Component = anchor.Component;
            return (
              <ProjectProvider
                key={anchor.key}
                value={{ projectId, projectType: type, projectName: '' }}
              >
                <Component
                  projectId={projectId}
                  projectType={type}
                  onDone={advance}
                  onSkip={advance}
                />
              </ProjectProvider>
            );
          })}
      </div>
    </main>
  );
}
