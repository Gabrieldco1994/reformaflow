/**
 * Progresso de uma manutenção agendada: fração do tempo decorrido entre a
 * última manutenção (dataRealizada) e a próxima prevista (dataProxima).
 * Puro — sem I/O, fácil de testar isoladamente do componente.
 */
export interface MaintenanceProgress {
  /** 0–100, quanto do intervalo entre a última e a próxima já se passou. */
  percentComplete: number;
  /** Dias até a próxima manutenção (negativo = atrasada). */
  daysUntil: number;
  isOverdue: boolean;
}

export function computeMaintenanceProgress(
  dataRealizada: string,
  dataProxima: string,
  today: Date,
): MaintenanceProgress {
  const start = new Date(dataRealizada).getTime();
  const end = new Date(dataProxima).getTime();
  const now = today.getTime();

  const daysUntil = Math.ceil((end - now) / (1000 * 60 * 60 * 24));
  const isOverdue = daysUntil < 0;

  const totalSpan = end - start;
  const elapsed = now - start;
  // Intervalo inválido/zero (dataProxima <= dataRealizada): trata como 100% —
  // já deveria ter sido feita.
  const percentComplete =
    totalSpan <= 0 ? 100 : Math.min(100, Math.max(0, Math.round((elapsed / totalSpan) * 100)));

  return { percentComplete, daysUntil, isOverdue };
}
