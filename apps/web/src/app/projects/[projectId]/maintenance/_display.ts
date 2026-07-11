import { formatCurrency, formatDateBR } from '@/lib/utils';

export interface MaintenanceLog {
  id: string;
  tipo: string;
  dataRealizada: string;
  dataProxima?: string;
  quilometragem?: number;
  custo?: number;
  fornecedor?: string;
  observacoes?: string;
}

export type MaintenanceProjectType = 'CASA' | 'CARRO';

export const HOUSE_TYPES = [
  { value: 'PINTURA', label: 'Pintura' },
  { value: 'IMPERMEABILIZACAO', label: 'Impermeabilização' },
  { value: 'DEDETIZACAO', label: 'Dedetização' },
  { value: 'LIMPEZA_CAIXA', label: 'Limpeza de Caixa d\u0027Água' },
  { value: 'REVISAO_ELETRICA', label: 'Revisão Elétrica' },
  { value: 'REVISAO_HIDRAULICA', label: 'Revisão Hidráulica' },
  { value: 'OUTRO', label: 'Outro' },
] as const;

export const CAR_TYPES = [
  { value: 'TROCA_OLEO', label: 'Troca de Óleo' },
  { value: 'FILTRO_AR', label: 'Filtro de Ar' },
  { value: 'FILTRO_OLEO', label: 'Filtro de Óleo' },
  { value: 'FILTRO_COMBUSTIVEL', label: 'Filtro de Combustível' },
  { value: 'PNEUS', label: 'Pneus' },
  { value: 'ALINHAMENTO', label: 'Alinhamento' },
  { value: 'BALANCEAMENTO', label: 'Balanceamento' },
  { value: 'REVISAO', label: 'Revisão Completa' },
  { value: 'FREIOS', label: 'Freios' },
  { value: 'CORREIA', label: 'Correia Dentada' },
  { value: 'OUTRO', label: 'Outro' },
] as const;

export function getMaintenanceTypes(projectType: MaintenanceProjectType) {
  return projectType === 'CARRO' ? CAR_TYPES : HOUSE_TYPES;
}

export function daysUntil(date: string) {
  const diff = Math.ceil(
    (new Date(date).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
  );
  if (diff < 0)
    return { text: `${Math.abs(diff)}d atrasado`, color: 'text-red-600' };
  if (diff <= 30) return { text: `em ${diff}d`, color: 'text-amber-600' };
  return { text: `em ${diff}d`, color: 'text-green-600' };
}

export function getMaintenanceDisplay(
  log: MaintenanceLog,
  projectType: MaintenanceProjectType,
) {
  const next = log.dataProxima ? daysUntil(log.dataProxima) : null;
  return {
    source: log,
    type:
      getMaintenanceTypes(projectType).find((item) => item.value === log.tipo)
        ?.label ?? log.tipo,
    completedDate: formatDateBR(log.dataRealizada),
    nextDate: log.dataProxima ? formatDateBR(log.dataProxima) : '—',
    nextText: next?.text,
    nextColor: next?.color ?? 'text-gray-500',
    mileage:
      log.quilometragem == null
        ? '—'
        : new Intl.NumberFormat('pt-BR').format(log.quilometragem),
    cost: log.custo ? formatCurrency(log.custo / 100) : '—',
    supplier: log.fornecedor ?? '—',
  };
}
