'use client';

import Link from 'next/link';
import { useProject } from '@/contexts/project-context';
import { ProjectType } from '@reformaflow/domain';
import { CheckCircle2, Compass } from 'lucide-react';
import { typeAccent } from '../../_components/type-accent';
import { APOIO_CONTENT } from './_content';

/** First-run guide per project type — "how do I start using this?". */
export default function ApoioPage() {
  const { projectId, projectType, projectName } = useProject();
  const accent = typeAccent(projectType);
  const content = APOIO_CONTENT[projectType as ProjectType];
  const basePath = `/projects/${projectId}`;

  if (!content) {
    return (
      <div className="rounded-2xl border border-gray-200 bg-white p-6 text-center text-sm text-gray-600">
        Guia de apoio não disponível para este tipo de projeto.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6 flex items-center gap-3">
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px]"
          style={{ background: accent.fill, color: accent.color }}
        >
          <Compass className="h-6 w-6" />
        </span>
        <div>
          <h1 className="text-xl font-bold text-gray-900">
            Apoio — {projectName}
          </h1>
          <p className="text-sm text-gray-500">Como começar a usar este projeto</p>
        </div>
      </div>

      <p className="mb-6 text-[15px] leading-relaxed text-gray-700">{content.intro}</p>

      <ol className="space-y-3">
        {content.steps.map((step, index) => {
          const body = (
            <>
              <span
                className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
                style={{ background: accent.fill, color: accent.color }}
              >
                {index + 1}
              </span>
              <div className="min-w-0">
                <p className="font-semibold text-gray-900">{step.title}</p>
                <p className="text-sm text-gray-600">{step.description}</p>
              </div>
            </>
          );
          return (
            <li key={step.title}>
              {step.slug ? (
                <Link
                  href={`${basePath}/${step.slug}`}
                  className="flex items-start gap-3 rounded-2xl border border-gray-200 bg-white p-4 transition-colors hover:border-gray-300 hover:bg-gray-50"
                >
                  {body}
                </Link>
              ) : (
                <div className="flex items-start gap-3 rounded-2xl border border-gray-200 bg-white p-4">
                  {body}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      <div className="mt-6 flex items-start gap-2 rounded-2xl bg-gray-50 p-4 text-sm text-gray-600">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
        <span>
          Dúvidas mais detalhadas de cada tela ficam no manual completo do
          aplicativo — peça pro time se precisar.
        </span>
      </div>
    </div>
  );
}
