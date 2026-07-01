export enum PendenciaStatus {
  PENDENTE = 'PENDENTE',
  ANDAMENTO = 'ANDAMENTO',
  PARADO = 'PARADO',
  CONCLUIDO = 'CONCLUIDO',
}

export const PENDENCIA_STATUS_LABELS: Record<PendenciaStatus, string> = {
  [PendenciaStatus.PENDENTE]: 'Pendente',
  [PendenciaStatus.ANDAMENTO]: 'Em andamento',
  [PendenciaStatus.PARADO]: 'Parado',
  [PendenciaStatus.CONCLUIDO]: 'Concluído',
};

export const PENDENCIA_STATUS_COLUMNS: PendenciaStatus[] = [
  PendenciaStatus.PENDENTE,
  PendenciaStatus.ANDAMENTO,
  PendenciaStatus.PARADO,
  PendenciaStatus.CONCLUIDO,
];
