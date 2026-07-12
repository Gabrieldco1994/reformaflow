'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Menu "⋯" de ações de card mobile — Fase G Design System.
 *
 * Único dono: criado uma vez para `bills/RecurringBillsView` e reutilizado
 * (nunca recriado) por `maintenance`, `reminders`, `receipts`. Não se aplica
 * a tabelas desktop, só a cards mobile que hoje têm 2–4 botões inline.
 */
export interface CardAction {
  label: string;
  onClick: () => void;
  icon?: ReactNode;
  tone?: 'default' | 'danger';
}

export interface CardActionsMenuProps {
  actions: CardAction[];
  ariaLabel: string;
}

export function CardActionsMenu({ actions, ariaLabel }: CardActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative inline-block text-left">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full text-lifeone-ink-3 hover:bg-lifeone-hairline/40"
      >
        <span aria-hidden className="text-lg font-bold leading-none">⋯</span>
      </button>
      {open && (
        <div
          role="menu"
          aria-label={ariaLabel}
          className="absolute right-0 z-10 mt-1 min-w-[160px] rounded-xl border border-lifeone-hairline bg-lifeone-card py-1 shadow-lifeone-dialog"
        >
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              role="menuitem"
              onClick={() => {
                action.onClick();
                setOpen(false);
              }}
              className={`flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm font-medium ${
                action.tone === 'danger' ? 'text-red-500' : 'text-lifeone-ink'
              }`}
            >
              {action.icon}
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
