'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useProject } from '@/contexts/project-context';
import { ProjectType } from '@reformaflow/domain';
import {
  ArrowRight,
  CheckCircle2,
  Compass,
  MessageSquarePlus,
  type LucideIcon,
} from 'lucide-react';
import { typeAccent, type TypeAccent } from '../../_components/type-accent';
import { APOIO_CONTENT, type ApoioStep } from './_content';
import { stepIcon } from './_step-icons';

/** First-run guide per project type — "how do I start using this?", as a vertical journey. */
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
    <div className="mx-auto max-w-3xl">
      <div className="mb-8 flex items-center gap-3">
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px]"
          style={{ background: accent.fill, color: accent.color }}
        >
          <Compass className="h-6 w-6" />
        </span>
        <div>
          <h1 className="text-xl font-bold text-gray-900">Apoio — {projectName}</h1>
          <p className="text-sm text-gray-500">Sua jornada para começar a usar este projeto</p>
        </div>
      </div>

      <p className="mb-10 text-[15px] leading-relaxed text-gray-700">{content.intro}</p>

      <ol className="relative border-l-2 pl-8 sm:pl-10" style={{ borderColor: accent.fill }}>
        {content.steps.map((step, index) => (
          <li key={step.title} className="relative pb-10 last:pb-0">
            <span
              className="absolute -left-[41px] top-0 flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold ring-4 ring-white sm:-left-[49px]"
              style={{ background: accent.fill, color: accent.color }}
            >
              {index + 1}
            </span>

            <div className="flex flex-col gap-4 sm:flex-row sm:items-stretch">
              <StepText step={step} basePath={basePath} />
              <StepPreview step={step} accent={accent} />
            </div>
          </li>
        ))}
      </ol>

      <section className="mt-8 rounded-2xl border border-gray-200 bg-white p-4">
        <div className="flex items-start gap-3">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
            style={{ background: accent.fill, color: accent.color }}
          >
            <MessageSquarePlus className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Último passo: envie seu feedback</h2>
            <p className="mt-1 text-sm text-gray-600">
              Depois de usar os passos acima, conte como foi sua experiência para o time.
            </p>
          </div>
        </div>
        <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-gray-600">
          <li>
            Abra o <strong>ícone de feedback (balão)</strong> no cabeçalho (mobile) ou menu lateral
            (desktop).
          </li>
          <li>Descreva rapidamente o que funcionou bem, o que ficou confuso ou qualquer bug.</li>
          <li>Toque em <strong>Enviar</strong> para registrar sua mensagem.</li>
        </ol>
      </section>

      <div className="mt-2 flex items-start gap-2 rounded-2xl bg-gray-50 p-4 text-sm text-gray-600">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
        <span>
          Dúvidas mais detalhadas de cada tela ficam no manual completo do
          aplicativo — peça pro time se precisar.
        </span>
      </div>
    </div>
  );
}

function StepText({ step, basePath }: { step: ApoioStep; basePath: string }) {
  const body = (
    <>
      <p className="font-semibold text-gray-900">{step.title}</p>
      <p className="mt-1 text-sm text-gray-600">{step.description}</p>
      {step.slug && (
        <span className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-gray-900">
          Ir para a tela <ArrowRight className="h-3.5 w-3.5" />
        </span>
      )}
    </>
  );

  if (!step.slug) {
    return (
      <div className="min-w-0 flex-1 rounded-2xl border border-gray-200 bg-white p-4">
        {body}
      </div>
    );
  }

  return (
    <Link
      href={`${basePath}/${step.slug}`}
      className="min-w-0 flex-1 rounded-2xl border border-gray-200 bg-white p-4 transition-colors hover:border-gray-300 hover:bg-gray-50"
    >
      {body}
    </Link>
  );
}

/**
 * "Print" de cada funcionalidade ao lado do passo. Usa a screenshot real
 * quando `previewSrc` existe; senão cai num mock ilustrado (ícone + skeleton)
 * — ponytail: sem PNGs reais capturados ainda, isso evita depender de uma
 * sessão logada rodando o app só pra gerar imagem. Upgrade: preencher
 * `previewSrc` em _content.ts com a screenshot de verdade.
 */
function StepPreview({ step, accent }: { step: ApoioStep; accent: TypeAccent }) {
  const Icon: LucideIcon = stepIcon(step.slug);

  return (
    <div className="w-full shrink-0 overflow-hidden rounded-2xl border border-gray-200 bg-gray-50 sm:w-44">
      <div className="flex items-center gap-1.5 border-b border-gray-200 bg-white px-3 py-1.5">
        <span className="h-2 w-2 rounded-full bg-gray-200" />
        <span className="h-2 w-2 rounded-full bg-gray-200" />
        <span className="h-2 w-2 rounded-full bg-gray-200" />
      </div>
      {step.previewSrc ? (
        <Image
          src={step.previewSrc}
          alt={`Tela de ${step.title}`}
          width={352}
          height={220}
          className="h-28 w-full object-cover object-top sm:h-32"
        />
      ) : (
        <div className="flex h-28 flex-col items-center justify-center gap-2 p-3 sm:h-32">
          <span
            className="flex h-9 w-9 items-center justify-center rounded-xl"
            style={{ background: accent.fill, color: accent.color }}
          >
            <Icon className="h-5 w-5" />
          </span>
          <div className="h-1.5 w-3/4 rounded-full bg-gray-200" />
          <div className="h-1.5 w-1/2 rounded-full bg-gray-200" />
        </div>
      )}
    </div>
  );
}
