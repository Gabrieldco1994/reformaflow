'use client';

import { useState } from 'react';
import { ArrowRight, CheckCircle2, SkipForward, Sparkles } from 'lucide-react';
import { setPendingMariaPrompt } from '@/app/projects/[projectId]/maria/_lib/pending-prompt';
import { MariaChatBody } from '@/app/projects/[projectId]/maria/_components/MariaChatBody';
import { buildOnboardingMariaPrompts } from '../../_lib/build-onboarding-maria-prompts';

interface MariaInsightStepProps {
  projectId: string;
  /** Despesa que a pessoa acabou de criar — origem dos chips contextuais. */
  createdExpense: { tipoDespesa: string; categoriaLabel: string };
  /** Pular por agora — avança sem falar com a Maria. */
  onSkip: () => void;
  /** Concluir a jornada (após conversar com a Maria) — avança pro "Pronto". */
  onDone: () => void;
}

/**
 * Passo pós-despesa (só aparece quando a 1ª despesa foi criada): oferece
 * chips de pergunta pré-formatada, derivados da CATEGORIA real da despesa.
 * Tocar num chip abre a conversa com a Maria AQUI MESMO (embutida via
 * `MariaChatBody`, o mesmo corpo da tela cheia) — sem navegar pra fora do
 * wizard, mantendo a régua de progresso visível. "Concluir" encerra o
 * onboarding e redireciona pro cockpit (fluxo já existente do wizard).
 */
export function MariaInsightStep({ projectId, createdExpense, onSkip, onDone }: MariaInsightStepProps) {
  const prompts = buildOnboardingMariaPrompts(createdExpense);
  const [chatOpen, setChatOpen] = useState(false);

  function askMaria(prompt: string) {
    setPendingMariaPrompt(prompt);
    setChatOpen(true);
  }

  if (chatOpen) {
    return (
      <section className="flex h-[70vh] min-h-0 flex-col rounded-[18px] border border-lifeone-hairline bg-lifeone-card p-4 shadow-lifeone-card">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-lifeone-ink text-white">
              <Sparkles className="h-4 w-4" />
            </div>
            <h2 className="text-[16px] font-bold text-lifeone-ink">Maria</h2>
          </div>
          <button
            type="button"
            onClick={onDone}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-xl bg-lifeone-blue px-3 text-[13px] font-semibold text-white"
          >
            <CheckCircle2 className="h-3.5 w-3.5" /> Concluir
          </button>
        </div>
        <MariaChatBody projectId={projectId} />
      </section>
    );
  }

  return (
    <section className="rounded-[18px] border border-lifeone-hairline bg-lifeone-card p-6 shadow-lifeone-card">
      <div className="flex items-center gap-2.5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-lifeone-ink text-white">
          <Sparkles className="h-4 w-4" />
        </div>
        <h2 className="text-[18px] font-bold text-lifeone-ink">Pergunte à Maria sobre esse gasto</h2>
      </div>
      <p className="mt-2 text-[13px] text-lifeone-ink-3">
        A Maria já sabe do seu mês. Toque numa pergunta e veja a resposta na hora.
      </p>

      <div className="mt-4 flex flex-col gap-2">
        {prompts.map((prompt) => (
          <button
            key={prompt}
            type="button"
            onClick={() => askMaria(prompt)}
            className="flex min-h-11 w-full items-center justify-between gap-2 rounded-[12px] border border-lifeone-hairline bg-lifeone-surface px-4 py-3 text-left text-[14px] font-medium text-lifeone-ink transition-colors hover:border-lifeone-blue hover:bg-lifeone-blue/5"
          >
            <span className="min-w-0">{prompt}</span>
            <ArrowRight className="h-4 w-4 shrink-0 text-lifeone-blue" />
          </button>
        ))}
      </div>

      <div className="mt-5">
        <button
          type="button"
          onClick={onSkip}
          className="flex min-h-11 w-full items-center justify-center gap-1.5 text-[13px] text-lifeone-ink-3 hover:text-lifeone-ink"
        >
          <SkipForward className="h-3.5 w-3.5" /> Pular por agora
        </button>
      </div>
    </section>
  );
}
