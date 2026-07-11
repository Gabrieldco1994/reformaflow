/**
 * Tokens de cor semântica (Fase A — Design System).
 *
 * Cada tone é uma intenção, não uma cor decorativa:
 * - `positive`: saldo positivo, meta atingida, ação aprovada
 * - `negative`: saldo negativo, meta estourada, erro ou alerta crítico
 * - `warning`: atenção necessária, mas reversível (fatura vencendo, limite próximo)
 * - `neutral`: gasto comum, transação neutra, estado padrão
 * - `accent`: destaque funcional, link, CTA (não semântica de bom/ruim)
 */

export type ColorTone = 'positive' | 'negative' | 'warning' | 'neutral' | 'accent';

export const COLOR_TONE_PALETTE: Record<ColorTone, {
  bg: string;
  bgLight: string;
  text: string;
  border: string;
  icon: string;
}> = {
  positive: {
    bg: '#1E924A',
    bgLight: '#E3F6EA',
    text: '#1E924A',
    border: '#BFE6CC',
    icon: '#1E924A',
  },
  negative: {
    bg: '#D92D20',
    bgLight: '#FCEBE9',
    text: '#D92D20',
    border: '#F2C6C1',
    icon: '#D92D20',
  },
  warning: {
    bg: '#B5803A',
    bgLight: '#FBEBDC',
    text: '#B5803A',
    border: '#EAD9C0',
    icon: '#B5803A',
  },
  neutral: {
    bg: '#201D19',
    bgLight: '#FBFAF7',
    text: '#201D19',
    border: '#EAE6DE',
    icon: '#201D19',
  },
  accent: {
    bg: '#0A6CF0',
    bgLight: '#E6EFFE',
    text: '#0A6CF0',
    border: '#CFE0FB',
    icon: '#0A6CF0',
  },
};

/** Retorna o tone baseado no sinal e na regra de negócio. */
export function getToneFromValue(cents: number): ColorTone {
  if (cents > 0) return 'positive';
  if (cents < 0) return 'negative';
  return 'neutral';
}
