/**
 * Componente Delta — mostra variação com semântica de melhorou/piorou.
 *
 * Regra:
 * - Se a mudança é para MELHOR (positiva): verde, "melhorou 57%"
 * - Se a mudança é para PIOR (negativa): vermelho, "piorou 57%"
 * - Baseado em `isGood` para sobreescrever (ex.: custo baixo é bom, então delta negativa é verde)
 *
 * Fase A — Design System: unifica a narrativa de mudança em todo o app.
 */

export interface DeltaProps {
  /** Variação em valor absoluto ou percentual (ex.: 5700 cents ou 57). */
  value: number;
  /** Se o tipo é percentual (%) ou absoluto em cents. Padrão: "cents". */
  type?: 'cents' | 'percent';
  /** Se `true`, delta positiva (crescimento) é bom. Se `false`, queda é boa (custo reduzido). Padrão: true. */
  isGood?: boolean;
  /** Classe customizável de estilo. */
  className?: string;
}

export function Delta({
  value,
  type = 'cents',
  isGood = true,
  className = '',
}: DeltaProps) {
  const isBetter = (value > 0 && isGood) || (value < 0 && !isGood);
  const text = isBetter ? 'melhorou' : 'piorou';
  const colorClass = isBetter ? 'text-[#1E924A]' : 'text-[#D92D20]';
  const absValue = Math.abs(value);
  const displayValue = type === 'percent' ? absValue : Math.round(absValue / 100);

  return (
    <span className={`font-medium ${colorClass} ${className}`}>
      {text} {displayValue}{type === 'percent' ? '%' : ''}
    </span>
  );
}
