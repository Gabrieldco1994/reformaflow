'use client';

import { PlusCircle, Sparkles } from 'lucide-react';
import { Card } from './ui';
import { NovaDespesaLauncher } from '../../expenses/_components/NovaDespesaLauncher';
import { useCopilotStore } from '@/stores/copilot-store';

/**
 * Coluna direita do cockpit desktop (D1): atalho de lançamento (reusa o
 * `NovaDespesaLauncher` canônico e CTA da Maria no mesmo bloco.
 */
export function DesktopRail({
  projectId,
  projectType,
}: {
  projectId: string;
  projectType: string;
}) {
  return (
    <Card
      title={
        <>
          <Sparkles className="h-3.5 w-3.5" /> Ações rápidas
        </>
      }
      hint="lançar · maria"
    >
      <NovaDespesaLauncher
        projectId={projectId}
        projectType={projectType}
        trigger={(open) => (
          <button
            type="button"
            onClick={open}
            className="flex min-h-[40px] w-full items-center justify-center gap-1.5 rounded-xl bg-[var(--ck-accent)] px-3 py-2 text-sm font-semibold text-white transition hover:opacity-90"
          >
            <PlusCircle className="h-4 w-4" /> Lançar agora
          </button>
        )}
      />
      <p className="mt-2 text-[11px] text-[var(--ck-muted)]">
        Maria usa os mesmos números deste cockpit.
      </p>
      <button
        type="button"
        onClick={() => useCopilotStore.getState().setOpen(true)}
        className="mt-2 flex min-h-[40px] w-full items-center justify-center gap-2 rounded-xl bg-[var(--ck-text)] px-3 py-2 text-sm font-semibold text-[var(--ck-bg)] transition-opacity hover:opacity-90"
      >
        <Sparkles className="h-4 w-4" /> Conversar com a Maria
      </button>
    </Card>
  );
}
