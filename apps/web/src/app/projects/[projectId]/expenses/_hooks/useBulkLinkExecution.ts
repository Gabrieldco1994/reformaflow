'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import type { RatearMixedPayload } from '../_lib/wizardPayload';

export type BulkLinkRowStatus = 'idle' | 'success' | 'error';

export interface BulkLinkExecutionRow {
  sourceId: string;
  projectId: string;
  payload: RatearMixedPayload;
}

export type BulkLinkExecutionRowWithStatus = BulkLinkExecutionRow & { status: BulkLinkRowStatus };

/**
 * Executa o `ratear-mixed` de cada linha do "Vincular em massa"
 * SEQUENCIALMENTE (uma por vez, aguardando terminar antes de iniciar a
 * próxima). Falha isolada: uma linha com erro não interrompe as demais nem
 * desfaz as já concluídas. Reexecutar `execute()` reenvia apenas as linhas
 * `idle`/`error` — linhas `success` são puladas.
 */
export function useBulkLinkExecution(rows: BulkLinkExecutionRow[]) {
  const [state, setState] = useState<BulkLinkExecutionRowWithStatus[]>(() =>
    rows.map((r) => ({ ...r, status: 'idle' as const })),
  );

  const execute = async () => {
    for (let i = 0; i < state.length; i++) {
      if (state[i].status === 'success') continue;
      const row = state[i];
      try {
        await api.post(`/projects/${row.projectId}/expenses/${row.sourceId}/ratear-mixed`, row.payload);
        setState((prev) => prev.map((r, idx) => (idx === i ? { ...r, status: 'success' } : r)));
      } catch {
        setState((prev) => prev.map((r, idx) => (idx === i ? { ...r, status: 'error' } : r)));
      }
    }
  };

  return { rows: state, execute };
}
