'use client';

import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { Info } from 'lucide-react';

const TOOLTIP_WIDTH = 240;

/**
 * Botão de ajuda "ⓘ" com tooltip explicativo. Acessível: abre no hover, no foco
 * (teclado) e no toque/clique (mobile), e fecha com Escape. Usa `position: fixed`
 * calculada a partir do gatilho para NÃO ser cortado por cards com
 * `overflow-hidden`. Herda a cor do texto (`text-current`), então funciona tanto
 * em cards claros quanto escuros. O clique não propaga (não dispara ações do card).
 */
export function InfoHint({
  text,
  className,
  ariaLabel = 'Ajuda',
}: {
  text: string;
  className?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; below: boolean } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const id = useId();

  function place() {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = r.top < 140; // sem espaço acima → mostra abaixo
    let left = r.left + r.width / 2 - TOOLTIP_WIDTH / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - TOOLTIP_WIDTH - 8));
    const top = below ? r.bottom + 8 : r.top - 8;
    setPos({ top, left, below });
  }

  useEffect(() => {
    if (!open) return;
    place();
    const onMove = () => place();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span className={`relative inline-flex ${className ?? ''}`}>
      <button
        ref={btnRef}
        type="button"
        aria-label={ariaLabel}
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setOpen((v) => !v);
        }}
        className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full opacity-45 transition-opacity hover:opacity-100 focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-current/40"
      >
        <Info className="h-3.5 w-3.5" />
      </button>
      {open && pos && (
        <span
          id={id}
          role="tooltip"
          style={
            {
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              width: TOOLTIP_WIDTH,
              transform: pos.below ? undefined : 'translateY(-100%)',
            } as CSSProperties
          }
          className="pointer-events-none z-[100] rounded-lg bg-[#1C1C1E] px-3 py-2 text-[11px] font-normal normal-case leading-snug tracking-normal text-white shadow-lifeone-hover"
        >
          {text}
        </span>
      )}
    </span>
  );
}
