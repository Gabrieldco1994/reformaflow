/**
 * Cores por tipo de projeto (barra lateral + ícones)
 */

export type ProjectType = 'REFORMA' | 'COMPRA' | 'CASA' | 'CARRO' | 'PESSOAL' | 'PLANTAS';

/**
 * Cor da barra lateral (accent) nos KPIs do dashboard
 */
export const PROJECT_ACCENT_COLORS: Record<ProjectType, string> = {
  REFORMA: 'bg-orange-500',
  COMPRA: 'bg-pink-500',
  CASA: 'bg-teal-500',
  CARRO: 'bg-blue-500',
  PESSOAL: 'bg-purple-500',
  PLANTAS: 'bg-green-600',
};

/**
 * Cor de fundo + texto para badges/ícones
 */
export const PROJECT_BADGE_COLORS: Record<ProjectType, string> = {
  REFORMA: 'bg-orange-100 text-orange-700',
  COMPRA: 'bg-pink-100 text-pink-700',
  CASA: 'bg-teal-100 text-teal-700',
  CARRO: 'bg-blue-100 text-blue-700',
  PESSOAL: 'bg-purple-100 text-purple-700',
  PLANTAS: 'bg-green-100 text-green-700',
};

/**
 * Cor de preenchimento para barras de progresso
 */
export const PROJECT_PROGRESS_COLORS: Record<ProjectType, string> = {
  REFORMA: 'bg-orange-500',
  COMPRA: 'bg-pink-500',
  CASA: 'bg-teal-500',
  CARRO: 'bg-blue-500',
  PESSOAL: 'bg-purple-500',
  PLANTAS: 'bg-green-600',
};

/**
 * Retorna a cor accent para o tipo de projeto
 */
export function getProjectAccentColor(projectType: string): string {
  return PROJECT_ACCENT_COLORS[projectType as ProjectType] || 'bg-darc-velvet';
}

/**
 * Retorna a cor de badge para o tipo de projeto
 */
export function getProjectBadgeColor(projectType: string): string {
  return PROJECT_BADGE_COLORS[projectType as ProjectType] || 'bg-gray-100 text-gray-700';
}

/**
 * Retorna a cor de progresso para o tipo de projeto
 */
export function getProjectProgressColor(projectType: string): string {
  return PROJECT_PROGRESS_COLORS[projectType as ProjectType] || 'bg-darc-velvet';
}
