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
  // ponytail: status por id, assim `rows` prop pode mudar livremente sem resetar successes
  const [statuses, setStatuses] = useState<Record<string, BulkLinkRowStatus>>({});

  const execute = async () => {
    for (const row of rows) {
      if (statuses[row.sourceId] === 'success') continue;
      try {
        await api.post(`/projects/${row.projectId}/expenses/${row.sourceId}/ratear-mixed`, row.payload);
        setStatuses((prev) => ({ ...prev, [row.sourceId]: 'success' }));
      } catch {
        setStatuses((prev) => ({ ...prev, [row.sourceId]: 'error' }));
      }
    }
  };

  return {
    rows: rows.map((r) => ({ ...r, status: statuses[r.sourceId] ?? ('idle' as const) })),
    execute,
  };
}
