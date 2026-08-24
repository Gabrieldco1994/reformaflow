'use client';

import { useEffect } from 'react';
import type { OnboardingFunding, ProjectType } from '@reformaflow/domain';
import { getCatalogItem, JOURNEY_STEPS_WITHOUT_SLUG } from '@reformaflow/domain';
import { ProjectProvider } from '@/contexts/project-context';
import { SummaryPageHeader, SummaryCTASection } from '@/components/informational-summary';
import { getOperationalSummaryStep } from '@/lib/operational-summaries/registry';
import type { OperationalSummaryPayload } from '@/lib/operational-summaries/types';
import type { EligibleJourneyStep } from '@/lib/journeys/runtime';

export interface SummaryStepPanelProps {
  step: EligibleJourneyStep;
  projectId: string;
  /** `null` = tipo do projeto ainda carregando (busca assíncrona no runtime). */
  projectType: ProjectType | null;
  funding: OnboardingFunding;
  onFundingChange: (next: OnboardingFunding) => void;
  onDone: (payload?: OperationalSummaryPayload) => void;
  onSkip: () => void;
  onBack?: () => void;
}

/**
 * Corpo de uma etapa SUMMARY do executor de Jornadas (Etapa E, parte 2 —
 * "ligar as experiências Resumidas"). Resolve, nesta ordem:
 *
 * 1. Componente operacional registrado (`OPERATIONAL_SUMMARY_REGISTRY`) — a
 *    etapa vira a tela de verdade (mesmo contrato usado pelo onboarding:
 *    `OperationalSummaryStepProps`). O componente tem suas PRÓPRIAS ações de
 *    salvar/pular — quem monta este painel decide não desenhar o rodapé
 *    genérico (Voltar/Pular/Continuar) quando este ramo está ativo, senão
 *    ficariam dois conjuntos de ação conflitantes.
 * 2. Resumo informativo do catálogo (`summary-catalog.ts` do domínio) —
 *    cabeçalho + CTAs para a tela real. Sem mutação própria: o rodapé
 *    genérico do painel continua sendo quem avança a jornada.
 * 3. Fallback seguro: o subtítulo puro (o único comportamento que existia
 *    antes desta mudança), com um erro diagnosticável uma única vez por
 *    combinação stepKey/tipo — nunca derruba a jornada por causa de uma
 *    chave sem cobertura.
 */
export function SummaryStepPanel({
  step,
  projectId,
  projectType,
  funding,
  onFundingChange,
  onDone,
  onSkip,
  onBack,
}: SummaryStepPanelProps) {
  const OperationalComponent = getOperationalSummaryStep(step.stepKey);
  const catalogItem =
    !OperationalComponent && projectType ? getCatalogItem(projectType, step.stepKey) : undefined;
  const isFallback = !OperationalComponent && !catalogItem;

  useEffect(() => {
    if (!isFallback || !projectType) return;
    // Etapas sem tela própria (feedback, maria-insight) são propositais — não logar erro.
    if (JOURNEY_STEPS_WITHOUT_SLUG.has(step.stepKey)) return;
    // eslint-disable-next-line no-console
    console.error(
      `[jornadas] stepKey "${step.stepKey}" (SUMMARY) sem componente operacional nem entrada no catálogo de resumos para o tipo "${projectType}" — usando fallback de texto simples.`,
    );
  }, [isFallback, projectType, step.stepKey]);

  if (OperationalComponent) {
    if (!projectType) {
      return <p className="text-[13px] text-lifeone-ink-2">Carregando…</p>;
    }
    return (
      <ProjectProvider value={{ projectId, projectType, projectName: '' }}>
        <OperationalComponent
          projectId={projectId}
          projectType={projectType}
          onDone={onDone}
          onSkip={onSkip}
          onBack={onBack}
          subtitle={step.subtitle ?? undefined}
          canSkip={step.skippable}
          funding={funding}
          onFundingChange={onFundingChange}
        />
      </ProjectProvider>
    );
  }

  if (catalogItem) {
    return (
      <div className="space-y-3">
        <SummaryPageHeader pageData={catalogItem} />
        <SummaryCTASection ctas={catalogItem.ctas} />
      </div>
    );
  }

  return <p className="text-[13px] text-lifeone-ink-2">{step.subtitle}</p>;
}

/** Usado pelo painel para decidir se desenha o rodapé genérico (a etapa
 * operacional tem as próprias ações de salvar/pular, incompatíveis com um
 * segundo "Continuar" genérico por cima). */
export function hasOperationalSummaryComponent(stepKey: string): boolean {
  return !!getOperationalSummaryStep(stepKey);
}
