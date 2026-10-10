import { useCallback, useLayoutEffect, useRef } from 'react';

type Pending = { keys: string[]; fallback: string | null };

/**
 * Moves keyboard focus after a transition the USER asked for, when the control they used is about
 * to unmount (which would drop focus to <body>). A handler calls `request(keys, fallback?)`; once
 * a commit renders an element carrying `data-focus-key`, the first matching key receives focus and
 * the request is consumed. `fallback` is only used by `settle()`, which the owner of asynchronous
 * content calls once that content stopped loading (so a returning list can wait for its row).
 * Data refreshes never call `request`, so they cannot move focus.
 */
export function useIntentFocus<T extends HTMLElement = HTMLDivElement>() {
  const scope = useRef<T>(null);
  const pending = useRef<Pending | null>(null);

  const focusFirst = useCallback((keys: string[]) => {
    const root = scope.current;
    if (!root) return false;
    const targets = Array.from(root.querySelectorAll<HTMLElement>('[data-focus-key]'));
    for (const key of keys) {
      const target = targets.find((element) => element.dataset.focusKey === key);
      if (target) {
        target.focus();
        return true;
      }
    }
    return false;
  }, []);

  const request = useCallback((keys: string[], fallback: string | null = null) => {
    pending.current = { keys, fallback };
  }, []);

  const settle = useCallback(() => {
    const current = pending.current;
    if (!current) return;
    if (focusFirst(current.keys) || (current.fallback && focusFirst([current.fallback]))) pending.current = null;
  }, [focusFirst]);

  useLayoutEffect(() => {
    const current = pending.current;
    if (current && focusFirst(current.keys)) pending.current = null;
  });

  return { scope, request, settle };
}
