"use client";

import { useCallback, useId, useState } from "react";

/**
 * Dica ("tooltip") do rail lateral — U1, issue #450.
 *
 * POR QUE NÃO O `title` NATIVO: a dica nativa do navegador não vive no DOM.
 * Ela é pintada pelo navegador, então `getBoundingClientRect` não a alcança,
 * `elementFromPoint` não a acha e o Playwright não a vê. Com o rail recolhido,
 * a única coisa que ainda diria a palavra "Movimentações" ao usuário seria essa
 * dica — e se ela fosse a nativa, não haveria como PROVAR que foi entregue.
 * Daí ser elemento próprio, com `role="tooltip"` e `aria-describedby`.
 *
 * POR QUE `position: fixed` E NÃO `absolute`: a lista de módulos é um
 * contêiner com `overflow-y-auto` dentro de um rail de 64px com
 * `overflow-x: clip` — uma dica posicionada por `absolute` seria recortada nas
 * duas direções. `fixed` calculado a partir do retângulo do gatilho escapa do
 * recorte (mesma técnica já usada em `components/InfoHint.tsx`), porque nenhum
 * ancestral da casca cria bloco contentor (`transform`/`filter`/`contain`).
 */

export interface SidebarHintState {
  id: string;
  text: string;
  top: number;
  left: number;
}

/** Folga entre a borda direita do gatilho e a dica. */
const GAP_PX = 8;

/**
 * Texto da dica: `{Grupo} · {Item}`.
 *
 * Quando o grupo É o destino (o "Projetos" ancorado do cabeçalho), repetir
 * daria "Projetos · Projetos". Nesse caso o nome sozinho já é a informação
 * completa.
 */
export function navHintText(groupLabel: string, itemLabel: string): string {
  return groupLabel === itemLabel ? itemLabel : `${groupLabel} · ${itemLabel}`;
}

export function useSidebarNavHint() {
  const base = useId();
  const [hint, setHint] = useState<SidebarHintState | null>(null);

  const hintId = useCallback((key: string) => `${base}-nav-hint-${key}`, [base]);

  const showHint = useCallback(
    (key: string, text: string, trigger: HTMLElement | null) => {
      const rect = trigger?.getBoundingClientRect();
      setHint({
        id: hintId(key),
        text,
        // Centro vertical do gatilho; o elemento se puxa meio corpo para cima.
        top: rect ? rect.top + rect.height / 2 : 0,
        left: (rect?.right ?? 0) + GAP_PX,
      });
    },
    [hintId],
  );

  const hideHint = useCallback(() => setHint(null), []);

  /**
   * Props prontas para o gatilho. Mouse E teclado: cobrir só o hover deixaria
   * quem navega por Tab sem nunca ler o nome do grupo.
   */
  const hintProps = useCallback(
    (key: string, text: string) => ({
      "aria-describedby": hint?.id === hintId(key) ? hint.id : undefined,
      onMouseEnter: (event: { currentTarget: HTMLElement }) =>
        showHint(key, text, event.currentTarget),
      onMouseLeave: hideHint,
      onFocus: (event: { currentTarget: HTMLElement }) =>
        showHint(key, text, event.currentTarget),
      onBlur: hideHint,
    }),
    [hint, hintId, showHint, hideHint],
  );

  return { hint, hintProps };
}

export function SidebarNavHint({ hint }: { hint: SidebarHintState | null }) {
  if (!hint) return null;
  return (
    <span
      id={hint.id}
      role="tooltip"
      data-nav-hint="true"
      style={{ position: "fixed", top: hint.top, left: hint.left }}
      // `pointer-events-none`: a dica nunca pode roubar o hit-test do próprio
      // item que a abriu — senão o `elementFromPoint` do e2e (e o clique do
      // usuário) cairia nela.
      className="minimal-sidebar-hint pointer-events-none fixed z-[100] -translate-y-1/2 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[11px] font-medium leading-snug shadow-lifeone-hover"
    >
      {hint.text}
    </span>
  );
}
