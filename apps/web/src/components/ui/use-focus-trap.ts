import { useEffect, type RefObject } from 'react';

/**
 * Retém foco de teclado dentro de `containerRef` enquanto `active`. Ciclo
 * Tab/Shift+Tab (primeiro↔último focável). No ativar, foca o primeiro focável
 * (ou o próprio container) e guarda o elemento anterior; no desativar, devolve
 * o foco a ele.
 *
 * Limitação conhecida: quando o modal é aberto por um seletor que desmonta no
 * mesmo commit (pickers de "Para qual cartão/conta"), o elemento anterior já
 * era o <body> — a restauração cai no <body> e o browser reassume o tab order
 * normal da página. O contrato ("foco não fica preso no fundo") continua válido.
 */
export function useFocusTrap(active: boolean, containerRef: RefObject<HTMLElement>) {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusablesIn = () =>
      Array.from(
        container.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );

    const initial = focusablesIn();
    if (initial.length) initial[0].focus();
    else {
      container.tabIndex = -1;
      container.focus();
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Tab') return;
      const focusables = focusablesIn();
      if (!focusables.length) {
        event.preventDefault();
        container?.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const activeEl = document.activeElement;
      if (event.shiftKey && (activeEl === first || !container?.contains(activeEl))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (activeEl === last || !container?.contains(activeEl))) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    };
  }, [active, containerRef]);
}
