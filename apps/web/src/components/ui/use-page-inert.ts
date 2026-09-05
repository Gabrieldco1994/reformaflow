'use client';

import { useEffect } from 'react';

/**
 * #659 F3 — background isolation for a portaled dialog.
 *
 * While `active`, marks every direct child of `<body>` that is NOT `keep`
 * (the dialog's own portal container) with the `inert` attribute, so SR
 * browse-mode, Tab, and pointer/hit-testing cannot reach the page behind the
 * dialog. Restores on cleanup. Never touches an ancestor of the dialog — the
 * dialog is portaled to `<body>`, so its portal node is a sibling of the page.
 */
export function usePageInert(active: boolean, keep: HTMLElement | null) {
  useEffect(() => {
    if (!active || typeof document === 'undefined') return;
    const touched: Element[] = [];
    for (const child of Array.from(document.body.children)) {
      if (child === keep) continue;
      if (child.hasAttribute('inert')) continue;
      child.setAttribute('inert', '');
      child.setAttribute('data-page-inert', '');
      touched.push(child);
    }
    return () => {
      for (const el of touched) {
        el.removeAttribute('inert');
        el.removeAttribute('data-page-inert');
      }
    };
  }, [active, keep]);
}
