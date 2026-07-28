'use client';

import { useEffect } from 'react';

/**
 * Registra o service worker (`public/sw.js`), que cacheia o casco do app e
 * serve a tela de offline. Nada de dado financeiro passa por lá — ver o
 * comentário no topo do próprio `sw.js`.
 *
 * Só em produção, de propósito: service worker em desenvolvimento serve
 * arquivo velho e faz perder tempo depurando mudança que "não aplicou".
 * Como registros ficam gravados no navegador, o ramo de dev também REMOVE
 * qualquer SW que tenha sobrado de um build de produção aberto na mesma
 * origem (localhost) — senão ele continuaria interceptando o dev server.
 */
export function ServiceWorkerInit() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    if (process.env.NODE_ENV !== 'production') {
      navigator.serviceWorker.getRegistrations().then((regs) => {
        regs.forEach((reg) => void reg.unregister());
      });
      return;
    }

    // Depois do load para não disputar banda com o primeiro render.
    const register = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // Registro é melhoria progressiva: falhou, o app segue normal online.
      });
    };

    if (document.readyState === 'complete') register();
    else {
      window.addEventListener('load', register);
      return () => window.removeEventListener('load', register);
    }
  }, []);

  return null;
}
