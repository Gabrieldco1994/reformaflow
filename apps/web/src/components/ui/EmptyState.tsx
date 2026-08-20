'use client';

import type { LucideIcon } from 'lucide-react';

interface EmptyStateAction {
  label: string;
  onClick: () => void;
  /**
   * Token `data-journey-action` do catálogo de jornadas. Quando o estado vazio
   * assume a CTA primária da tela (#490), o token vem junto com ela: o motor de
   * jornadas escuta o token via `closest('[data-journey-action]')`, então ele
   * precisa existir na CTA VIVA — senão a jornada de primeiro cadastro morre em
   * silêncio exatamente na tela em que ela deveria disparar.
   */
  journeyAction?: string;
}

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: EmptyStateAction;
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="rounded-2xl border border-darc-linen bg-white p-8 text-center shadow-darc-soft">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-orange-100 text-orange-600">
        <Icon className="h-6 w-6" />
      </div>
      <h2 className="mt-4 text-lg font-semibold text-darc-velvet">{title}</h2>
      {description && (
        <p className="mx-auto mt-2 max-w-md text-sm text-darc-velvet/50">{description}</p>
      )}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          data-journey-action={action.journeyAction}
          className="mt-5 inline-flex min-h-11 items-center justify-center rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white shadow-darc-soft transition-colors hover:bg-orange-600"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
