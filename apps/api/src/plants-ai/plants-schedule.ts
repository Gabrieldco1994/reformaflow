import type { PlantDiagnosisResult } from './plants-ai.service';

type ReminderRecurrence = 'UNICA' | 'DIARIA' | 'SEMANAL' | 'MENSAL' | 'ANUAL';
type ReminderPriority = 'BAIXA' | 'MEDIA' | 'ALTA' | 'URGENTE';

export interface SuggestedReminderTask {
  titulo: string;
  descricao: string;
  data: Date;
  recorrencia: ReminderRecurrence;
  prioridade: ReminderPriority;
  plantId?: string;
}
export interface SuggestedMaintenanceTask {
  tipo: string;
  dataRealizada: Date;
  dataProxima: Date;
  observacoes: string;
  plantId?: string;
}

export interface PlantSchedulePlan {
  reminders: SuggestedReminderTask[];
  maintenance: SuggestedMaintenanceTask[];
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

export function buildPlantSchedule(
  diagnosis: PlantDiagnosisResult,
  plantId?: string,
  now = new Date(),
): PlantSchedulePlan {
  const plantName = diagnosis.especieProvavel.nomePopular || 'planta';
  const reminders: SuggestedReminderTask[] = [
    {
      titulo: `Regar ${plantName}`,
      descricao: diagnosis.cuidados.rega,
      data: addDays(now, 2),
      recorrencia: 'SEMANAL',
      prioridade: 'MEDIA',
      plantId,
    },
    {
      titulo: `Checar saúde de ${plantName}`,
      descricao: diagnosis.saude.sinais.join('; ') || 'Inspecionar folhas, caule e solo',
      data: addDays(now, 3),
      recorrencia: 'SEMANAL',
      prioridade: diagnosis.saude.status === 'SAUDAVEL' ? 'MEDIA' : 'ALTA',
      plantId,
    },
    {
      titulo: `Adubar ${plantName}`,
      descricao: diagnosis.cuidados.adubacao,
      data: addDays(now, 15),
      recorrencia: 'MENSAL',
      prioridade: 'MEDIA',
      plantId,
    },
  ];

  const maintenance: SuggestedMaintenanceTask[] = [];
  for (const problem of diagnosis.problemasPossiveis.slice(0, 3)) {
    const prioridade: ReminderPriority =
      problem.gravidade === 'ALTA'
        ? 'URGENTE'
        : problem.gravidade === 'MEDIA'
          ? 'ALTA'
          : 'MEDIA';
    const actionDate = addDays(now, 1);
    reminders.push({
      titulo: `Tratar possível ${problem.nome} em ${plantName}`,
      descricao: problem.planoAcao.join('; ') || problem.descricao,
      data: actionDate,
      recorrencia: 'UNICA',
      prioridade,
      plantId,
    });
    maintenance.push({
      tipo: `Tratamento: ${problem.nome}`,
      dataRealizada: now,
      dataProxima: actionDate,
      observacoes: problem.descricao,
      plantId,
    });
  }

  return { reminders, maintenance };
}
