import { Check } from 'lucide-react';
import { TypeIcon, typeAccent } from '@/app/projects/_components/type-accent';
import { OBJECTIVE_DETAILS, OBJECTIVE_TYPES, type ObjectiveType } from './objective-options';

interface ObjectiveSelectorProps {
  selected: ObjectiveType[];
  onChange: (selected: ObjectiveType[]) => void;
  disabled?: boolean;
  legend?: string;
  /**
   * Grade compacta de 2 colunas (chip: ícone + rótulo curto, sem descrição)
   * em vez dos cartões altos com descrição. Usar onde o seletor mora numa
   * coluna estreita e a altura é cara (ex.: /register, onde o seletor
   * empurrava o botão de submit pra baixo da dobra).
   */
  compact?: boolean;
}

export function ObjectiveSelector({
  selected,
  onChange,
  disabled = false,
  legend = 'Quais objetivos você quer acompanhar?',
  compact = false,
}: ObjectiveSelectorProps) {
  const selectedSet = new Set(selected);

  function toggle(type: ObjectiveType) {
    onChange(
      selectedSet.has(type)
        ? selected.filter((item) => item !== type)
        : [...selected, type],
    );
  }

  if (compact) {
    return (
      <fieldset disabled={disabled} className="min-w-0">
        <legend className="sr-only">{legend}</legend>
        {/* 1 coluna no mobile, 2 só no desktop: a 390px cada chip de uma
            grade 2x sobra ~110px de texto e "Organizar minha vida
            financeira" quebra em 3 linhas, deixando as linhas da grade com
            alturas desiguais. No desktop a coluna do form tem ~518px, aí
            2 colunas cabem em no máximo 2 linhas. */}
        <div className="mt-3 grid grid-cols-1 gap-2 lg:grid-cols-2" data-testid="objective-constellation">
          {OBJECTIVE_TYPES.map((type) => {
            const details = OBJECTIVE_DETAILS[type];
            const accent = typeAccent(type);
            const checked = selectedSet.has(type);
            const descriptionId = `objective-${type.toLowerCase()}-description`;
            return (
              <label
                key={type}
                className={`flex min-h-11 cursor-pointer items-center gap-2.5 rounded-[12px] border-2 bg-lifeone-card px-2.5 py-2 transition-[border-color,box-shadow] focus-within:ring-2 focus-within:ring-lifeone-blue/30 motion-reduce:transition-none ${
                  checked
                    ? 'border-lifeone-blue bg-lifeone-info shadow-lifeone-card'
                    : 'border-lifeone-hairline hover:border-lifeone-ink-4'
                } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
              >
                <input
                  type="checkbox"
                  name="projectTypes"
                  value={type}
                  checked={checked}
                  onChange={() => toggle(type)}
                  aria-describedby={descriptionId}
                  className="sr-only"
                />
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[10px]" style={{ backgroundColor: accent.fill }}>
                  <TypeIcon type={type} className="h-4 w-4" style={{ color: accent.color }} />
                </span>
                <span className="min-w-0 flex-1 text-[13px] font-semibold leading-snug text-lifeone-ink">{details.label}</span>
                <span id={descriptionId} className="sr-only">{details.description}</span>
                <span className="h-4 w-4 shrink-0">
                  {checked && <Check className="h-4 w-4 text-lifeone-blue" aria-hidden="true" />}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
    );
  }

  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="sr-only">{legend}</legend>
      <div className="relative mt-4 grid min-w-0 grid-cols-2 items-start gap-2.5 sm:gap-3" data-testid="objective-constellation">
        <svg className="pointer-events-none absolute inset-6 h-[calc(100%-3rem)] w-[calc(100%-3rem)] sm:inset-8 sm:h-[calc(100%-4rem)] sm:w-[calc(100%-4rem)]" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <path d="M10 12 L88 12 L12 50 L88 50 L12 88 L88 88" fill="none" stroke="#DAD5CC" strokeWidth="0.8" strokeDasharray="2 3" />
        </svg>
        {OBJECTIVE_TYPES.map((type) => {
          const details = OBJECTIVE_DETAILS[type];
          const accent = typeAccent(type);
          const checked = selectedSet.has(type);
          const descriptionId = `objective-${type.toLowerCase()}-description`;
          return (
            <label
              key={type}
              className={`relative z-10 flex min-h-[104px] cursor-pointer gap-2 rounded-[14px] border-2 bg-lifeone-card p-3 transition-[border-color,box-shadow,transform] motion-reduce:transition-none sm:min-h-[116px] sm:gap-3 sm:rounded-[16px] sm:p-4 ${
                checked
                  ? 'border-lifeone-blue shadow-lifeone-card'
                  : 'border-lifeone-hairline hover:border-lifeone-ink-4'
              } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
            >
              <input
                type="checkbox"
                name="projectTypes"
                value={type}
                checked={checked}
                onChange={() => toggle(type)}
                aria-describedby={descriptionId}
                className="mt-1 h-5 w-5 shrink-0 rounded border-lifeone-hairline text-lifeone-blue accent-[#0A6CF0]"
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-start justify-between gap-2">
                  <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] sm:h-10 sm:w-10 sm:rounded-[12px]" style={{ backgroundColor: accent.fill }}>
                    <TypeIcon type={type} className="h-4 w-4 sm:h-5 sm:w-5" style={{ color: accent.color }} />
                  </span>
                  {checked && <Check className="h-5 w-5 shrink-0 text-lifeone-blue" aria-hidden="true" />}
                </span>
                <span className="mt-1.5 block text-[13px] font-semibold leading-tight text-lifeone-ink sm:mt-2 sm:text-[14px]">{details.label}</span>
                <span id={descriptionId} className="sr-only text-[12px] leading-snug text-lifeone-ink-3 sm:not-sr-only sm:mt-1 sm:block">{details.description}</span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
