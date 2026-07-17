import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ProjectType } from '@reformaflow/domain';
import { decodeExpenseQuery, encodeExpenseQuery, type ExpenseQueryState } from '../_lib/expense-query-state';

export function useExpenseQueryState({ projectId, projectType, hasRooms }: { projectId: string; projectType: ProjectType | string | undefined; hasRooms: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [storedViewMode, setStoredViewMode] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const options = useMemo(() => ({ projectType, hasRooms, storedViewMode }), [projectType, hasRooms, storedViewMode]);
  const state = useMemo(() => decodeExpenseQuery(new URLSearchParams(searchParams.toString()), options), [searchParams, options]);

  useEffect(() => {
    setStoredViewMode(window.localStorage.getItem(`expenses:viewMode:${projectId}`));
    setHydrated(true);
  }, [projectId]);
  useEffect(() => {
    if (hydrated) window.localStorage.setItem(`expenses:viewMode:${projectId}`, state.view);
  }, [hydrated, projectId, state.view]);

  const apply = useCallback((nextState: ExpenseQueryState) => {
    const next = encodeExpenseQuery(new URLSearchParams(searchParams.toString()), nextState, options);
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [options, pathname, router, searchParams]);
  const remove = useCallback((key: keyof ExpenseQueryState) => {
    apply({ ...state, [key]: key === 'view' ? 'category' : '' });
  }, [apply, state]);
  const clear = useCallback(() => apply({
    q: '', tipoDespesa: '', room: '', titulo: '', fornecedor: '', formaPagamento: '',
    status: '', view: 'category', period: '', rangeStart: '', rangeEnd: '', origin: '',
  }), [apply]);
  return { state, apply, remove, clear };
}
