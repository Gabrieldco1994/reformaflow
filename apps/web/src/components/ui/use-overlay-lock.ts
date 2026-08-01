'use client';

import { useEffect } from 'react';

let openOverlays = 0;

/**
 * Trava o scroll do body e marca `data-overlay-open` enquanto QUALQUER overlay
 * de tela cheia estiver aberto (modal, sheet, overlay de voz).
 *
 * O contador é compartilhado de propósito: com dois overlays empilhados, o
 * efeito antigo — um por modal — destravava o scroll ao fechar o de cima,
 * mesmo com o de baixo ainda aberto.
 *
 * O atributo no body é o sinal que o painel da jornada usa para sair da frente
 * (ver `globals.css`): ele vive em z-[70], acima de qualquer modal, e sem isso
 * ficava flutuando sobre o backdrop escuro, tapando o formulário que a própria
 * jornada mandou preencher.
 */
export function useOverlayLock(open: boolean) {
  useEffect(() => {
    if (!open) return;
    openOverlays += 1;
    document.body.style.overflow = 'hidden';
    document.body.dataset.overlayOpen = 'true';
    return () => {
      openOverlays = Math.max(0, openOverlays - 1);
      if (openOverlays === 0) {
        document.body.style.overflow = '';
        delete document.body.dataset.overlayOpen;
      }
    };
  }, [open]);
}
