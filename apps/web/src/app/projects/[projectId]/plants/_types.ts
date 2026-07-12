/**
 * PlantInsights API Response Types
 */

export interface PlantCuidados {
  rega: string;
  luz: string;
  poda: string;
  adubacao: string;
  solo: string;
}

export interface PlantSaude {
  status: string; // SAUDAVEL, ATENCAO, CRITICA
}

export interface PlantPet {
  risco: string; // SEGURO, CAUTELA, TOXICA, DESCONHECIDO
}

export interface ProblemaPossivel {
  nome: string;
  gravidade: string; // LEVE, MEDIA, GRAVE
  planoAcao: string[];
}

export interface PlantDiagnosis {
  cuidados: PlantCuidados;
  saude: PlantSaude;
  pet: PlantPet;
  problemasPossiveis: ProblemaPossivel[];
}

export interface PlantReminder {
  titulo: string;
  data: string; // ISO date string
  status: string; // PENDENTE, CONCLUIDO, CANCELADO
  prioridade: string; // BAIXA, MEDIA, ALTA, URGENTE
}

export interface PlantMaintenance {
  tipo: string;
  dataRealizada: string; // ISO date string
  custo: number; // in centavos
}

export interface PlantCuidadoAgendado {
  reminders?: PlantReminder[];
  maintenance?: PlantMaintenance[];
}

export interface PlantInsightsResponse {
  diagnosis: PlantDiagnosis | null;
  cuidadoAgendado: PlantCuidadoAgendado;
}
